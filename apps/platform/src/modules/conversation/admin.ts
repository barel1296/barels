import type pg from 'pg';
import type { Db } from '../../db/tx.js';
import { maybeOne, one, withTenant } from '../../db/tx.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import type { Services } from '../../services.js';
import { raiseAlert } from '../alerts.js';
import { auditCtx } from '../audit.js';
import { type Actor, type Ctx, requireInfluencerAccess, requirePermission } from '../context.js';
import { eraseFan } from '../crm.js';
import { sweepExpiredEntitlements } from '../monetization/entitlements.js';
import type { Registry } from '../../registry.js';
import { type ConversationRow, approveDraft, generateReply, memoryJob, operatorSend, rejectDraft } from './engine.js';

/**
 * Staff-facing conversation operations (dashboard and API): inbox, draft
 * review, takeover, escalations, fan records. Reads run under the tenant's
 * row-level security; sends go through the conversation engine.
 */
async function convFor(db: Db, ctx: Ctx, id: string, permission: string): Promise<ConversationRow> {
  requirePermission(ctx, permission);
  const conv = await maybeOne<ConversationRow>(db, 'SELECT * FROM conversation.conversations WHERE id = $1', [id]);
  if (!conv) throw notFound('Conversation', id);
  requireInfluencerAccess(ctx, conv.influencer_id);
  return conv;
}

export async function listConversations(
  db: Db,
  ctx: Ctx,
  q: { influencer_id?: string; status?: string; mode?: string; needs_attention?: boolean; limit?: number },
): Promise<unknown[]> {
  requirePermission(ctx, 'conversation.read');
  if (q.influencer_id) requireInfluencerAccess(ctx, q.influencer_id);
  const scope = ctx.influencerScope ? [...ctx.influencerScope] : null;
  const { rows } = await db.query(
    `SELECT c.id, c.influencer_id, i.display_name AS influencer_name, c.channel_id, c.fan_id, f.display_name AS fan_name, f.age_status, f.status AS fan_status,
            c.mode, c.status, c.assigned_user_id, c.last_inbound_at, c.last_outbound_at, c.ai_disclosed_at, c.created_at,
            (SELECT count(*) FROM conversation.messages m WHERE m.conversation_id = c.id AND m.status = 'drafted')::int AS pending_drafts,
            (SELECT count(*) FROM conversation.escalations e WHERE e.conversation_id = c.id AND e.status <> 'resolved')::int AS open_escalations
       FROM conversation.conversations c
       JOIN identity.influencers i ON i.id = c.influencer_id
       JOIN crm.fans f ON f.id = c.fan_id
      WHERE ($1::uuid IS NULL OR c.influencer_id = $1) AND ($2::text IS NULL OR c.status = $2) AND ($3::text IS NULL OR c.mode = $3)
        AND ($4::uuid[] IS NULL OR c.influencer_id = ANY($4))
        AND (NOT $5 OR EXISTS (SELECT 1 FROM conversation.messages m WHERE m.conversation_id = c.id AND m.status = 'drafted')
                    OR EXISTS (SELECT 1 FROM conversation.escalations e WHERE e.conversation_id = c.id AND e.status <> 'resolved'))
      ORDER BY coalesce(c.last_inbound_at, c.created_at) DESC
      LIMIT $6`,
    [q.influencer_id ?? null, q.status ?? null, q.mode ?? null, scope, q.needs_attention ?? false, Math.min(q.limit ?? 100, 500)],
  );
  return rows;
}

export async function getConversation(db: Db, ctx: Ctx, id: string, limit = 200): Promise<Record<string, unknown>> {
  const conv = await convFor(db, ctx, id, 'conversation.read');
  const messages = await db.query(
    `SELECT * FROM (
       SELECT id, created_at, direction, author_type, author_user_id, kind, body, original_body, status, guard_result, sent_at, reviewed_by, reviewed_at
         FROM conversation.messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2) t
      ORDER BY created_at`,
    [id, Math.min(limit, 1000)],
  );
  const escalations = await db.query(`SELECT * FROM conversation.escalations WHERE conversation_id = $1 ORDER BY created_at DESC`, [id]);
  const fan = await one(db, 'SELECT id, display_name, primary_language, age_status, status, risk_flags, first_seen_at, last_seen_at FROM crm.fans WHERE id = $1', [conv.fan_id]);
  const consents = await db.query(
    `SELECT purpose, status, method, granted_at, withdrawn_at FROM crm.consents WHERE fan_id = $1 AND (influencer_id = $2 OR influencer_id IS NULL) ORDER BY created_at`,
    [conv.fan_id, conv.influencer_id],
  );
  return { ...conv, fan, consents: consents.rows, messages: messages.rows, escalations: escalations.rows };
}

export async function updateConversation(
  db: Db,
  ctx: Ctx,
  id: string,
  input: { mode?: ConversationRow['mode']; status?: 'open' | 'snoozed' | 'closed' | 'blocked'; assigned_user_id?: string | null },
): Promise<unknown> {
  const conv = await convFor(db, ctx, id, 'conversation.reply');
  if (input.mode === 'ai_auto' || input.status === 'blocked') requirePermission(ctx, 'conversation.manage');
  if (input.mode && input.mode !== 'human' && input.mode !== 'paused') {
    // AI cannot be switched back on while a safety escalation that stopped it is unresolved.
    const blocking = await maybeOne<{ reason: string }>(
      db,
      `SELECT reason FROM conversation.escalations WHERE conversation_id = $1 AND status <> 'resolved' AND reason IN ('self_harm_risk', 'minor_signal', 'threat_or_illegal')`,
      [id],
    );
    if (blocking) throw conflict('ESCALATION_OPEN', `Resolve the open ${blocking.reason} escalation before re-enabling AI replies`);
  }
  const row = await one(
    db,
    `UPDATE conversation.conversations SET mode = coalesce($2, mode), status = coalesce($3, status),
            assigned_user_id = CASE WHEN $4 THEN $5::uuid ELSE assigned_user_id END
      WHERE id = $1 RETURNING *`,
    [id, input.mode ?? null, input.status ?? null, input.assigned_user_id !== undefined, input.assigned_user_id ?? null],
  );
  await auditCtx(db, ctx, {
    influencerId: conv.influencer_id,
    action: 'conversation.update',
    subjectType: 'conversation',
    subjectId: id,
    changes: { before: { mode: conv.mode, status: conv.status }, after: input },
  });
  return row;
}

function userActor(ctx: Ctx): Actor & { type: 'user' } {
  if (ctx.actor.type !== 'user' || !ctx.userId) throw forbidden('A signed-in staff user is required');
  return { type: 'user', id: ctx.userId };
}

function mapEngineError(err: unknown): never {
  const msg = (err as Error).message ?? '';
  if (msg === 'DRAFT_NOT_FOUND') throw notFound('Draft');
  if (msg.startsWith('GUARD_VIOLATION:')) throw new AppError(422, 'GUARD_VIOLATION', 'The message breaks platform rules', { violations: msg.slice(16).split(',') });
  throw err;
}

export async function staffSend(svc: Services, ctx: Ctx, conversationId: string, body: string): Promise<{ message_id: string }> {
  await withTenant(svc.appPool, ctx.workspaceId, (db) => convFor(db, ctx, conversationId, 'conversation.reply'));
  try {
    return { message_id: await operatorSend(svc, userActor(ctx), conversationId, body) };
  } catch (err) {
    mapEngineError(err);
  }
}

export async function staffApproveDraft(svc: Services, ctx: Ctx, conversationId: string, messageId: string, editedBody: string | null): Promise<{ status: string }> {
  await withTenant(svc.appPool, ctx.workspaceId, (db) => convFor(db, ctx, conversationId, 'conversation.reply'));
  try {
    return await approveDraft(svc, userActor(ctx), conversationId, messageId, editedBody);
  } catch (err) {
    mapEngineError(err);
  }
}

export async function staffRejectDraft(svc: Services, ctx: Ctx, conversationId: string, messageId: string): Promise<{ status: string }> {
  await withTenant(svc.appPool, ctx.workspaceId, (db) => convFor(db, ctx, conversationId, 'conversation.reply'));
  try {
    await rejectDraft(svc, userActor(ctx), conversationId, messageId);
    return { status: 'suppressed' };
  } catch (err) {
    mapEngineError(err);
  }
}

// -----------------------------------------------------------------------------
// Escalations
// -----------------------------------------------------------------------------
export async function listEscalations(db: Db, ctx: Ctx, q: { status?: 'open' | 'acknowledged' | 'resolved' | 'unresolved'; influencer_id?: string }): Promise<unknown[]> {
  requirePermission(ctx, 'conversation.read');
  if (q.influencer_id) requireInfluencerAccess(ctx, q.influencer_id);
  const scope = ctx.influencerScope ? [...ctx.influencerScope] : null;
  const status = q.status ?? 'unresolved';
  const { rows } = await db.query(
    `SELECT e.*, (e.sla_due_at < now() AND e.status <> 'resolved') AS sla_breached
       FROM conversation.escalations e
      WHERE ($1 = 'unresolved' AND e.status <> 'resolved' OR e.status = $1)
        AND ($2::uuid IS NULL OR e.influencer_id = $2) AND ($3::uuid[] IS NULL OR e.influencer_id = ANY($3))
      ORDER BY CASE e.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, e.sla_due_at
      LIMIT 500`,
    [status, q.influencer_id ?? null, scope],
  );
  return rows;
}

export async function updateEscalation(db: Db, ctx: Ctx, id: string, action: 'acknowledge' | 'resolve', resolution?: string): Promise<unknown> {
  requirePermission(ctx, 'escalation.manage');
  const e = await maybeOne<{ influencer_id: string; status: string }>(db, 'SELECT influencer_id, status FROM conversation.escalations WHERE id = $1', [id]);
  if (!e) throw notFound('Escalation', id);
  requireInfluencerAccess(ctx, e.influencer_id);
  if (e.status === 'resolved') throw conflict('ESCALATION_RESOLVED', 'Escalation is already resolved');
  if (action === 'resolve' && !resolution?.trim()) throw badRequest('RESOLUTION_REQUIRED', 'Describe how the escalation was resolved');
  const row = await one(
    db,
    action === 'acknowledge'
      ? `UPDATE conversation.escalations SET status = 'acknowledged', assigned_user_id = coalesce(assigned_user_id, $2) WHERE id = $1 RETURNING *`
      : `UPDATE conversation.escalations SET status = 'resolved', resolution = $3, resolved_at = now(), assigned_user_id = coalesce(assigned_user_id, $2) WHERE id = $1 RETURNING *`,
    action === 'acknowledge' ? [id, ctx.userId] : [id, ctx.userId, resolution],
  );
  await auditCtx(db, ctx, { influencerId: e.influencer_id, action: `escalation.${action}`, subjectType: 'escalation', subjectId: id, metadata: resolution ? { resolution } : {} });
  return row;
}

// -----------------------------------------------------------------------------
// Fans (CRM view, memory management, erasure)
// -----------------------------------------------------------------------------
export async function listFans(db: Db, ctx: Ctx, influencerId: string, limit = 200): Promise<unknown[]> {
  requirePermission(ctx, 'fan.read');
  requireInfluencerAccess(ctx, influencerId);
  const { rows } = await db.query(
    `SELECT f.id, f.display_name, f.age_status, f.status, f.risk_flags, p.lifecycle_stage, p.lifetime_stars, p.first_interaction_at, p.last_interaction_at
       FROM crm.fan_influencer_profiles p JOIN crm.fans f ON f.id = p.fan_id
      WHERE p.influencer_id = $1 ORDER BY p.last_interaction_at DESC NULLS LAST LIMIT $2`,
    [influencerId, Math.min(limit, 1000)],
  );
  return rows;
}

async function fanInfluencers(db: Db, fanId: string): Promise<string[]> {
  const { rows } = await db.query<{ influencer_id: string }>('SELECT influencer_id FROM crm.fan_influencer_profiles WHERE fan_id = $1', [fanId]);
  return rows.map((r) => r.influencer_id);
}

function requireFanScope(ctx: Ctx, influencerIds: string[]): void {
  if (ctx.influencerScope && !influencerIds.some((i) => ctx.influencerScope!.has(i))) throw forbidden('Fan is outside your access scope');
}

export async function getFan(db: Db, ctx: Ctx, fanId: string): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'fan.read');
  const fan = await maybeOne(db, 'SELECT id, display_name, primary_language, country_code, age_status, status, risk_flags, first_seen_at, last_seen_at, erased_at FROM crm.fans WHERE id = $1', [fanId]);
  if (!fan) throw notFound('Fan', fanId);
  const infs = await fanInfluencers(db, fanId);
  requireFanScope(ctx, infs);
  const visible = (rows: { influencer_id: string | null }[]) => rows.filter((r) => !ctx.influencerScope || r.influencer_id === null || ctx.influencerScope.has(r.influencer_id));
  const identities = await db.query(`SELECT platform, username, linked_via, first_seen_at, last_seen_at FROM crm.fan_identities WHERE fan_id = $1`, [fanId]);
  const profiles = await db.query(`SELECT * FROM crm.fan_influencer_profiles WHERE fan_id = $1`, [fanId]);
  const consents = await db.query(`SELECT id, influencer_id, purpose, status, method, granted_at, withdrawn_at FROM crm.consents WHERE fan_id = $1 ORDER BY created_at`, [fanId]);
  const memories = await db.query(
    `SELECT id, influencer_id, category, statement, confidence, created_by_type, created_at FROM conversation.fan_memories WHERE fan_id = $1 AND status = 'active' ORDER BY created_at DESC`,
    [fanId],
  );
  const conversations = await db.query(`SELECT id, influencer_id, mode, status, last_inbound_at FROM conversation.conversations WHERE fan_id = $1`, [fanId]);
  return {
    ...fan,
    identities: identities.rows,
    profiles: visible(profiles.rows),
    consents: visible(consents.rows),
    memories: visible(memories.rows),
    conversations: visible(conversations.rows),
  };
}

export async function deleteMemory(db: Db, ctx: Ctx, fanId: string, memoryId: string): Promise<void> {
  requirePermission(ctx, 'fan.manage');
  const mem = await maybeOne<{ influencer_id: string }>(db, `SELECT influencer_id FROM conversation.fan_memories WHERE id = $1 AND fan_id = $2 AND status = 'active'`, [memoryId, fanId]);
  if (!mem) throw notFound('Memory', memoryId);
  requireInfluencerAccess(ctx, mem.influencer_id);
  await db.query(`UPDATE conversation.fan_memories SET status = 'deleted', deleted_at = now() WHERE id = $1`, [memoryId]);
  await auditCtx(db, ctx, { influencerId: mem.influencer_id, action: 'fan_memory.delete', subjectType: 'fan', subjectId: fanId, metadata: { memory_id: memoryId } });
}

export async function staffEraseFan(db: Db, ctx: Ctx, fanId: string): Promise<{ dsr_id: string }> {
  requirePermission(ctx, 'fan.manage');
  const fan = await maybeOne<{ status: string }>(db, 'SELECT status FROM crm.fans WHERE id = $1', [fanId]);
  if (!fan) throw notFound('Fan', fanId);
  requireFanScope(ctx, await fanInfluencers(db, fanId));
  if (fan.status === 'erased') throw conflict('ALREADY_ERASED', 'Fan data was already erased');
  return eraseFan(db, fanId, ctx.actor, 'staff_request');
}

// -----------------------------------------------------------------------------
// Background wiring
// -----------------------------------------------------------------------------
async function escalationSlaCheck(pool: pg.Pool): Promise<{ breached: number }> {
  const { rows } = await pool.query<{ id: string; workspace_id: string; conversation_id: string; reason: string; severity: string }>(
    `SELECT id, workspace_id, conversation_id, reason, severity FROM conversation.escalations WHERE status = 'open' AND sla_due_at < now() LIMIT 200`,
  );
  for (const e of rows) {
    await raiseAlert(pool, {
      workspaceId: e.workspace_id,
      severity: e.severity === 'critical' || e.severity === 'high' ? 'critical' : 'warning',
      source: 'conversation',
      code: 'ESCALATION_SLA_BREACHED',
      dedupKey: `escalation_sla:${e.id}`,
      message: `Escalation ${e.reason} (${e.severity}) is past its response deadline`,
      details: { escalation_id: e.id, conversation_id: e.conversation_id },
    });
  }
  return { breached: rows.length };
}

export function conversationContribution(svc: Services, r: Registry): void {
  r.handlers.set('conversation.reply', (job) => generateReply(svc, String(job.payload.conversation_id)));
  r.handlers.set('conversation.extract_memory', (job) => memoryJob(svc, job.payload as { conversation_id: string; message_ids: string[]; consent_id: string }));
  r.periodic.push(
    { name: 'conversation.escalation_sla', intervalSeconds: 300, run: () => escalationSlaCheck(svc.workerPool) },
    { name: 'monetization.entitlement_sweep', intervalSeconds: 300, run: async () => ({ expired: await sweepExpiredEntitlements(svc.workerPool) }) },
  );
}
