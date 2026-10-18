import type pg from 'pg';
import type { Db } from '../../db/tx.js';
import { maybeOne, one, withTx } from '../../db/tx.js';
import { uuidv7 } from '../../lib/ids.js';
import type { Services } from '../../services.js';
import { raiseAlert } from '../alerts.js';
import { audit } from '../audit.js';
import type { Actor } from '../context.js';
import { activeConsent, flagSuspectedMinor, trackEvent } from '../crm.js';
import { enqueue, PRIORITY, RetryLaterError } from '../jobs-queue.js';
import { LlmError } from '../llm/gateway.js';
import { recordLlmUsage } from '../llm/usage.js';
import { hasEntitlement } from '../monetization/entitlements.js';
import {
  DEFAULT_CRISIS_MESSAGE,
  HUMAN_REQUEST_MESSAGE,
  MINOR_MESSAGE,
  SEVERITY,
  type InputSignal,
  checkOutbound,
  classifyInbound,
  cleanReply,
} from './guard.js';
import { activeMemories, extractAndStoreMemories } from './memory.js';
import { type HistoryItem, buildMessages } from './prompt.js';

export type ConversationMode = 'ai_auto' | 'ai_draft' | 'human' | 'paused';

export interface ConversationRow {
  id: string;
  workspace_id: string;
  influencer_id: string;
  channel_id: string;
  fan_id: string;
  external_chat_id: string;
  mode: ConversationMode;
  status: string;
  ai_disclosed_at: Date | null;
  last_disclosure_at: Date | null;
  last_inbound_at: Date | null;
  last_replied_inbound_at: Date | null;
  messages_since_disclosure: number;
  locale: string | null;
}

// -----------------------------------------------------------------------------
// Transport (per channel kind; Telegram registers itself)
// -----------------------------------------------------------------------------
export interface OutboundOptions {
  buttons?: { text: string; callback_data?: string; url?: string }[][];
}

export interface Transport {
  send(text: string, opts?: OutboundOptions): Promise<{ externalMessageId: string }>;
  typing?(): Promise<void>;
}

export type TransportFactory = (svc: Services, conv: ConversationRow) => Promise<Transport>;
const transports = new Map<string, TransportFactory>();

export function registerTransport(channelKind: string, f: TransportFactory): void {
  transports.set(channelKind, f);
}

async function transportFor(svc: Services, conv: ConversationRow): Promise<Transport> {
  const ch = await one<{ kind: string }>(svc.workerPool, 'SELECT kind FROM publishing.channels WHERE id = $1', [conv.channel_id]);
  const f = transports.get(ch.kind);
  if (!f) throw new Error(`no conversation transport for channel kind ${ch.kind}`);
  return f(svc, conv);
}

// -----------------------------------------------------------------------------
// Conversations and messages
// -----------------------------------------------------------------------------
export async function openConversation(
  db: Db | pg.Pool,
  c: { workspaceId: string; influencerId: string; channelId: string; fanId: string; externalChatId: string; locale?: string | null },
): Promise<ConversationRow> {
  const mode = await maybeOne<{ default_conversation_mode: ConversationMode }>(
    db,
    'SELECT default_conversation_mode FROM identity.persona_runtime_config WHERE influencer_id = $1',
    [c.influencerId],
  );
  await db.query(
    `INSERT INTO conversation.conversations (id, workspace_id, influencer_id, channel_id, fan_id, external_chat_id, mode, locale)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (channel_id, external_chat_id) DO NOTHING`,
    [uuidv7(), c.workspaceId, c.influencerId, c.channelId, c.fanId, c.externalChatId, mode?.default_conversation_mode ?? 'ai_draft', c.locale ?? null],
  );
  return one<ConversationRow>(db, 'SELECT * FROM conversation.conversations WHERE channel_id = $1 AND external_chat_id = $2', [c.channelId, c.externalChatId]);
}

async function insertMessage(
  db: Db | pg.Pool,
  conv: ConversationRow,
  m: {
    direction: 'inbound' | 'outbound';
    author: 'fan' | 'ai' | 'operator' | 'system';
    authorUserId?: string | null;
    kind: string;
    body: string | null;
    status: string;
    externalMessageId?: string | null;
    guard?: unknown;
    sentAt?: Date | null;
    originalBody?: string | null;
  },
): Promise<string> {
  const id = uuidv7();
  await db.query(
    `INSERT INTO conversation.messages (id, workspace_id, influencer_id, conversation_id, fan_id, direction, author_type, author_user_id,
       external_message_id, kind, body, status, guard_result, sent_at, original_body)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      id,
      conv.workspace_id,
      conv.influencer_id,
      conv.id,
      conv.fan_id,
      m.direction,
      m.author,
      m.authorUserId ?? null,
      m.externalMessageId ?? null,
      m.kind,
      m.body,
      m.status,
      m.guard ? JSON.stringify(m.guard) : null,
      m.sentAt ?? null,
      m.originalBody ?? null,
    ],
  );
  return id;
}

/** Stores an inbound message once (dedup by channel + platform message id). Returns null for duplicates. */
export async function recordInbound(db: Db | pg.Pool, conv: ConversationRow, m: { externalMessageId: string; text: string | null; kind: string }): Promise<string | null> {
  const id = uuidv7();
  const dedup = await db.query(
    `INSERT INTO conversation.message_external_ids (channel_id, external_message_id, message_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [conv.channel_id, `in:${m.externalMessageId}`, id],
  );
  if (!dedup.rowCount) return null;
  await db.query(
    `INSERT INTO conversation.messages (id, workspace_id, influencer_id, conversation_id, fan_id, direction, author_type, external_message_id, kind, body, status)
     VALUES ($1, $2, $3, $4, $5, 'inbound', 'fan', $6, $7, $8, 'received')`,
    [id, conv.workspace_id, conv.influencer_id, conv.id, conv.fan_id, m.externalMessageId, m.kind, m.text],
  );
  // A fan writing again reopens a closed or snoozed conversation (blocked stays blocked).
  await db.query(`UPDATE conversation.conversations SET last_inbound_at = now(), status = CASE WHEN status IN ('closed', 'snoozed') THEN 'open' ELSE status END WHERE id = $1`, [conv.id]);
  return id;
}

/** Sends a non-AI message (disclosure, service notices, crisis resources) and records it. */
export async function sendSystemMessage(svc: Services, conv: ConversationRow, text: string, kind: 'service' | 'disclosure' = 'service', opts: OutboundOptions = {}): Promise<string> {
  const t = await transportFor(svc, conv);
  const sent = await t.send(text, opts);
  const id = await insertMessage(svc.workerPool, conv, { direction: 'outbound', author: 'system', kind, body: text, status: 'sent', externalMessageId: sent.externalMessageId, sentAt: new Date() });
  await svc.workerPool.query(`UPDATE conversation.conversations SET last_outbound_at = now() WHERE id = $1`, [conv.id]);
  if (kind === 'disclosure') {
    await svc.workerPool.query(
      `UPDATE conversation.conversations SET ai_disclosed_at = coalesce(ai_disclosed_at, now()), last_disclosure_at = now(), messages_since_disclosure = 0 WHERE id = $1`,
      [conv.id],
    );
  }
  return id;
}

// -----------------------------------------------------------------------------
// Escalation
// -----------------------------------------------------------------------------
export async function escalate(
  db: Db | pg.Pool,
  conv: ConversationRow,
  e: { reason: string; severity: 'low' | 'medium' | 'high' | 'critical'; slaMinutes: number; messageId?: string | null; stopAi?: boolean },
): Promise<string> {
  const existing = await maybeOne<{ id: string }>(
    db,
    `SELECT id FROM conversation.escalations WHERE conversation_id = $1 AND reason = $2 AND status <> 'resolved'`,
    [conv.id, e.reason],
  );
  if (existing) return existing.id;
  const id = uuidv7();
  await db.query(
    `INSERT INTO conversation.escalations (id, workspace_id, influencer_id, conversation_id, message_id, reason, severity, sla_due_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(mins => $8))`,
    [id, conv.workspace_id, conv.influencer_id, conv.id, e.messageId ?? null, e.reason, e.severity, e.slaMinutes],
  );
  if (e.stopAi) await db.query(`UPDATE conversation.conversations SET mode = 'human' WHERE id = $1`, [conv.id]);
  if (e.severity === 'critical' || e.severity === 'high') {
    await raiseAlert(db, {
      workspaceId: conv.workspace_id,
      severity: e.severity === 'critical' ? 'critical' : 'warning',
      source: 'conversation',
      code: `ESCALATION_${e.reason.toUpperCase()}`,
      dedupKey: `escalation:${id}`,
      message: `Conversation needs a human (${e.reason}, ${e.severity})`,
      details: { conversation_id: conv.id, escalation_id: id },
    });
  }
  await audit(db as Db, {
    workspaceId: conv.workspace_id,
    influencerId: conv.influencer_id,
    actor: { type: 'system', id: 'conversation-guard' },
    action: 'conversation.escalated',
    subjectType: 'conversation',
    subjectId: conv.id,
    metadata: { escalation_id: id, reason: e.reason, severity: e.severity },
  });
  return id;
}

async function crisisMessage(db: Db | pg.Pool, workspaceId: string, locale: string | null): Promise<{ text: string; resource: string }> {
  const ws = await one<{ settings: { crisis_resources?: Record<string, string> } }>(db, 'SELECT settings FROM core.workspaces WHERE id = $1', [workspaceId]);
  const res = ws.settings.crisis_resources ?? {};
  const key = locale && res[locale] ? locale : locale && res[locale.slice(0, 2)] ? locale.slice(0, 2) : 'default';
  return { text: res[key] ?? DEFAULT_CRISIS_MESSAGE, resource: res[key] ? `workspace:${key}` : 'platform_default' };
}

// -----------------------------------------------------------------------------
// Inbound handling
// -----------------------------------------------------------------------------
/**
 * Handles one stored inbound text message: guards first (crisis, minors,
 * threats escalate to a human and stop the AI), then schedules a debounced AI
 * reply if the fan consented to AI processing.
 */
export async function handleInbound(svc: Services, conv: ConversationRow, messageId: string, text: string): Promise<{ signals: InputSignal[]; replyScheduled: boolean }> {
  const db = svc.workerPool;
  const signals = classifyInbound(text);
  if (signals.length) await db.query(`UPDATE conversation.messages SET guard_result = $2 WHERE id = $1`, [messageId, JSON.stringify({ input: signals })]);
  for (const s of signals) {
    const rule = SEVERITY[s];
    await escalate(db, conv, { reason: s, severity: rule.severity, slaMinutes: rule.slaMinutes, messageId, stopAi: rule.stopAi });
  }
  if (signals.includes('self_harm_risk')) {
    const crisis = await crisisMessage(db, conv.workspace_id, conv.locale);
    await sendSystemMessage(svc, conv, crisis.text);
    const ch = await one<{ kind: string }>(db, 'SELECT kind FROM publishing.channels WHERE id = $1', [conv.channel_id]);
    await db.query(
      `INSERT INTO conversation.crisis_referrals (workspace_id, influencer_id, channel_kind, locale, protocol_version, resource_shown) VALUES ($1, $2, $3, $4, 'v1', $5)`,
      [conv.workspace_id, conv.influencer_id, ch.kind, conv.locale, crisis.resource],
    );
    return { signals, replyScheduled: false };
  }
  if (signals.includes('minor_signal')) {
    await flagSuspectedMinor(db, conv.fan_id);
    await sendSystemMessage(svc, conv, MINOR_MESSAGE);
    return { signals, replyScheduled: false };
  }
  if (signals.includes('threat_or_illegal')) return { signals, replyScheduled: false };
  if (signals.includes('human_requested')) await sendSystemMessage(svc, conv, HUMAN_REQUEST_MESSAGE);
  const fresh = await one<ConversationRow>(db, 'SELECT * FROM conversation.conversations WHERE id = $1', [conv.id]);
  if (fresh.mode === 'human' || fresh.mode === 'paused' || fresh.status !== 'open') return { signals, replyScheduled: false };
  if (!(await activeConsent(db, conv.fan_id, conv.influencer_id, 'ai_processing'))) return { signals, replyScheduled: false };
  await enqueue(db, {
    workspaceId: conv.workspace_id,
    queue: 'conversation',
    name: 'conversation.reply',
    key: `reply:${conv.id}:${messageId}`,
    payload: { conversation_id: conv.id, trigger_message_id: messageId },
    priority: PRIORITY.conversation,
    runAt: new Date(Date.now() + svc.config.conversation.replyDebounceMs),
    maxAttempts: 4,
  });
  return { signals, replyScheduled: true };
}

// -----------------------------------------------------------------------------
// AI reply pipeline
// -----------------------------------------------------------------------------
function todayIn(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

async function killSwitchOn(db: Db | pg.Pool, conv: ConversationRow): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM core.feature_flags WHERE key = 'kill_switch.conversations' AND value = 'true'::jsonb
        AND (workspace_id IS NULL OR workspace_id = $1) AND (influencer_id IS NULL OR influencer_id = $2) LIMIT 1`,
    [conv.workspace_id, conv.influencer_id],
  );
  return rows.length > 0;
}

type Allowance = { source: 'daily' | 'credits'; limit: number } | null;

async function checkAllowance(db: Db | pg.Pool, conv: ConversationRow, tz: string, freeLimit: number, premiumLimit: number): Promise<Allowance> {
  const premium = await hasEntitlement(db, conv.fan_id, 'bot_premium_tier', conv.influencer_id);
  const limit = premium ? premiumLimit : freeLimit;
  const day = todayIn(tz);
  await db.query(
    `INSERT INTO monetization.daily_allowances (workspace_id, fan_id, influencer_id, day, used, daily_limit) VALUES ($1, $2, $3, $4, 0, $5)
     ON CONFLICT (fan_id, influencer_id, day) DO UPDATE SET daily_limit = greatest(monetization.daily_allowances.daily_limit, EXCLUDED.daily_limit)`,
    [conv.workspace_id, conv.fan_id, conv.influencer_id, day, limit],
  );
  const row = await one<{ used: number; daily_limit: number }>(
    db,
    'SELECT used, daily_limit FROM monetization.daily_allowances WHERE fan_id = $1 AND influencer_id = $2 AND day = $3',
    [conv.fan_id, conv.influencer_id, day],
  );
  if (row.used < row.daily_limit) return { source: 'daily', limit: row.daily_limit };
  const credits = await maybeOne<{ balance: number }>(db, 'SELECT balance FROM monetization.credit_balances WHERE fan_id = $1 AND influencer_id = $2', [conv.fan_id, conv.influencer_id]);
  return credits && credits.balance > 0 ? { source: 'credits', limit: row.daily_limit } : null;
}

async function consumeAllowance(db: Db, conv: ConversationRow, tz: string, allowance: NonNullable<Allowance>, messageId: string): Promise<void> {
  if (allowance.source === 'daily') {
    await db.query(
      `UPDATE monetization.daily_allowances SET used = used + 1 WHERE fan_id = $1 AND influencer_id = $2 AND day = $3 AND used < daily_limit`,
      [conv.fan_id, conv.influencer_id, todayIn(tz)],
    );
    return;
  }
  const bal = await maybeOne<{ balance: number }>(
    db,
    `UPDATE monetization.credit_balances SET balance = balance - 1, version = version + 1 WHERE fan_id = $1 AND influencer_id = $2 AND balance > 0 RETURNING balance`,
    [conv.fan_id, conv.influencer_id],
  );
  if (bal) {
    await db.query(
      `INSERT INTO monetization.credit_ledger (workspace_id, fan_id, influencer_id, delta, balance_after, reason, ref_type, ref_id, idempotency_key)
       VALUES ($1, $2, $3, -1, $4, 'consumption', 'message', $5, $6) ON CONFLICT (idempotency_key) DO NOTHING`,
      [conv.workspace_id, conv.fan_id, conv.influencer_id, bal.balance, messageId, `consume:${messageId}`],
    );
  }
}

interface ReplyContext {
  influencer: { display_name: string; ai_disclosure_short: string; ai_disclosure_long: string; timezone: string; autonomy_paused: boolean; active_persona_version_id: string | null; status: string };
  persona: { personality: Record<string, unknown>; writing_style: Record<string, unknown>; biography: Record<string, unknown>; conversation_rules: Record<string, unknown> } | null;
  runtime: { free_replies_per_day: number; premium_replies_per_day: number; languages: string[]; redisclosure_every_messages: number; redisclosure_every_hours: number; memory_enabled: boolean; paused: boolean };
  fan: { display_name: string | null; primary_language: string | null; status: string; age_status: string };
}

async function loadReplyContext(db: Db | pg.Pool, conv: ConversationRow): Promise<ReplyContext> {
  const influencer = await one<ReplyContext['influencer']>(
    db,
    'SELECT display_name, ai_disclosure_short, ai_disclosure_long, timezone, autonomy_paused, active_persona_version_id, status FROM identity.influencers WHERE id = $1',
    [conv.influencer_id],
  );
  const persona = influencer.active_persona_version_id
    ? await one<NonNullable<ReplyContext['persona']>>(db, 'SELECT personality, writing_style, biography, conversation_rules FROM identity.persona_versions WHERE id = $1', [
        influencer.active_persona_version_id,
      ])
    : null;
  const runtime = await one<ReplyContext['runtime']>(
    db,
    `SELECT free_replies_per_day, premium_replies_per_day, languages, redisclosure_every_messages, redisclosure_every_hours, memory_enabled, paused
       FROM identity.persona_runtime_config WHERE influencer_id = $1`,
    [conv.influencer_id],
  );
  const fan = await one<ReplyContext['fan']>(db, 'SELECT display_name, primary_language, status, age_status FROM crm.fans WHERE id = $1', [conv.fan_id]);
  return { influencer, persona, runtime, fan };
}

/** The `conversation.reply` job: one AI reply covering every unanswered inbound message. */
export async function generateReply(svc: Services, conversationId: string): Promise<Record<string, unknown>> {
  const db = svc.workerPool;
  // Serialise replies per conversation across workers.
  const lockClient = await db.connect();
  try {
    const lock = await lockClient.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtext('golden.reply:' || $1)) AS ok`, [conversationId]);
    if (!lock.rows[0]?.ok) throw new RetryLaterError('reply already in progress for this conversation', 2000);
    try {
      return await generateReplyLocked(svc, conversationId);
    } finally {
      await lockClient.query(`SELECT pg_advisory_unlock(hashtext('golden.reply:' || $1))`, [conversationId]);
    }
  } finally {
    lockClient.release();
  }
}

async function generateReplyLocked(svc: Services, conversationId: string): Promise<Record<string, unknown>> {
  const db = svc.workerPool;
  const conv = await one<ConversationRow>(db, 'SELECT * FROM conversation.conversations WHERE id = $1', [conversationId]);
  const pending = await db.query<{ id: string; body: string | null; created_at: Date }>(
    `SELECT id, body, created_at FROM conversation.messages
      WHERE conversation_id = $1 AND direction = 'inbound' AND status = 'received' AND ($2::timestamptz IS NULL OR created_at > $2)
      ORDER BY created_at`,
    [conv.id, conv.last_replied_inbound_at],
  );
  if (pending.rows.length === 0) return { skipped: 'nothing_unanswered' };
  if (conv.mode === 'human' || conv.mode === 'paused' || conv.status !== 'open') return { skipped: `mode_${conv.mode}` };
  const ctx = await loadReplyContext(db, conv);
  if (ctx.fan.status !== 'active' || ['suspected_minor', 'confirmed_minor'].includes(ctx.fan.age_status)) return { skipped: 'fan_restricted' };
  if (!(await activeConsent(db, conv.fan_id, conv.influencer_id, 'ai_processing'))) return { skipped: 'no_ai_consent' };
  if (!ctx.persona || ctx.influencer.status === 'archived' || ctx.runtime.paused || (await killSwitchOn(db, conv))) return { skipped: 'ai_disabled' };
  if (!svc.llm.enabled) return { skipped: 'llm_not_configured' };

  const allowance = await checkAllowance(db, conv, ctx.influencer.timezone, ctx.runtime.free_replies_per_day, ctx.runtime.premium_replies_per_day);
  const lastPending = pending.rows.at(-1)!;
  if (!allowance) {
    await markAnswered(db, conv, lastPending.created_at);
    await sendSystemMessage(svc, conv, "You've reached today's message limit. I'll be happy to chat again tomorrow, or see /vip for more.");
    await trackEvent(db, { workspaceId: conv.workspace_id, influencerId: conv.influencer_id, fanId: conv.fan_id, name: 'allowance_exhausted', source: 'conversation' });
    return { skipped: 'allowance_exhausted' };
  }

  // Disclosure before the first AI message, and periodic re-disclosure.
  const hoursSince = conv.last_disclosure_at ? (Date.now() - conv.last_disclosure_at.getTime()) / 3_600_000 : Number.POSITIVE_INFINITY;
  if (!conv.ai_disclosed_at || conv.messages_since_disclosure >= ctx.runtime.redisclosure_every_messages || hoursSince >= ctx.runtime.redisclosure_every_hours) {
    await sendSystemMessage(svc, conv, conv.ai_disclosed_at ? `Reminder: ${ctx.influencer.ai_disclosure_short}. Replies here are automated.` : ctx.influencer.ai_disclosure_long, 'disclosure');
  }

  const historyRows = await db.query<{ author_type: HistoryItem['author']; body: string | null }>(
    `SELECT author_type, body FROM conversation.messages
      WHERE conversation_id = $1 AND status IN ('received', 'sent') AND kind IN ('text') AND body IS NOT NULL
      ORDER BY created_at DESC LIMIT $2`,
    [conv.id, svc.config.llm.contextMessages],
  );
  const history = historyRows.rows.reverse().map((r) => ({ author: r.author_type, body: r.body ?? '' }));
  const memoryConsent = ctx.runtime.memory_enabled ? await activeConsent(db, conv.fan_id, conv.influencer_id, 'memory_personalization') : null;
  const memories = memoryConsent ? await activeMemories(db, conv.influencer_id, conv.fan_id) : [];
  const summary = await maybeOne<{ summary: string }>(db, 'SELECT summary FROM conversation.conversation_summaries WHERE conversation_id = $1 ORDER BY covers_until DESC LIMIT 1', [conv.id]);
  const canon = await db.query<{ statement: string }>(
    `SELECT statement FROM identity.canon_facts WHERE influencer_id = $1 AND status = 'active' AND visibility IN ('public', 'premium') ORDER BY created_at LIMIT 40`,
    [conv.influencer_id],
  );
  const messages = buildMessages(
    {
      displayName: ctx.influencer.display_name,
      disclosureShort: ctx.influencer.ai_disclosure_short,
      disclosureLong: ctx.influencer.ai_disclosure_long,
      languages: ctx.runtime.languages,
      personality: ctx.persona.personality,
      writingStyle: ctx.persona.writing_style,
      biography: ctx.persona.biography,
      conversationRules: ctx.persona.conversation_rules,
      canonFacts: canon.rows.map((c) => c.statement),
    },
    { displayName: ctx.fan.display_name, language: ctx.fan.primary_language ?? conv.locale, memories, summary: summary?.summary ?? null },
    history,
  );

  const transport = await transportFor(svc, conv);
  await transport.typing?.().catch(() => undefined);
  let reply = '';
  let violations: string[] = [];
  let attempts = 0;
  for (; attempts < 2; attempts++) {
    let result;
    try {
      result = await svc.llm.chat({
        purpose: 'conversation.reply',
        priority: 'interactive',
        messages:
          attempts === 0
            ? messages
            : [...messages, { role: 'assistant', content: reply }, { role: 'user', content: `(system) Your previous reply broke platform rules (${violations.join(', ')}). Write a different short reply that follows every platform rule.` }],
      });
    } catch (err) {
      if (err instanceof LlmError && err.retryable) throw err; // job retries with backoff
      throw err;
    }
    await recordLlmUsage(db, { workspaceId: conv.workspace_id, influencerId: conv.influencer_id, operation: 'conversation.reply', result, conversationId: conv.id });
    reply = cleanReply(result.text, ctx.influencer.display_name);
    violations = checkOutbound(reply);
    if (violations.length === 0) break;
  }
  if (violations.length) {
    await markAnswered(db, conv, lastPending.created_at);
    await insertMessage(db, conv, { direction: 'outbound', author: 'ai', kind: 'text', body: reply, status: 'suppressed', guard: { output: violations } });
    await escalate(db, conv, { reason: 'guard_failure', severity: 'medium', slaMinutes: 240, messageId: lastPending.id });
    return { suppressed: violations };
  }

  const autonomyBlocked = ctx.influencer.autonomy_paused;
  const draft = conv.mode === 'ai_draft' || autonomyBlocked;
  return withTx(db, async (tx) => {
    let externalId: string | null = null;
    if (!draft) externalId = (await transport.send(reply)).externalMessageId;
    const msgId = await insertMessage(tx, conv, {
      direction: 'outbound',
      author: 'ai',
      kind: 'text',
      body: reply,
      status: draft ? 'drafted' : 'sent',
      externalMessageId: externalId,
      sentAt: draft ? null : new Date(),
      guard: { output: [], regenerated: attempts > 0 },
    });
    await consumeAllowance(tx, conv, ctx.influencer.timezone, allowance, msgId);
    await tx.query(
      `UPDATE conversation.conversations SET last_replied_inbound_at = $2, messages_since_disclosure = messages_since_disclosure + 1,
              last_outbound_at = CASE WHEN $3 THEN last_outbound_at ELSE now() END WHERE id = $1`,
      [conv.id, lastPending.created_at, draft],
    );
    if (memoryConsent) {
      await enqueue(tx, {
        workspaceId: conv.workspace_id,
        queue: 'background',
        name: 'conversation.extract_memory',
        key: `memory:${conv.id}:${lastPending.id}`,
        payload: { conversation_id: conv.id, message_ids: pending.rows.map((p) => p.id), consent_id: memoryConsent.id },
        priority: PRIORITY.default,
      });
    }
    return { message_id: msgId, status: draft ? 'drafted' : 'sent', allowance: allowance.source };
  });
}

async function markAnswered(db: Db | pg.Pool, conv: ConversationRow, upTo: Date): Promise<void> {
  await db.query('UPDATE conversation.conversations SET last_replied_inbound_at = $2 WHERE id = $1', [conv.id, upTo]);
}

export async function memoryJob(svc: Services, p: { conversation_id: string; message_ids: string[]; consent_id: string }): Promise<unknown> {
  const db = svc.workerPool;
  const conv = await one<ConversationRow>(db, 'SELECT * FROM conversation.conversations WHERE id = $1', [p.conversation_id]);
  const stillConsented = await activeConsent(db, conv.fan_id, conv.influencer_id, 'memory_personalization');
  if (!stillConsented) return { skipped: 'consent_withdrawn' };
  const msgs = await db.query<{ id: string; body: string }>(
    `SELECT id, body FROM conversation.messages WHERE id = ANY($1::uuid[]) AND body IS NOT NULL AND status <> 'deleted' ORDER BY created_at`,
    [p.message_ids],
  );
  return extractAndStoreMemories(db, svc.llm, {
    workspaceId: conv.workspace_id,
    influencerId: conv.influencer_id,
    fanId: conv.fan_id,
    conversationId: conv.id,
    consentId: stillConsented.id,
    fanMessages: msgs.rows,
  });
}

// -----------------------------------------------------------------------------
// Operator actions (draft review, manual messages)
// -----------------------------------------------------------------------------
export async function approveDraft(svc: Services, actor: Actor & { type: 'user' }, conversationId: string, messageId: string, editedBody: string | null): Promise<{ status: string }> {
  const db = svc.workerPool;
  const conv = await one<ConversationRow>(db, 'SELECT * FROM conversation.conversations WHERE id = $1', [conversationId]);
  const msg = await maybeOne<{ body: string; status: string }>(
    db,
    `SELECT body, status FROM conversation.messages WHERE id = $1 AND conversation_id = $2 AND author_type = 'ai'`,
    [messageId, conversationId],
  );
  if (!msg || msg.status !== 'drafted') throw new Error('DRAFT_NOT_FOUND');
  const body = editedBody?.trim() || msg.body;
  const violations = checkOutbound(body);
  if (violations.length) throw new Error(`GUARD_VIOLATION:${violations.join(',')}`);
  const sent = await (await transportFor(svc, conv)).send(body);
  await db.query(
    `UPDATE conversation.messages SET status = 'sent', sent_at = now(), external_message_id = $3, reviewed_by = $4, reviewed_at = now(),
            original_body = CASE WHEN $5 THEN body ELSE NULL END, body = $6
      WHERE id = $1 AND conversation_id = $2`,
    [messageId, conversationId, sent.externalMessageId, actor.id, body !== msg.body, body],
  );
  await db.query('UPDATE conversation.conversations SET last_outbound_at = now() WHERE id = $1', [conversationId]);
  await audit(db as unknown as Db, {
    workspaceId: conv.workspace_id,
    influencerId: conv.influencer_id,
    actor,
    action: body !== msg.body ? 'conversation.draft_edited_sent' : 'conversation.draft_approved',
    subjectType: 'message',
    subjectId: messageId,
  });
  return { status: 'sent' };
}

export async function rejectDraft(svc: Services, actor: Actor & { type: 'user' }, conversationId: string, messageId: string): Promise<void> {
  const db = svc.workerPool;
  const res = await db.query(
    `UPDATE conversation.messages SET status = 'suppressed', reviewed_by = $3, reviewed_at = now() WHERE id = $1 AND conversation_id = $2 AND status = 'drafted'`,
    [messageId, conversationId, actor.id],
  );
  if (!res.rowCount) throw new Error('DRAFT_NOT_FOUND');
  const conv = await one<ConversationRow>(db, 'SELECT * FROM conversation.conversations WHERE id = $1', [conversationId]);
  await audit(db as unknown as Db, { workspaceId: conv.workspace_id, influencerId: conv.influencer_id, actor, action: 'conversation.draft_rejected', subjectType: 'message', subjectId: messageId });
}

export async function operatorSend(svc: Services, actor: Actor & { type: 'user' }, conversationId: string, body: string): Promise<string> {
  const db = svc.workerPool;
  const conv = await one<ConversationRow>(db, 'SELECT * FROM conversation.conversations WHERE id = $1', [conversationId]);
  const violations = checkOutbound(body).filter((v) => v !== 'claims_human');
  if (violations.length) throw new Error(`GUARD_VIOLATION:${violations.join(',')}`);
  const sent = await (await transportFor(svc, conv)).send(body);
  const id = await insertMessage(db, conv, { direction: 'outbound', author: 'operator', authorUserId: actor.id, kind: 'text', body, status: 'sent', externalMessageId: sent.externalMessageId, sentAt: new Date() });
  await db.query(
    `UPDATE conversation.conversations SET last_outbound_at = now(),
            last_replied_inbound_at = greatest(coalesce(last_replied_inbound_at, '-infinity'), coalesce(last_inbound_at, '-infinity')) WHERE id = $1`,
    [conversationId],
  );
  await audit(db as unknown as Db, { workspaceId: conv.workspace_id, influencerId: conv.influencer_id, actor, action: 'conversation.operator_message', subjectType: 'message', subjectId: id });
  return id;
}
