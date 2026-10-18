import type { Db } from '../../db/tx.js';
import { maybeOne, one } from '../../db/tx.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { uuidv7 } from '../../lib/ids.js';
import type { Registry } from '../../registry.js';
import type { Services } from '../../services.js';
import { auditCtx } from '../audit.js';
import { type Ctx, requireInfluencerAccess, requirePermission } from '../context.js';
import { enqueue, PRIORITY } from '../jobs-queue.js';
import { ACTIONS } from './catalog.js';
import { AGENT_SPECS, specFor } from './definitions.js';
import { applyApprovalDecision } from './executor.js';
import { reviewApproval } from './qa.js';
import { runAgentTask } from './runner.js';

/**
 * Staff operations for the agent system: enabling agents per workspace,
 * running tasks, inspecting runs and proposals, autonomy policies (four-eyes)
 * and kill switches, and the content calendar.
 */
export async function enableAgents(db: Db, ctx: Ctx, keys: string[]): Promise<unknown[]> {
  requirePermission(ctx, 'agent.manage');
  if (!ctx.userId) throw forbidden('A signed-in user must enable agents');
  const out = [];
  for (const key of keys) {
    const spec = specFor(key);
    if (!spec) throw badRequest('UNKNOWN_AGENT', `Unknown agent ${key}`);
    const tv = await one<{ v: number }>(db, `SELECT coalesce(max(version), 0) + 1 AS v FROM content.prompt_templates WHERE workspace_id = $1 AND key = $2`, [ctx.workspaceId, `agent.${key}`]);
    const templateId = uuidv7();
    await db.query(
      `INSERT INTO content.prompt_templates (id, workspace_id, key, version, purpose, body, status, created_by, approved_by) VALUES ($1, $2, $3, $4, 'agent_system', $5, 'active', $6, $6)`,
      [templateId, ctx.workspaceId, `agent.${key}`, tv.v, spec.systemPrompt, ctx.userId],
    );
    await db.query(`UPDATE content.prompt_templates SET status = 'retired' WHERE workspace_id = $1 AND key = $2 AND id <> $3 AND status = 'active'`, [ctx.workspaceId, `agent.${key}`, templateId]);
    const dv = await one<{ v: number }>(db, `SELECT coalesce(max(version), 0) + 1 AS v FROM agents.agent_definitions WHERE workspace_id = $1 AND key = $2`, [ctx.workspaceId, key]);
    await db.query(`UPDATE agents.agent_definitions SET status = 'retired' WHERE workspace_id = $1 AND key = $2 AND status = 'active'`, [ctx.workspaceId, key]);
    const def = await one(
      db,
      `INSERT INTO agents.agent_definitions (id, workspace_id, key, version, status, model, effort, system_prompt_template_id, tools, output_schema,
         allowed_action_types, max_autonomy_level, budgets, approved_by)
       VALUES ($1, $2, $3, $4, 'active', 'configured:chat', 'standard', $5, '[]', $6, $7, $8, $9, $10)
       RETURNING id, key, version, status, allowed_action_types, max_autonomy_level, budgets`,
      [uuidv7(), ctx.workspaceId, key, dv.v, templateId, JSON.stringify({ envelope: 'docs/06 §3 output contract' }), spec.allowedActions, spec.maxLevel, JSON.stringify(spec.budgets), ctx.userId],
    );
    await auditCtx(db, ctx, { action: 'agent.enable', subjectType: 'agent_definition', subjectId: String((def as { id: string }).id), metadata: { key, version: dv.v } });
    out.push(def);
  }
  return out;
}

export async function listAgents(db: Db, ctx: Ctx): Promise<unknown> {
  requirePermission(ctx, 'proposal.read');
  const { rows } = await db.query(
    `SELECT d.id, d.key, d.version, d.status, d.allowed_action_types, d.max_autonomy_level, d.budgets, d.created_at
       FROM agents.agent_definitions d WHERE d.workspace_id = $1 ORDER BY d.key, d.version DESC`,
    [ctx.workspaceId],
  );
  return { available: Object.values(AGENT_SPECS).map((s) => ({ key: s.key, title: s.title, actions: s.allowedActions, max_level: s.maxLevel })), definitions: rows, actions: ACTIONS };
}

export async function createAgentTask(db: Db, ctx: Ctx, influencerId: string, input: { agent_key: string; task_type?: string; input: Record<string, unknown> }): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'agent.run');
  requireInfluencerAccess(ctx, influencerId);
  const spec = specFor(input.agent_key);
  if (!spec || input.agent_key === 'qa_compliance') throw badRequest('UNKNOWN_AGENT', `Agent ${input.agent_key} cannot be run as a task`);
  const def = await maybeOne(db, `SELECT 1 FROM agents.agent_definitions WHERE workspace_id = $1 AND key = $2 AND status = 'active'`, [ctx.workspaceId, input.agent_key]);
  if (!def) throw conflict('AGENT_NOT_ENABLED', `Enable the ${input.agent_key} agent first`);
  if (input.agent_key === 'content_strategist') {
    const { period_start, period_end } = input.input as { period_start?: string; period_end?: string };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(period_start ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(period_end ?? '') || period_end! < period_start!) {
      throw badRequest('INVALID_PERIOD', 'period_start and period_end (YYYY-MM-DD) are required');
    }
  }
  if (input.agent_key === 'social_media') {
    const item = await maybeOne(db, 'SELECT 1 FROM content.content_items WHERE id = $1 AND influencer_id = $2', [input.input.content_item_id, influencerId]);
    if (!item) throw unprocessable('ITEM_NOT_FOUND', 'content_item_id must be a content item of this influencer');
  }
  const id = uuidv7();
  await db.query(
    `INSERT INTO agents.tasks (id, workspace_id, influencer_id, agent_key, task_type, input, requested_by_type, requested_by_id, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, 'user', $7, $8)`,
    [id, ctx.workspaceId, influencerId, input.agent_key, input.task_type ?? 'adhoc', JSON.stringify(input.input), ctx.userId ?? ctx.actor.id, `task:${id}`],
  );
  await enqueue(db, { workspaceId: ctx.workspaceId, queue: 'background', name: 'agents.run_task', key: `agent_task:${id}`, payload: { task_id: id }, priority: PRIORITY.default, maxAttempts: 4 });
  await auditCtx(db, ctx, { influencerId, action: 'agent.task_create', subjectType: 'agent_task', subjectId: id, metadata: { agent_key: input.agent_key } });
  return { id, status: 'queued' };
}

export async function listRuns(db: Db, ctx: Ctx, influencerId: string): Promise<unknown[]> {
  requirePermission(ctx, 'proposal.read');
  requireInfluencerAccess(ctx, influencerId);
  const { rows } = await db.query(
    `SELECT r.id, r.status, r.model, r.input_tokens, r.output_tokens, r.error, r.started_at, r.ended_at, d.key AS agent_key, t.task_type, t.input AS task_input,
            (SELECT count(*)::int FROM agents.action_proposals p WHERE p.run_id = r.id) AS proposals
       FROM agents.runs r JOIN agents.agent_definitions d ON d.id = r.agent_definition_id LEFT JOIN agents.tasks t ON t.id = r.task_id
      WHERE r.influencer_id = $1 ORDER BY r.started_at DESC LIMIT 200`,
    [influencerId],
  );
  return rows;
}

export async function listProposals(db: Db, ctx: Ctx, q: { status?: string; influencer_id?: string }): Promise<unknown[]> {
  requirePermission(ctx, 'proposal.read');
  if (q.influencer_id) requireInfluencerAccess(ctx, q.influencer_id);
  const scope = ctx.influencerScope ? [...ctx.influencerScope] : null;
  const { rows } = await db.query(
    `SELECT id, influencer_id, run_id, agent_key, action_type, payload, rationale, confidence, risk_level, resolved_level, policy_decision, status,
            approval_request_id, executed_at, execution_ref, execution_error, created_at
       FROM agents.action_proposals WHERE ($1::text IS NULL OR status = $1) AND ($2::uuid IS NULL OR influencer_id = $2) AND ($3::uuid[] IS NULL OR influencer_id = ANY($3))
      ORDER BY created_at DESC LIMIT 300`,
    [q.status ?? null, q.influencer_id ?? null, scope],
  );
  return rows;
}

export async function getProposal(db: Db, ctx: Ctx, id: string): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'proposal.read');
  const p = await maybeOne<{ influencer_id: string; payload_hash: Buffer; run_id: string }>(db, 'SELECT * FROM agents.action_proposals WHERE id = $1', [id]);
  if (!p) throw notFound('Proposal', id);
  requireInfluencerAccess(ctx, p.influencer_id);
  const steps = await db.query('SELECT seq, step_type, input, output, latency_ms, created_at FROM agents.run_steps WHERE run_id = $1 ORDER BY seq', [p.run_id]);
  return { ...p, payload_hash: p.payload_hash.toString('hex'), run_steps: steps.rows };
}

// -----------------------------------------------------------------------------
// Autonomy policies: drafted by an admin, activated by a second person
// -----------------------------------------------------------------------------
export async function createAutonomyPolicy(
  db: Db,
  ctx: Ctx,
  input: { influencer_id?: string | null; action_type: string; agent_key?: string | null; level: number; conditions?: Record<string, unknown>; required_approver_role?: string | null; required_approvals?: number },
): Promise<unknown> {
  requirePermission(ctx, 'autonomy.manage');
  const spec = ACTIONS[input.action_type];
  if (!spec) throw badRequest('UNKNOWN_ACTION', `Unknown action ${input.action_type}`);
  if (input.level > spec.maxLevel) throw unprocessable('LEVEL_ABOVE_CEILING', `${input.action_type} can never exceed L${spec.maxLevel}`);
  if (input.influencer_id) requireInfluencerAccess(ctx, input.influencer_id);
  const row = await one<{ id: string }>(
    db,
    `INSERT INTO agents.autonomy_policies (id, workspace_id, influencer_id, action_type, agent_key, level, conditions, required_approver_role, required_approvals, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft', $10) RETURNING *`,
    [uuidv7(), ctx.workspaceId, input.influencer_id ?? null, input.action_type, input.agent_key ?? null, input.level, JSON.stringify(input.conditions ?? {}), input.required_approver_role ?? null, input.required_approvals ?? 1, ctx.userId],
  );
  await auditCtx(db, ctx, { influencerId: input.influencer_id ?? null, action: 'autonomy_policy.create', subjectType: 'autonomy_policy', subjectId: row.id, changes: { after: input } });
  return row;
}

export async function approveAutonomyPolicy(db: Db, ctx: Ctx, id: string): Promise<unknown> {
  requirePermission(ctx, 'autonomy.approve');
  const p = await maybeOne<{ status: string; created_by: string | null; workspace_id: string; influencer_id: string | null; action_type: string; agent_key: string | null }>(
    db,
    'SELECT status, created_by, workspace_id, influencer_id, action_type, agent_key FROM agents.autonomy_policies WHERE id = $1',
    [id],
  );
  if (!p) throw notFound('Autonomy policy', id);
  if (p.status !== 'draft') throw conflict('INVALID_STATE', `Policy is ${p.status}`);
  if (p.created_by && p.created_by === ctx.userId) throw forbidden('Autonomy changes need a second person (four-eyes)');
  await db.query(
    `UPDATE agents.autonomy_policies SET status = 'retired', effective_to = now()
      WHERE workspace_id = $1 AND influencer_id IS NOT DISTINCT FROM $2 AND action_type = $3 AND agent_key IS NOT DISTINCT FROM $4 AND status = 'active'`,
    [p.workspace_id, p.influencer_id, p.action_type, p.agent_key],
  );
  const row = await one(db, `UPDATE agents.autonomy_policies SET status = 'active', approved_by = $2, approved_at = now(), effective_from = now() WHERE id = $1 RETURNING *`, [id, ctx.userId]);
  await auditCtx(db, ctx, { influencerId: p.influencer_id, action: 'autonomy_policy.approve', subjectType: 'autonomy_policy', subjectId: id });
  return row;
}

export async function retireAutonomyPolicy(db: Db, ctx: Ctx, id: string): Promise<unknown> {
  requirePermission(ctx, 'autonomy.manage');
  const row = await maybeOne(db, `UPDATE agents.autonomy_policies SET status = 'retired', effective_to = now() WHERE id = $1 AND status <> 'retired' RETURNING *`, [id]);
  if (!row) throw notFound('Autonomy policy', id);
  await auditCtx(db, ctx, { action: 'autonomy_policy.retire', subjectType: 'autonomy_policy', subjectId: id });
  return row;
}

export async function listAutonomyPolicies(db: Db, ctx: Ctx): Promise<unknown[]> {
  requirePermission(ctx, 'proposal.read');
  const { rows } = await db.query(`SELECT * FROM agents.autonomy_policies WHERE workspace_id = $1 ORDER BY status, action_type, created_at DESC`, [ctx.workspaceId]);
  return rows;
}

const SWITCHES = ['autonomy', 'conversations', 'publishing'] as const;

/** Kill switches (docs/09): stop agent autonomy, AI conversations or publishing for a workspace or one influencer. */
export async function setKillSwitch(db: Db, ctx: Ctx, input: { key: (typeof SWITCHES)[number]; influencer_id?: string | null; enabled: boolean }): Promise<unknown> {
  requirePermission(ctx, 'killswitch.manage');
  if (!SWITCHES.includes(input.key)) throw badRequest('UNKNOWN_SWITCH', `Unknown kill switch ${input.key}`);
  if (input.influencer_id) requireInfluencerAccess(ctx, input.influencer_id);
  const row = await one(
    db,
    `INSERT INTO core.feature_flags (workspace_id, influencer_id, key, value, updated_by) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (workspace_id, influencer_id, key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING workspace_id, influencer_id, key, value, updated_at`,
    [ctx.workspaceId, input.influencer_id ?? null, `kill_switch.${input.key}`, JSON.stringify(input.enabled), ctx.userId],
  );
  await auditCtx(db, ctx, { influencerId: input.influencer_id ?? null, action: `kill_switch.${input.enabled ? 'on' : 'off'}`, subjectType: 'feature_flag', subjectId: `kill_switch.${input.key}` });
  return row;
}

export async function listKillSwitches(db: Db, ctx: Ctx): Promise<unknown[]> {
  requirePermission(ctx, 'proposal.read');
  const { rows } = await db.query(`SELECT workspace_id, influencer_id, key, value, updated_at FROM core.feature_flags WHERE workspace_id = $1 AND key LIKE 'kill_switch.%'`, [ctx.workspaceId]);
  return rows;
}

// -----------------------------------------------------------------------------
// Content calendar
// -----------------------------------------------------------------------------
export async function calendar(db: Db, ctx: Ctx, influencerId: string, from: string, to: string): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'content.read');
  requireInfluencerAccess(ctx, influencerId);
  const items = await db.query(
    `SELECT ci.id, ci.format, ci.status, ci.planned_for, ci.plan_id, ci.brief, cr.caption, cr.hashtags,
            coalesce((SELECT json_agg(json_build_object('id', p.id, 'channel_id', p.channel_id, 'kind', c.kind, 'status', p.status, 'scheduled_for', p.scheduled_for,
                                                        'published_at', p.published_at, 'permalink', p.permalink) ORDER BY p.scheduled_for)
                        FROM publishing.publications p JOIN publishing.channels c ON c.id = p.channel_id WHERE p.content_item_id = ci.id), '[]') AS publications,
            (SELECT verdict FROM approvals.qa_reviews q WHERE q.subject_id = ci.current_revision_id ORDER BY created_at DESC LIMIT 1) AS qa_verdict
       FROM content.content_items ci LEFT JOIN content.content_revisions cr ON cr.id = ci.current_revision_id
      WHERE ci.influencer_id = $1 AND ci.status <> 'archived'
        AND (ci.planned_for::date BETWEEN $2 AND $3
             OR EXISTS (SELECT 1 FROM publishing.publications p WHERE p.content_item_id = ci.id AND p.scheduled_for::date BETWEEN $2 AND $3))
      ORDER BY coalesce(ci.planned_for, (SELECT min(scheduled_for) FROM publishing.publications p WHERE p.content_item_id = ci.id))`,
    [influencerId, from, to],
  );
  const plans = await db.query(
    `SELECT id, period_start, period_end, status, strategy_notes, created_by_type, created_by_id FROM content.content_plans
      WHERE influencer_id = $1 AND period_end >= $2 AND period_start <= $3 AND status <> 'superseded' ORDER BY period_start`,
    [influencerId, from, to],
  );
  return { from, to, plans: plans.rows, items: items.rows };
}

// -----------------------------------------------------------------------------
// Scheduling and wiring
// -----------------------------------------------------------------------------
function zonedParts(tz: string, d = new Date()): { date: string; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, weekday: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday')) };
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** From Thursday on, plan next Monday–Sunday for every active influencer whose workspace enabled the strategist. */
export async function scheduleWeeklyPlanning(svc: Services, now = new Date()): Promise<{ created: number }> {
  const db = svc.workerPool;
  const { rows } = await db.query<{ id: string; workspace_id: string; timezone: string }>(
    `SELECT i.id, i.workspace_id, i.timezone FROM identity.influencers i JOIN identity.persona_runtime_config rc ON rc.influencer_id = i.id
      WHERE i.status = 'active' AND NOT rc.paused
        AND EXISTS (SELECT 1 FROM agents.agent_definitions d WHERE d.workspace_id = i.workspace_id AND d.key = 'content_strategist' AND d.status = 'active')`,
  );
  let created = 0;
  for (const inf of rows) {
    const { date, weekday } = zonedParts(inf.timezone, now);
    if (weekday < 3) continue;
    const monday = addDays(date, 7 - weekday);
    const key = `weekly_plan:${inf.id}:${monday}`;
    const id = uuidv7();
    const ins = await db.query(
      `INSERT INTO agents.tasks (id, workspace_id, influencer_id, agent_key, task_type, input, requested_by_type, requested_by_id, idempotency_key)
       VALUES ($1, $2, $3, 'content_strategist', 'weekly_plan', $4, 'schedule', 'agents.weekly_planning', $5) ON CONFLICT (idempotency_key) DO NOTHING`,
      [id, inf.workspace_id, inf.id, JSON.stringify({ period_start: monday, period_end: addDays(monday, 6), posts: 7 }), key],
    );
    if (!ins.rowCount) continue;
    await enqueue(db, { workspaceId: inf.workspace_id, queue: 'background', name: 'agents.run_task', key: `agent_task:${id}`, payload: { task_id: id }, priority: PRIORITY.default, maxAttempts: 4 });
    created++;
  }
  return { created };
}

export function agentsContribution(svc: Services, r: Registry): void {
  r.handlers.set('agents.run_task', (job) => runAgentTask(svc, String(job.payload.task_id)));
  r.handlers.set('agents.apply_approval', (job) => applyApprovalDecision(svc, job.payload as Parameters<typeof applyApprovalDecision>[1]));
  r.handlers.set('qa.review_approval', (job) => reviewApproval(svc, String(job.payload.aggregate_id)));
  r.subscriptions.push({ event: 'approvals.requested', job: 'qa.review_approval', queue: 'background', priority: PRIORITY.default });
  for (const event of ['approvals.approved', 'approvals.rejected', 'approvals.changes_requested']) {
    r.subscriptions.push({ event, job: 'agents.apply_approval', queue: 'background', priority: PRIORITY.default });
  }
  r.periodic.push({ name: 'agents.weekly_planning', intervalSeconds: 3600, run: () => scheduleWeeklyPlanning(svc) });
}
