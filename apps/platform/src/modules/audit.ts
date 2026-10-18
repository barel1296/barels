import type { Db } from '../db/tx.js';
import type { Actor, Ctx } from './context.js';

export interface AuditEntry {
  workspaceId: string | null;
  influencerId?: string | null;
  actor: Actor;
  action: string;
  subjectType: string;
  subjectId: string;
  approvalRequestId?: string | null;
  proposalId?: string | null;
  requestId?: string | null;
  traceId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  changes?: { before?: unknown; after?: unknown } | null;
  metadata?: Record<string, unknown>;
}

/** Appends to core.audit_log (append-only for runtime roles). Call inside the state-changing transaction. */
export async function audit(db: Db, e: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO core.audit_log (workspace_id, influencer_id, actor_type, actor_id, action, subject_type, subject_id,
       approval_request_id, proposal_id, request_id, trace_id, ip, user_agent, changes, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      e.workspaceId,
      e.influencerId ?? null,
      e.actor.type === 'external' ? 'external' : e.actor.type,
      e.actor.id,
      e.action,
      e.subjectType,
      e.subjectId,
      e.approvalRequestId ?? null,
      e.proposalId ?? null,
      e.requestId ?? null,
      e.traceId ?? null,
      e.ip ?? null,
      e.userAgent ?? null,
      e.changes ? JSON.stringify(e.changes) : null,
      JSON.stringify(e.metadata ?? {}),
    ],
  );
}

/** Audit entry carrying the request metadata from a context. */
export function auditCtx(
  db: Db,
  ctx: Ctx,
  e: Omit<AuditEntry, 'workspaceId' | 'actor' | 'requestId' | 'traceId' | 'ip' | 'userAgent'> & { workspaceId?: string | null },
): Promise<void> {
  return audit(db, {
    ...e,
    workspaceId: e.workspaceId === undefined ? ctx.workspaceId : e.workspaceId,
    actor: ctx.actor,
    requestId: ctx.requestId,
    traceId: ctx.traceId ?? null,
    ip: ctx.ip ?? null,
    userAgent: ctx.userAgent ?? null,
  });
}

/** Transactional outbox: domain events are written in the same transaction as the change. */
export async function outbox(
  db: Db,
  e: { workspaceId: string | null; eventType: string; aggregateType: string; aggregateId: string; payload: Record<string, unknown> },
): Promise<void> {
  await db.query(
    `INSERT INTO core.outbox_events (workspace_id, event_type, aggregate_type, aggregate_id, payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [e.workspaceId, e.eventType, e.aggregateType, e.aggregateId, JSON.stringify(e.payload)],
  );
}
