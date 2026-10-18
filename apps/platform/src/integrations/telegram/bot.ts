import type pg from 'pg';
import type { Db } from '../../db/tx.js';
import { maybeOne, one, withTx } from '../../db/tx.js';
import { decryptSecret } from '../../lib/crypto.js';
import { unprocessable } from '../../lib/errors.js';
import { raiseAlert, resolveAlert } from '../../modules/alerts.js';
import { auditCtx } from '../../modules/audit.js';
import { type Ctx, requirePermission } from '../../modules/context.js';
import { MINOR_MESSAGE } from '../../modules/conversation/guard.js';
import { activeMemories, forgetAll } from '../../modules/conversation/memory.js';
import {
  type ConversationRow,
  escalate,
  handleInbound,
  openConversation,
  recordInbound,
  registerTransport,
  sendSystemMessage,
} from '../../modules/conversation/engine.js';
import { type FanRow, activeConsent, eraseFan, grantConsent, latestPolicy, trackEvent, upsertTelegramFan, withdrawConsent } from '../../modules/crm.js';
import { getInfluencer } from '../../modules/identity.js';
import { createChannel, createIntegrationAccount, credentialAad } from '../../modules/integrations.js';
import { enqueue, PermanentJobError, PRIORITY } from '../../modules/jobs-queue.js';
import type { Services } from '../../services.js';
import { type InlineButton, TelegramApiError, TelegramClient, type TgMessage, type TgUpdate, type TgUser } from './client.js';

/**
 * Telegram bot runtime: one bot per influencer, long polling (no inbound
 * port on the workstation), persist-then-advance ingestion, and the update
 * router for the private chat (consent, commands, conversation). Payment and
 * channel-membership updates are routed to handlers registered by the
 * monetization module.
 */

// -----------------------------------------------------------------------------
// Bots and clients
// -----------------------------------------------------------------------------
export interface BotRow {
  account_id: string;
  workspace_id: string;
  influencer_id: string;
  bot_id: string;
  bot_username: string | null;
  account_status: string;
  credential_version: number;
  channel_id: string;
}

const BOT_SELECT = `
  SELECT a.id AS account_id, a.workspace_id, a.influencer_id, a.external_account_id AS bot_id, a.bot_username,
         a.status AS account_status, a.credential_version, c.id AS channel_id
    FROM core.integration_accounts a
    JOIN publishing.channels c ON c.integration_account_id = a.id AND c.kind = 'telegram_bot'
   WHERE a.provider = 'telegram_bot'`;

export async function activeBots(db: Db | pg.Pool): Promise<BotRow[]> {
  const { rows } = await db.query<BotRow>(`${BOT_SELECT} AND a.status = 'active' AND c.status = 'active' ORDER BY a.created_at`);
  return rows;
}

export async function loadBot(db: Db | pg.Pool, accountId: string): Promise<BotRow | null> {
  return maybeOne<BotRow>(db, `${BOT_SELECT} AND a.id = $1`, [accountId]);
}

const clients = new Map<string, TelegramClient>();

/** Decrypts the account's credential (bot token) once per credential version and process. */
export async function clientForAccount(svc: Services, accountId: string): Promise<TelegramClient> {
  const row = await one<{
    workspace_id: string;
    provider: string;
    external_account_id: string;
    credential_version: number;
    credential_ciphertext: Buffer;
    credential_nonce: Buffer;
    data_key_ciphertext: Buffer;
    wrapping_key_id: string;
  }>(
    svc.workerPool,
    `SELECT workspace_id, provider, external_account_id, credential_version, credential_ciphertext, credential_nonce, data_key_ciphertext, wrapping_key_id
       FROM core.integration_accounts WHERE id = $1`,
    [accountId],
  );
  const key = `${svc.config.telegram.apiBaseUrl}|${accountId}|${row.credential_version}`;
  const cached = clients.get(key);
  if (cached) return cached;
  const token = decryptSecret(
    svc.config.masterKeys,
    { ciphertext: row.credential_ciphertext, nonce: row.credential_nonce, dataKeyCiphertext: row.data_key_ciphertext, wrappingKeyId: row.wrapping_key_id },
    credentialAad(row.workspace_id, row.provider, row.external_account_id),
  );
  const client = new TelegramClient(svc.config.telegram.apiBaseUrl, token);
  clients.set(key, client);
  return client;
}

// -----------------------------------------------------------------------------
// Extension points (monetization registers payment and membership handlers)
// -----------------------------------------------------------------------------
export interface UpdateContext {
  svc: Services;
  bot: BotRow;
  client: TelegramClient;
  update: TgUpdate;
}

export interface ChatContext extends UpdateContext {
  user: TgUser;
  fan: FanRow;
  conv: ConversationRow;
  /** Sends a recorded service message into the private chat. */
  reply(text: string, buttons?: InlineButton[][]): Promise<void>;
}

type PreCheckoutHandler = (u: UpdateContext, q: NonNullable<TgUpdate['pre_checkout_query']>) => Promise<{ ok: boolean; error?: string }>;
type UpdateHandler = (u: UpdateContext) => Promise<string | void>;
type CommandHandler = (c: ChatContext, args: string) => Promise<void>;
type CallbackHandler = (c: ChatContext, data: string) => Promise<void>;

const hooks = {
  preCheckout: null as PreCheckoutHandler | null,
  updates: new Map<'successful_payment' | 'refunded_payment' | 'chat_join_request' | 'chat_member', UpdateHandler>(),
  commands: new Map<string, { description: string; handler: CommandHandler }>(),
  callbacks: new Map<string, CallbackHandler>(),
};

export const telegramHooks = {
  onPreCheckout(h: PreCheckoutHandler): void {
    hooks.preCheckout = h;
  },
  onUpdate(kind: 'successful_payment' | 'refunded_payment' | 'chat_join_request' | 'chat_member', h: UpdateHandler): void {
    hooks.updates.set(kind, h);
  },
  command(name: string, description: string, handler: CommandHandler): void {
    hooks.commands.set(name, { description, handler });
  },
  /** Handles callback data `<prefix>:<rest>`. */
  callback(prefix: string, handler: CallbackHandler): void {
    hooks.callbacks.set(prefix, handler);
  },
};

// -----------------------------------------------------------------------------
// Bot profile: commands and the AI disclosure shown before /start
// -----------------------------------------------------------------------------
const CORE_COMMANDS: { command: string; description: string }[] = [
  { command: 'start', description: 'Start chatting (consent and AI disclosure)' },
  { command: 'about', description: 'About this AI character' },
  { command: 'memory', description: 'What I remember about you' },
  { command: 'forget', description: 'Delete what I remember about you' },
  { command: 'stopai', description: 'Stop AI replies' },
  { command: 'deletemydata', description: 'Delete all your data' },
  { command: 'paysupport', description: 'Help with a payment' },
  { command: 'terms', description: 'Terms of service' },
  { command: 'privacy', description: 'Privacy policy' },
  { command: 'help', description: 'All commands' },
];

export function botCommands(): { command: string; description: string }[] {
  return [...CORE_COMMANDS, ...[...hooks.commands].map(([command, c]) => ({ command, description: c.description }))];
}

export async function configureBotProfile(client: TelegramClient, inf: { display_name: string; ai_disclosure_short: string; ai_disclosure_long: string }): Promise<void> {
  await client.setMyCommands(botCommands());
  await client.setMyDescription(`${inf.display_name} — ${inf.ai_disclosure_short}.\n\n${inf.ai_disclosure_long}\n\nAdults (18+) only.`.slice(0, 512));
  await client.setMyShortDescription(`${inf.display_name} — ${inf.ai_disclosure_short}. 18+.`.slice(0, 120));
}

/**
 * Connects an influencer's Telegram bot: verifies the token (getMe), stores it
 * encrypted, creates the bot channel and sets commands and the disclosure.
 */
export async function connectTelegramBot(svc: Services, db: Db, ctx: Ctx, influencerId: string, token: string): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'integration.manage');
  const inf = await getInfluencer(db, ctx, influencerId);
  const client = new TelegramClient(svc.config.telegram.apiBaseUrl, token);
  let me: TgUser;
  try {
    me = await client.getMe();
  } catch (err) {
    throw unprocessable('TELEGRAM_TOKEN_INVALID', `Telegram rejected the bot token: ${(err as Error).message}`);
  }
  if (!me.is_bot || String(me.id) !== client.botId) throw unprocessable('TELEGRAM_TOKEN_INVALID', 'The token does not belong to a bot');
  const account = await createIntegrationAccount(db, ctx, svc.config, {
    influencer_id: influencerId,
    provider: 'telegram_bot',
    external_account_id: String(me.id),
    display_name: me.first_name,
    credential: token,
    scopes: ['bot'],
  });
  await db.query('UPDATE core.integration_accounts SET bot_username = $2 WHERE id = $1', [account.id, me.username ?? null]);
  const channel = await createChannel(db, ctx, influencerId, {
    integration_account_id: String(account.id),
    kind: 'telegram_bot',
    external_id: String(me.id),
    username: me.username ?? null,
    title: me.first_name,
  });
  await configureBotProfile(client, inf);
  await auditCtx(db, ctx, { influencerId, action: 'telegram.bot_connected', subjectType: 'integration_account', subjectId: String(account.id), metadata: { bot_username: me.username } });
  return { account_id: account.id, channel_id: channel.id, bot_id: String(me.id), bot_username: me.username ?? null };
}

// -----------------------------------------------------------------------------
// Transport for conversations on the bot channel
// -----------------------------------------------------------------------------
export function registerTelegramTransport(): void {
  registerTransport('telegram_bot', async (svc, conv) => {
    const ch = await one<{ integration_account_id: string }>(svc.workerPool, 'SELECT integration_account_id FROM publishing.channels WHERE id = $1', [conv.channel_id]);
    const client = await clientForAccount(svc, ch.integration_account_id);
    const chatId = conv.external_chat_id;
    return {
      async send(text, opts) {
        const m = await client.sendMessage(chatId, text, { ...(opts?.buttons ? { buttons: opts.buttons } : {}), disablePreview: true });
        return { externalMessageId: `${m.chat.id}:${m.message_id}` };
      },
      async typing() {
        await client.sendChatAction(chatId, 'typing');
      },
    };
  });
}

// -----------------------------------------------------------------------------
// Ingestion: long polling with persist-then-advance
// -----------------------------------------------------------------------------
export const ALLOWED_UPDATES = ['message', 'callback_query', 'pre_checkout_query', 'chat_join_request', 'chat_member', 'my_chat_member'];

function laneFor(u: TgUpdate): { queue: string; priority: number } {
  if (u.message?.successful_payment || u.message?.refunded_payment || u.pre_checkout_query) return { queue: 'payments', priority: PRIORITY.payments };
  if (u.chat_join_request || u.chat_member) return { queue: 'payments', priority: PRIORITY.payments };
  return { queue: 'conversation', priority: PRIORITY.conversation };
}

/**
 * Fetches one batch of updates for a bot, stores each update (deduplicated by
 * update_id) and enqueues its processing, then advances the cursor in the
 * same transaction. Pre-checkout queries are answered inline because Telegram
 * expects an answer within seconds.
 */
export async function pollBot(svc: Services, bot: BotRow, timeoutS: number): Promise<number> {
  const client = await clientForAccount(svc, bot.account_id);
  const cursor = await maybeOne<{ cursor: string }>(svc.workerPool, `SELECT cursor FROM core.poll_cursors WHERE source = 'telegram_updates' AND account_ref = $1`, [bot.bot_id]);
  let updates: TgUpdate[];
  try {
    updates = await client.getUpdates(cursor ? Number(cursor.cursor) : null, timeoutS, ALLOWED_UPDATES);
  } catch (err) {
    if (err instanceof TelegramApiError && (err.code === 401 || err.code === 404)) {
      await svc.workerPool.query(`UPDATE core.integration_accounts SET status = 'needs_reauth', updated_at = now() WHERE id = $1`, [bot.account_id]);
      await raiseAlert(svc.workerPool, {
        workspaceId: bot.workspace_id,
        severity: 'critical',
        source: 'telegram',
        code: 'TELEGRAM_TOKEN_REJECTED',
        dedupKey: `telegram:token:${bot.account_id}`,
        message: `Telegram rejected the token of bot ${bot.bot_username ?? bot.bot_id}; polling stopped until the token is replaced`,
        details: { account_id: bot.account_id },
      });
    } else if (err instanceof TelegramApiError && err.code === 409) {
      await raiseAlert(svc.workerPool, {
        workspaceId: bot.workspace_id,
        severity: 'critical',
        source: 'telegram',
        code: 'TELEGRAM_POLL_CONFLICT',
        dedupKey: `telegram:conflict:${bot.account_id}`,
        message: `Another getUpdates consumer or a webhook is active for bot ${bot.bot_username ?? bot.bot_id}`,
        details: { account_id: bot.account_id, description: err.description },
      });
    }
    throw err;
  }
  if (updates.length === 0) return 0;
  const preCheckouts: { webhookId: string; update: TgUpdate }[] = [];
  await withTx(svc.workerPool, async (tx) => {
    for (const u of updates) {
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO core.inbound_webhooks (provider, account_ref, dedup_key, payload) VALUES ('telegram', $1, $2, $3)
         ON CONFLICT (dedup_key) DO NOTHING RETURNING id`,
        [bot.bot_id, `telegram:${bot.bot_id}:${u.update_id}`, JSON.stringify(u)],
      );
      const webhookId = ins.rows[0]?.id;
      if (!webhookId) continue;
      if (u.pre_checkout_query) {
        preCheckouts.push({ webhookId, update: u });
        continue;
      }
      const lane = laneFor(u);
      await enqueue(tx, {
        workspaceId: bot.workspace_id,
        queue: lane.queue,
        name: 'telegram.process_update',
        key: `telegram.update:${webhookId}`,
        payload: { webhook_id: webhookId, account_id: bot.account_id },
        priority: lane.priority,
        maxAttempts: 10,
      });
    }
    const next = Math.max(...updates.map((u) => u.update_id)) + 1;
    await tx.query(
      `INSERT INTO core.poll_cursors (source, account_ref, cursor) VALUES ('telegram_updates', $1, $2)
       ON CONFLICT (source, account_ref) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = now()`,
      [bot.bot_id, String(next)],
    );
  });
  for (const pc of preCheckouts) await answerPreCheckout(svc, bot, client, pc.webhookId, pc.update);
  await resolveAlert(svc.workerPool, `telegram:conflict:${bot.account_id}`).catch(() => undefined);
  return updates.length;
}

async function answerPreCheckout(svc: Services, bot: BotRow, client: TelegramClient, webhookId: string, update: TgUpdate): Promise<void> {
  const q = update.pre_checkout_query!;
  let verdict: { ok: boolean; error?: string };
  try {
    verdict = hooks.preCheckout ? await hooks.preCheckout({ svc, bot, client, update }, q) : { ok: false, error: 'Payments are not available yet.' };
  } catch (err) {
    console.error(`[telegram] pre-checkout validation failed: ${(err as Error).message}`);
    verdict = { ok: false, error: 'Something went wrong. You were not charged; please try again later.' };
  }
  try {
    await client.answerPreCheckoutQuery(q.id, verdict.ok, verdict.error);
    await svc.workerPool.query(`UPDATE core.inbound_webhooks SET status = 'processed', processed_at = now(), attempts = attempts + 1 WHERE id = $1`, [webhookId]);
  } catch (err) {
    await svc.workerPool.query(`UPDATE core.inbound_webhooks SET status = 'failed', attempts = attempts + 1, error = $2 WHERE id = $1`, [
      webhookId,
      JSON.stringify({ message: (err as Error).message }),
    ]);
  }
}

/**
 * Production polling: one long-poll loop per active bot, so a quiet bot never
 * delays a busy one. The manager tick starts loops for newly connected bots;
 * loops end when their bot is disabled or the worker stops.
 */
export class TelegramPoller {
  private readonly loops = new Map<string, Promise<void>>();
  private stopping = false;

  constructor(private readonly svc: Services) {}

  async sync(): Promise<void> {
    if (this.stopping) return;
    for (const bot of await activeBots(this.svc.workerPool)) {
      if (!this.loops.has(bot.account_id)) {
        this.loops.set(
          bot.account_id,
          this.run(bot).finally(() => this.loops.delete(bot.account_id)),
        );
      }
    }
  }

  private async run(bot: BotRow): Promise<void> {
    let failures = 0;
    while (!this.stopping) {
      const current = await loadBot(this.svc.workerPool, bot.account_id).catch(() => bot);
      if (!current || current.account_status !== 'active') return;
      try {
        await pollBot(this.svc, current, this.svc.config.telegram.pollTimeoutSeconds);
        failures = 0;
        if (this.svc.config.telegram.pollTimeoutSeconds === 0) await sleep(this.svc.config.telegram.pollIntervalMs);
      } catch (err) {
        failures++;
        const retryAfter = err instanceof TelegramApiError && err.retryAfterS ? err.retryAfterS * 1000 : 0;
        const wait = Math.max(retryAfter, Math.min(60_000, 1000 * 2 ** Math.min(failures, 6)));
        console.error(`[telegram:${bot.bot_username ?? bot.bot_id}] poll failed (${failures}): ${(err as Error).message}; retry in ${wait} ms`);
        await sleep(wait);
      }
    }
  }

  /** One bounded pass over every active bot (no long poll). */
  async once(): Promise<number> {
    let n = 0;
    for (const bot of await activeBots(this.svc.workerPool)) n += await pollBot(this.svc, bot, 0);
    return n;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    // In-flight long polls finish on their own; anything they fetched is either
    // persisted with its cursor or re-fetched on the next start.
    await Promise.race([Promise.allSettled([...this.loops.values()]), sleep(2000)]);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// -----------------------------------------------------------------------------
// Update processing (job `telegram.process_update`)
// -----------------------------------------------------------------------------
export async function processUpdateJob(svc: Services, p: { webhook_id: string; account_id: string }): Promise<unknown> {
  const db = svc.workerPool;
  const hook = await maybeOne<{ payload: TgUpdate; status: string }>(db, 'SELECT payload, status FROM core.inbound_webhooks WHERE id = $1', [p.webhook_id]);
  if (!hook) throw new PermanentJobError(`inbound webhook ${p.webhook_id} not found`);
  if (hook.status === 'processed' || hook.status === 'ignored') return { skipped: hook.status };
  const bot = await loadBot(db, p.account_id);
  if (!bot || bot.account_status !== 'active') {
    await markWebhook(db, p.webhook_id, 'ignored');
    return { skipped: 'bot_inactive' };
  }
  await db.query(`UPDATE core.inbound_webhooks SET status = 'processing', attempts = attempts + 1 WHERE id = $1`, [p.webhook_id]);
  try {
    const client = await clientForAccount(svc, bot.account_id);
    const outcome = (await routeUpdate({ svc, bot, client, update: hook.payload })) ?? 'processed';
    await markWebhook(db, p.webhook_id, outcome === 'ignored' ? 'ignored' : 'processed');
    return { outcome };
  } catch (err) {
    await db.query(`UPDATE core.inbound_webhooks SET status = 'failed', error = $2 WHERE id = $1`, [p.webhook_id, JSON.stringify({ message: (err as Error).message })]);
    throw err;
  }
}

async function markWebhook(db: pg.Pool, id: string, status: 'processed' | 'ignored'): Promise<void> {
  await db.query(`UPDATE core.inbound_webhooks SET status = $2, processed_at = now(), error = NULL WHERE id = $1`, [id, status]);
}

async function routeUpdate(u: UpdateContext): Promise<string | void> {
  const { update } = u;
  if (update.message?.successful_payment || update.message?.refunded_payment) {
    const kind = update.message.successful_payment ? 'successful_payment' : 'refunded_payment';
    const h = hooks.updates.get(kind);
    // A payment must never be dropped silently: without a handler the job dead-letters with a critical alert.
    if (!h) throw new PermanentJobError(`no handler for ${kind}`);
    return h(u);
  }
  if (update.chat_join_request || update.chat_member) {
    const h = hooks.updates.get(update.chat_join_request ? 'chat_join_request' : 'chat_member');
    return h ? h(u) : 'ignored';
  }
  if (update.callback_query) return handleCallback(u);
  if (update.message) return handleMessage(u, update.message);
  return 'ignored';
}

function allowed(svc: Services, user: TgUser): boolean {
  const list = svc.config.telegram.allowlistedUserIds;
  return list.length === 0 || list.includes(String(user.id));
}

const CLOSED_BETA = 'This bot is in a closed beta and not open yet. Thanks for your interest!';

async function chatContext(u: UpdateContext, user: TgUser, chatId: number): Promise<ChatContext> {
  const db = u.svc.workerPool;
  const { fan } = await upsertTelegramFan(db, u.bot.workspace_id, u.bot.influencer_id, user);
  const conv = await openConversation(db, {
    workspaceId: u.bot.workspace_id,
    influencerId: u.bot.influencer_id,
    channelId: u.bot.channel_id,
    fanId: fan.id,
    externalChatId: String(chatId),
    locale: user.language_code ?? null,
  });
  return {
    ...u,
    user,
    fan,
    conv,
    reply: async (text, buttons) => {
      await sendSystemMessage(u.svc, conv, text, 'service', buttons ? { buttons } : {});
    },
  };
}

function messageKind(m: TgMessage): 'text' | 'photo' | 'video' | 'voice' | 'sticker' | null {
  if (typeof m.text === 'string') return 'text';
  if (m.photo) return 'photo';
  if (m.video) return 'video';
  if (m.voice) return 'voice';
  if (m.sticker) return 'sticker';
  return null;
}

async function handleMessage(u: UpdateContext, m: TgMessage): Promise<string> {
  const user = m.from;
  if (!user || user.is_bot || m.chat.type !== 'private') return 'ignored';
  if (!allowed(u.svc, user)) {
    await u.client.sendMessage(m.chat.id, CLOSED_BETA);
    return 'ignored';
  }
  const c = await chatContext(u, user, m.chat.id);
  if (c.fan.status === 'blocked' || c.conv.status === 'blocked') return 'ignored';
  const command = m.text ? /^\/([a-z0-9_]{1,32})(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(m.text.trim()) : null;
  if (command) {
    await handleCommand(c, command[1]!.toLowerCase(), command[2]?.trim() ?? '');
    return 'command';
  }
  const db = u.svc.workerPool;
  // Nothing a person writes is stored before they accept the terms and the AI disclosure.
  if (!(await activeConsent(db, c.fan.id, u.bot.influencer_id, 'terms_acceptance'))) {
    await sendConsentCard(c);
    return 'consent_requested';
  }
  const kind = messageKind(m);
  if (!kind) {
    await c.reply('I can only read text messages here.');
    return 'unsupported';
  }
  const text = m.text ?? m.caption ?? null;
  const id = await recordInbound(db, c.conv, { externalMessageId: `${m.chat.id}:${m.message_id}`, text, kind });
  if (!id) return 'duplicate';
  await db.query(`UPDATE crm.fan_influencer_profiles SET last_interaction_at = now() WHERE fan_id = $1 AND influencer_id = $2`, [c.fan.id, u.bot.influencer_id]);
  if (kind === 'text' && text) {
    const r = await handleInbound(u.svc, c.conv, id, text);
    return r.replyScheduled ? 'reply_scheduled' : 'recorded';
  }
  return 'recorded';
}

async function influencerOf(db: pg.Pool, id: string): Promise<{ display_name: string; ai_disclosure_short: string; ai_disclosure_long: string }> {
  return one(db, 'SELECT display_name, ai_disclosure_short, ai_disclosure_long FROM identity.influencers WHERE id = $1', [id]);
}

/** The first message every person sees: AI disclosure, adults-only notice, data use, and the consent buttons. */
async function sendConsentCard(c: ChatContext): Promise<void> {
  const db = c.svc.workerPool;
  const inf = await influencerOf(db, c.bot.influencer_id);
  const terms = await latestPolicy(db, c.bot.workspace_id, 'terms');
  const privacy = await latestPolicy(db, c.bot.workspace_id, 'privacy');
  const links = [terms ? `Terms: ${terms.url}` : null, privacy ? `Privacy: ${privacy.url}` : null].filter(Boolean).join('\n');
  const text = [
    `Hi! I'm ${inf.display_name}. ${inf.ai_disclosure_long}`,
    'Before we chat:\n• This chat is for adults (18+) only.\n• Your messages are processed by an AI model to write my replies, and staff may review chats for safety.\n• You can use /stopai, /forget or /deletemydata at any time.',
    links,
  ]
    .filter(Boolean)
    .join('\n\n');
  await sendSystemMessage(c.svc, c.conv, text, 'disclosure', {
    buttons: [[{ text: "✅ I'm 18+ and agree", callback_data: 'consent:accept' }], [{ text: 'No thanks', callback_data: 'consent:decline' }]],
  });
}

async function handleCommand(c: ChatContext, name: string, args: string): Promise<void> {
  const db = c.svc.workerPool;
  const inf = c.bot.influencer_id;
  switch (name) {
    case 'start': {
      await trackEvent(db, { workspaceId: c.bot.workspace_id, influencerId: inf, fanId: c.fan.id, name: 'bot_start', properties: { deep_link: args ? true : false }, source: 'telegram' });
      if (await activeConsent(db, c.fan.id, inf, 'ai_processing')) {
        const p = await influencerOf(db, inf);
        await sendSystemMessage(c.svc, c.conv, `Welcome back! Reminder: ${p.ai_disclosure_short}. Replies here are automated.`, 'disclosure');
      } else {
        await sendConsentCard(c);
      }
      return;
    }
    case 'about': {
      const p = await influencerOf(db, inf);
      await c.reply(`${p.display_name} — ${p.ai_disclosure_short}.\n\n${p.ai_disclosure_long}\n\nSee /help for commands.`);
      return;
    }
    case 'help':
      await c.reply(botCommands().map((x) => `/${x.command} — ${x.description}`).join('\n'));
      return;
    case 'memory': {
      if (!(await activeConsent(db, c.fan.id, inf, 'memory_personalization'))) {
        await c.reply('Memory is off: I don’t keep notes about you between chats.', [[{ text: 'Turn memory on', callback_data: 'memory:on' }]]);
        return;
      }
      const mems = await activeMemories(db, inf, c.fan.id);
      const body = mems.length ? `Here's what I remember about you:\n${mems.map((m) => `• ${m.statement}`).join('\n')}` : "Memory is on, but I haven't noted anything yet.";
      await c.reply(body, [[{ text: 'Forget everything', callback_data: 'memory:forget' }], [{ text: 'Turn memory off', callback_data: 'memory:off' }]]);
      return;
    }
    case 'forget': {
      const n = await forgetAll(db, inf, c.fan.id);
      await c.reply(n ? `Done — I deleted ${n} note${n === 1 ? '' : 's'} about you. Use /memory to turn memory off completely.` : 'There was nothing to forget.');
      return;
    }
    case 'stopai': {
      await withdrawConsent(db, c.fan.id, inf, 'ai_processing');
      await c.reply('AI replies are now off and your messages are no longer processed by the AI. Send /start to turn them back on.');
      return;
    }
    case 'deletemydata':
      await c.reply('This deletes your messages, everything I remember and your preferences. Purchases stay in our accounting records as required by law, without your messages. Continue?', [
        [{ text: 'Yes, delete my data', callback_data: 'erase:confirm' }],
        [{ text: 'Cancel', callback_data: 'erase:cancel' }],
      ]);
      return;
    case 'paysupport':
      await escalate(db, c.conv, { reason: 'payment_dispute', severity: 'medium', slaMinutes: 240 });
      await c.reply('I’ve passed this to the team; a person will look into your payment. Please describe what happened in your next message (date and amount help).');
      return;
    case 'terms':
    case 'privacy': {
      const doc = await latestPolicy(db, c.bot.workspace_id, name);
      await c.reply(doc ? `${name === 'terms' ? 'Terms of service' : 'Privacy policy'} (version ${doc.version}): ${doc.url}` : 'This document is not published yet.');
      return;
    }
    default: {
      const ext = hooks.commands.get(name);
      if (ext) {
        if (!(await activeConsent(db, c.fan.id, inf, 'terms_acceptance'))) return sendConsentCard(c);
        return ext.handler(c, args);
      }
      await c.reply('Unknown command. See /help.');
    }
  }
}

async function handleCallback(u: UpdateContext): Promise<string> {
  const q = u.update.callback_query!;
  await u.client.answerCallbackQuery(q.id).catch(() => undefined);
  if (!q.message || q.message.chat.type !== 'private' || q.from.is_bot) return 'ignored';
  if (!allowed(u.svc, q.from)) return 'ignored';
  const c = await chatContext(u, q.from, q.message.chat.id);
  if (c.fan.status === 'blocked') return 'ignored';
  const db = u.svc.workerPool;
  const inf = u.bot.influencer_id;
  const data = q.data ?? '';
  const evidence = { callback_query_id: q.id, message_id: q.message.message_id, data, at: new Date().toISOString() };
  switch (data) {
    case 'consent:accept': {
      if (['suspected_minor', 'confirmed_minor'].includes(c.fan.age_status) || c.fan.status === 'restricted') {
        await c.reply(MINOR_MESSAGE);
        return 'refused';
      }
      const terms = await latestPolicy(db, u.bot.workspace_id, 'terms');
      const privacy = await latestPolicy(db, u.bot.workspace_id, 'privacy');
      const base = { workspaceId: u.bot.workspace_id, fanId: c.fan.id, influencerId: inf, method: 'bot_button' as const, evidence };
      await grantConsent(db, { ...base, purpose: 'age_attestation_18' });
      await grantConsent(db, { ...base, purpose: 'terms_acceptance', policyDocumentId: terms?.id ?? null });
      await grantConsent(db, { ...base, purpose: 'ai_processing', policyDocumentId: privacy?.id ?? null });
      await trackEvent(db, { workspaceId: u.bot.workspace_id, influencerId: inf, fanId: c.fan.id, name: 'consent_granted', source: 'telegram' });
      if (await activeConsent(db, c.fan.id, inf, 'memory_personalization')) {
        await c.reply('All set — say hi! 👋');
      } else {
        await c.reply('Thanks! One more choice: may I remember things you tell me (like your interests) to make our chats more personal? You can change this any time with /memory.', [
          [{ text: 'Yes, remember', callback_data: 'memory:on' }],
          [{ text: 'No, thanks', callback_data: 'memory:off' }],
        ]);
      }
      return 'consented';
    }
    case 'consent:decline':
      await c.reply("No problem. I can't chat without your consent — send /start whenever you change your mind.");
      return 'declined';
    case 'memory:on':
      if (!(await activeConsent(db, c.fan.id, inf, 'terms_acceptance'))) {
        await sendConsentCard(c);
        return 'consent_requested';
      }
      await grantConsent(db, { workspaceId: u.bot.workspace_id, fanId: c.fan.id, influencerId: inf, purpose: 'memory_personalization', method: 'bot_button', evidence });
      await c.reply("Got it — I'll remember things you share. See or delete them with /memory. Now, say hi! 👋");
      return 'memory_on';
    case 'memory:off': {
      await withdrawConsent(db, c.fan.id, inf, 'memory_personalization');
      await forgetAll(db, inf, c.fan.id);
      await c.reply("Okay — I won't remember anything between chats. Say hi! 👋");
      return 'memory_off';
    }
    case 'memory:forget': {
      const n = await forgetAll(db, inf, c.fan.id);
      await c.reply(`Done — I deleted ${n} note${n === 1 ? '' : 's'}.`);
      return 'memory_forgotten';
    }
    case 'erase:confirm': {
      await eraseFan(db, c.fan.id, { type: 'external', id: `telegram:${c.bot.bot_id}` }, 'telegram_command');
      // Sent directly: the erased conversation no longer records messages.
      await u.client.sendMessage(q.message.chat.id, 'Your data has been deleted. If you write again, we start fresh.');
      return 'erased';
    }
    case 'erase:cancel':
      await c.reply('Okay, nothing was deleted.');
      return 'erase_cancelled';
    default: {
      const prefix = data.split(':')[0] ?? '';
      const h = hooks.callbacks.get(prefix);
      if (!h) return 'ignored';
      await h(c, data);
      return 'callback';
    }
  }
}

/** Wiring for the Telegram integration (see wiring.ts). */
export function telegramContribution(svc: Services, r: import('../../registry.js').Registry): void {
  registerTelegramTransport();
  r.handlers.set('telegram.process_update', (job) => processUpdateJob(svc, job.payload as { webhook_id: string; account_id: string }));
  const poller = new TelegramPoller(svc);
  r.loops.push({ name: 'telegram-poll', intervalMs: 10_000, run: () => poller.sync(), once: () => poller.once(), stop: () => poller.stop() });
}


