import type { Db } from '../db/tx.js';
import { maybeOne, one } from '../db/tx.js';
import { AppError, PG, badRequest, conflict, forbidden, notFound, pgCode } from '../lib/errors.js';
import { uuidv7 } from '../lib/ids.js';
import { auditCtx, outbox } from './audit.js';
import { type Ctx, requireInfluencerAccess, requirePermission } from './context.js';

interface ApprovalRow {
  id: string;
  workspace_id: string;
  influencer_id: string | null;
  subject_type: string;
  subject_id: string;
  action_type: string;
  status: string;
  payload_snapshot: Record<string, unknown>;
  payload_hash: Buffer;
  requested_by_type: string;
  requested_by_id: string;
  required_approvals: number;
  expires_at: Date;
}

function publicApproval(r: ApprovalRow): Record<string, unknown> {
  return { ...r, payload_hash: r.payload_hash.toString('hex') };
}

export async function listApprovals(db: Db, ctx: Ctx, status = 'pending'): Promise<unknown[]> {
  requirePermission(ctx, 'content.read');
  const { rows } = await db.query<ApprovalRow>(
    `SELECT * FROM approvals.approval_requests WHERE status = $1 ORDER BY priority, created_at LIMIT 200`,
    [status],
  );
  return rows.filter((r) => !ctx.influencerScope || (r.influencer_id && ctx.influencerScope.has(r.influencer_id))).map(publicApproval);
}

export async function getApproval(db: Db, ctx: Ctx, id: string): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'content.read');
  const row = await maybeOne<ApprovalRow>(db, 'SELECT * FROM approvals.approval_requests WHERE id = $1', [id]);
  if (!row) throw notFound('Approval request', id);
  if (row.influencer_id) requireInfluencerAccess(ctx, row.influencer_id);
  const decisions = await db.query(
    `SELECT id, approver_user_id, decision, encode(payload_hash_seen, 'hex') AS payload_hash_seen, comment, decided_at
       FROM approvals.approval_decisions WHERE approval_request_id = $1 ORDER BY decided_at`,
    [id],
  );
  return { ...publicApproval(row), decisions: decisions.rows };
}

const ITEM_STATUS_AFTER: Record<string, string> = {
  approved: 'approved',
  rejected: 'rejected',
  changes_requested: 'changes_requested',
};

/**
 * Records a human decision. The reviewer must send the payload_hash they saw
 * (binding the decision to exactly that content), cannot be the requester, and
 * must give a reason when rejecting or requesting changes. The DB trigger
 * approvals.assert_valid_decision enforces the same rules as a backstop.
 */
export async function decide(
  db: Db,
  ctx: Ctx,
  approvalId: string,
  input: { decision: 'approve' | 'reject' | 'request_changes'; payload_hash: string; comment?: string | null },
): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'content.approve');
  if (!ctx.userId) throw forbidden('Only a human user can decide approval requests');
  const req = await maybeOne<ApprovalRow>(db, 'SELECT * FROM approvals.approval_requests WHERE id = $1 FOR UPDATE', [approvalId]);
  if (!req) throw notFound('Approval request', approvalId);
  if (req.influencer_id) requireInfluencerAccess(ctx, req.influencer_id);
  if (req.requested_by_type === 'user' && req.requested_by_id === ctx.userId) {
    throw forbidden('SELF_APPROVAL_FORBIDDEN: the requester cannot decide their own request');
  }
  if (req.status !== 'pending') throw conflict('APPROVAL_NOT_PENDING', `Approval request is ${req.status}`);
  if (req.expires_at <= new Date()) throw conflict('APPROVAL_EXPIRED', 'Approval request has expired');
  if (!/^[a-f0-9]{64}$/.test(input.payload_hash) || input.payload_hash !== req.payload_hash.toString('hex')) {
    throw conflict('PAYLOAD_HASH_MISMATCH', 'payload_hash does not match the request; reload the request and review the current payload');
  }
  if (input.decision !== 'approve' && !input.comment?.trim()) {
    throw badRequest('REASON_REQUIRED', 'A comment explaining the decision is required for reject and request_changes');
  }
  // Content approvals: the revision must still be the item's current revision.
  if (req.subject_type === 'content_revision') {
    const current = await maybeOne<{ current_revision_id: string | null }>(
      db,
      `SELECT ci.current_revision_id FROM content.content_items ci JOIN content.content_revisions cr ON cr.content_item_id = ci.id
        WHERE cr.id = $1`,
      [req.subject_id],
    );
    if (current?.current_revision_id !== req.subject_id) {
      throw conflict('REVISION_NOT_CURRENT', 'The revision was superseded by a newer one');
    }
  }
  const decisionId = uuidv7();
  try {
    await db.query(
      `INSERT INTO approvals.approval_decisions (id, workspace_id, approval_request_id, approver_user_id, decision, payload_hash_seen, comment)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [decisionId, ctx.workspaceId, approvalId, ctx.userId, input.decision, Buffer.from(input.payload_hash, 'hex'), input.comment ?? null],
    );
  } catch (err) {
    if (pgCode(err) === PG.uniqueViolation) throw conflict('ALREADY_DECIDED', 'You already decided this request');
    if (pgCode(err) === PG.checkViolation) throw new AppError(409, 'DECISION_REJECTED_BY_DATABASE', (err as Error).message);
    throw err;
  }
  let status = req.status;
  if (input.decision === 'reject') status = 'rejected';
  else if (input.decision === 'request_changes') status = 'changes_requested';
  else {
    const { n } = await one<{ n: number }>(
      db,
      `SELECT count(*)::int AS n FROM approvals.approval_decisions WHERE approval_request_id = $1 AND decision = 'approve'`,
      [approvalId],
    );
    if (n >= req.required_approvals) status = 'approved';
  }
  if (status !== req.status) {
    await db.query('UPDATE approvals.approval_requests SET status = $2, decided_at = now() WHERE id = $1', [approvalId, status]);
    if (req.subject_type === 'content_revision') {
      await db.query(
        `UPDATE content.content_items ci SET status = $2, updated_at = now()
           FROM content.content_revisions cr WHERE cr.id = $1 AND ci.id = cr.content_item_id`,
        [req.subject_id, ITEM_STATUS_AFTER[status]],
      );
    }
  }
  await auditCtx(db, ctx, {
    influencerId: req.influencer_id,
    action: `approval.${input.decision}`,
    subjectType: req.subject_type,
    subjectId: req.subject_id,
    approvalRequestId: approvalId,
    metadata: { decision_id: decisionId, comment: input.comment ?? null, payload_hash: input.payload_hash, resulting_status: status },
  });
  if (status !== req.status) {
    await outbox(db, {
      workspaceId: ctx.workspaceId,
      eventType: `approvals.${status}`,
      aggregateType: 'approval_request',
      aggregateId: approvalId,
      payload: { subject_type: req.subject_type, subject_id: req.subject_id },
    });
  }
  return getApproval(db, ctx, approvalId);
}
