import type pg from 'pg';
import type { Db } from '../../db/tx.js';
import { maybeOne, one, withTenant } from '../../db/tx.js';
import { canonicalize, canonicalSha256Hex } from '../../lib/canonical-json.js';
import { uuidv7 } from '../../lib/ids.js';
import type { Services } from '../../services.js';
import { raiseAlert } from '../alerts.js';
import { audit, outbox } from '../audit.js';
import { createContentItem, createRevision, loadContentItem, requestApproval } from '../content.js';
import type { Ctx } from '../context.js';
import { replyToComment } from '../../integrations/instagram/comments.js';
import type { PolicyResult } from './policy.js';

/**
 * Executor: the only path from a proposal to an effect. It runs the same
 * command handlers humans use, as an agent actor with exactly the permissions
 * the action needs, inside the tenant's row-level security.
 */
const ACTION_PERMISSIONS: Record<string, string[]> = {
  'content_plan.propose': ['influencer.read', 'content.create'],
  'caption.propose': ['influencer.read', 'content.read', 'content.create', 'content.submit'],
  'item.hold': ['content.read'],
  'comment.reply': ['comment.reply'],
};

function agentCtx(workspaceId: string, agentKey: string, proposalId: string, action: string): Ctx {
  return {
    workspaceId,
    actor: { type: 'agent', id: `${agentKey}:${proposalId}` },
    userId: null,
    permissions: new Set(ACTION_PERMISSIONS[action] ?? []),
    isPlatformAdmin: false,
    influencerScope: null,
    requestId: `proposal:${proposalId}`,
  };
}

interface ProposalRow {
  id: string;
  workspace_id: string;
  influencer_id: string;
  agent_key: string;
  action_type: string;
  payload: Record<string, unknown>;
  payload_hash: Buffer;
  rationale: string;
  risk_level: string;
  status: string;
  approval_request_id: string | null;
}

/** ALLOW → execute now; REQUIRE_APPROVAL → approval request bound to the payload hash; DENY → recorded only. */
export async function dispatchProposal(svc: Services, proposalId: string, policy: PolicyResult): Promise<Record<string, unknown>> {
  if (policy.decision === 'allow') return executeProposal(svc, proposalId);
  if (policy.decision === 'deny') return { status: 'denied' };
  const p = await one<ProposalRow>(svc.workerPool, 'SELECT * FROM agents.action_proposals WHERE id = $1', [proposalId]);
  const snapshot = { proposal_id: p.id, agent_key: p.agent_key, action_type: p.action_type, payload: p.payload, rationale: p.rationale };
  const approvalId = uuidv7();
  await svc.workerPool.query(
    `INSERT INTO approvals.approval_requests (id, workspace_id, influencer_id, subject_type, subject_id, action_type, risk_level, payload_snapshot, payload_hash,
       requested_by_type, requested_by_id, proposal_id, required_role, required_approvals, expires_at)
     VALUES ($1, $2, $3, 'agent_proposal', $4, $5, $6, $7, $8, 'agent', $9, $4, $10, $11, now() + interval '72 hours')`,
    [approvalId, p.workspace_id, p.influencer_id, p.id, p.action_type, p.risk_level, canonicalize(snapshot), Buffer.from(canonicalSha256Hex(snapshot), 'hex'), p.agent_key, policy.approverRole, policy.requiredApprovals],
  );
  await svc.workerPool.query(`UPDATE agents.action_proposals SET status = 'awaiting_approval', approval_request_id = $2 WHERE id = $1`, [p.id, approvalId]);
  await outbox(svc.workerPool as unknown as Db, {
    workspaceId: p.workspace_id,
    eventType: 'approvals.requested',
    aggregateType: 'approval_request',
    aggregateId: approvalId,
    payload: { subject_type: 'agent_proposal', subject_id: p.id },
  });
  return { status: 'awaiting_approval', approval_request_id: approvalId };
}

export async function executeProposal(svc: Services, proposalId: string): Promise<Record<string, unknown>> {
  const db = svc.workerPool;
  const claimed = await maybeOne<ProposalRow>(
    db,
    `UPDATE agents.action_proposals SET status = 'executed', executed_at = now() WHERE id = $1 AND status IN ('proposed', 'approved') RETURNING *`,
    [proposalId],
  );
  if (!claimed) return { status: 'not_executable' };
  const ctx = agentCtx(claimed.workspace_id, claimed.agent_key, claimed.id, claimed.action_type);
  try {
    const ref = await withTenant(svc.appPool, claimed.workspace_id, (tx) => apply(svc, tx, ctx, claimed));
    await db.query(`UPDATE agents.action_proposals SET execution_ref = $2 WHERE id = $1`, [proposalId, ref]);
    await audit(db as unknown as Db, {
      workspaceId: claimed.workspace_id,
      influencerId: claimed.influencer_id,
      actor: ctx.actor,
      action: 'agent_proposal.executed',
      subjectType: 'agent_proposal',
      subjectId: proposalId,
      proposalId,
      approvalRequestId: claimed.approval_request_id,
      metadata: { action_type: claimed.action_type, execution_ref: ref },
    });
    return { status: 'executed', execution_ref: ref };
  } catch (err) {
    await db.query(`UPDATE agents.action_proposals SET status = 'execution_failed', execution_error = $2 WHERE id = $1`, [proposalId, JSON.stringify({ message: (err as Error).message })]);
    await raiseAlert(db, {
      workspaceId: claimed.workspace_id,
      severity: 'warning',
      source: 'agents',
      code: 'PROPOSAL_EXECUTION_FAILED',
      dedupKey: `proposal_failed:${proposalId}`,
      message: `${claimed.action_type} proposed by ${claimed.agent_key} could not be executed: ${(err as Error).message}`,
      details: { proposal_id: proposalId },
    });
    return { status: 'execution_failed', error: (err as Error).message };
  }
}

async function apply(svc: Services, db: Db, ctx: Ctx, p: ProposalRow): Promise<string> {
  switch (p.action_type) {
    case 'content_plan.propose':
      return applyPlan(db, ctx, p);
    case 'caption.propose':
      return applyCaption(db, ctx, p);
    case 'item.hold':
      await holdContentItem(db, ctx.actor, String(p.payload.content_item_id), String(p.payload.reason));
      return `content_item:${String(p.payload.content_item_id)}`;
    case 'comment.reply':
      return (await replyToComment(svc, db, ctx, String(p.payload.comment_id), String(p.payload.body))).action_id;
    default:
      throw new Error(`no executor for ${p.action_type}`);
  }
}

async function applyPlan(db: Db, ctx: Ctx, p: ProposalRow): Promise<string> {
  const pl = p.payload as { period_start: string; period_end: string; strategy_notes: string; items: { planned_for: string; format: string; theme: string; brief: Record<string, unknown> }[] };
  const planId = uuidv7();
  await db.query(
    `INSERT INTO content.content_plans (id, workspace_id, influencer_id, period_start, period_end, status, strategy_notes, created_by_type, created_by_id, approval_request_id)
     VALUES ($1, $2, $3, $4, $5, 'approved', $6, 'agent', $7, $8)`,
    [planId, ctx.workspaceId, p.influencer_id, pl.period_start, pl.period_end, pl.strategy_notes, p.agent_key, p.approval_request_id],
  );
  await db.query(
    `UPDATE content.content_plans SET status = 'superseded' WHERE influencer_id = $1 AND id <> $2 AND status IN ('draft', 'pending_approval', 'approved')
        AND period_start = $3 AND period_end = $4`,
    [p.influencer_id, planId, pl.period_start, pl.period_end],
  );
  for (const it of pl.items) {
    if (new Date(it.planned_for).getTime() < Date.now()) continue; // never plan into the past
    const item = await createContentItem(db, ctx, p.influencer_id, { format: it.format, planned_for: it.planned_for, brief: { theme: it.theme, ...it.brief } });
    await db.query('UPDATE content.content_items SET plan_id = $2 WHERE id = $1', [item.id, planId]);
  }
  return `content_plan:${planId}`;
}

/** A caption becomes a new revision (same assets) submitted for human approval; QA reviews it on submission. */
async function applyCaption(db: Db, ctx: Ctx, p: ProposalRow): Promise<string> {
  const pl = p.payload as { content_item_id: string; caption: string; hashtags: string[]; alt_text?: string };
  const item = await loadContentItem(db, ctx, pl.content_item_id);
  if (!item.current_revision_id) {
    await db.query(`UPDATE content.content_items SET brief = coalesce(brief, '{}'::jsonb) || jsonb_build_object('caption_draft', $2::jsonb), updated_at = now() WHERE id = $1`, [
      item.id,
      JSON.stringify({ caption: pl.caption, hashtags: pl.hashtags, alt_text: pl.alt_text ?? null, proposal_id: p.id }),
    ]);
    return `content_item:${item.id}:caption_draft`;
  }
  const assets = await db.query<{ media_asset_id: string; role: 'primary' | 'carousel' | 'cover' | 'teaser' | 'full' }>(
    'SELECT media_asset_id, role FROM content.revision_assets WHERE revision_id = $1 ORDER BY position',
    [item.current_revision_id],
  );
  const rev = await createRevision(db, ctx, item.id, {
    caption: pl.caption,
    hashtags: pl.hashtags.map((h) => h.replace(/^#/, '')),
    alt_text: pl.alt_text ?? null,
    assets: assets.rows,
  });
  await requestApproval(db, ctx, String(rev.id), 72);
  return `content_revision:${String(rev.id)}`;
}

/** QA hold: pending approvals for the item are cancelled and the item goes back to rework. */
export async function holdContentItem(db: Db | pg.Pool, actor: Ctx['actor'], itemId: string, reason: string): Promise<void> {
  const item = await one<{ workspace_id: string; influencer_id: string }>(db, 'SELECT workspace_id, influencer_id FROM content.content_items WHERE id = $1', [itemId]);
  const cancelled = await db.query<{ id: string }>(
    `UPDATE approvals.approval_requests ar SET status = 'cancelled', decided_at = now()
       FROM content.content_revisions cr
      WHERE ar.subject_type = 'content_revision' AND ar.subject_id = cr.id AND cr.content_item_id = $1 AND ar.status = 'pending' RETURNING ar.id`,
    [itemId],
  );
  await db.query(`UPDATE content.content_items SET status = 'needs_rework', updated_at = now() WHERE id = $1 AND status NOT IN ('published', 'scheduled', 'archived')`, [itemId]);
  await audit(db as Db, {
    workspaceId: item.workspace_id,
    influencerId: item.influencer_id,
    actor,
    action: 'content.qa_hold',
    subjectType: 'content_item',
    subjectId: itemId,
    metadata: { reason, cancelled_approvals: cancelled.rows.map((r) => r.id) },
  });
  await raiseAlert(db, {
    workspaceId: item.workspace_id,
    severity: 'warning',
    source: 'qa',
    code: 'CONTENT_QA_HOLD',
    dedupKey: `qa_hold:${itemId}`,
    message: `Automated QA held a content item: ${reason.slice(0, 200)}`,
    details: { content_item_id: itemId },
  });
}

/** Applies a human decision on an agent proposal (outbox → job `agents.apply_approval`). */
export async function applyApprovalDecision(svc: Services, ev: { event_type: string; payload: { subject_type: string; subject_id: string } }): Promise<unknown> {
  if (ev.payload.subject_type !== 'agent_proposal') return { skipped: 'not_agent_proposal' };
  const id = ev.payload.subject_id;
  if (ev.event_type === 'approvals.approved') {
    await svc.workerPool.query(`UPDATE agents.action_proposals SET status = 'approved' WHERE id = $1 AND status = 'awaiting_approval'`, [id]);
    const out = await executeProposal(svc, id);
    await svc.workerPool.query(
      `UPDATE agents.tasks t SET status = 'succeeded', updated_at = now() FROM agents.runs r, agents.action_proposals p
        WHERE p.id = $1 AND r.id = p.run_id AND t.id = r.task_id AND t.status = 'waiting_approval'
          AND NOT EXISTS (SELECT 1 FROM agents.action_proposals q WHERE q.run_id = r.id AND q.status = 'awaiting_approval')`,
      [id],
    );
    return out;
  }
  await svc.workerPool.query(`UPDATE agents.action_proposals SET status = 'rejected' WHERE id = $1 AND status = 'awaiting_approval'`, [id]);
  return { status: 'rejected' };
}
