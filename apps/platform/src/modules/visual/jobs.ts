import type pg from 'pg';
import { type ErrorObject, PRIORITY_OF_CLASS, type PriorityClass, isRetryableClass } from '../../contract/types.js';
import type { ContractValidator } from '../../contract/validator.js';
import type { Db } from '../../db/tx.js';
import { maybeOne, one } from '../../db/tx.js';
import { canonicalSha256Hex } from '../../lib/canonical-json.js';
import { PG, conflict, notFound, pgCode, unprocessable } from '../../lib/errors.js';
import { uuidv7 } from '../../lib/ids.js';
import { audit, auditCtx, outbox } from '../audit.js';
import { type Actor, type Ctx, actorRef, requireInfluencerAccess, requirePermission } from '../context.js';
import { type JobState, canTransition, retryDelayMs } from './state-machine.js';
import { type WorkflowRow, isUsable, resolveWorkflowVersion } from './workflows.js';

/** Actor for background visual job processing. */
export const WORKER_ACTOR: Actor = { type: 'system', id: 'visual-worker' };

export interface JobRow {
  id: string;
  workspace_id: string;
  influencer_id: string;
  persona_version_id: string;
  content_item_id: string | null;
  binding_id: string | null;
  workflow_id: string;
  workflow_key: string;
  workflow_version: string;
  engine_id: string | null;
  engine_kind: 'comfyui' | 'contract_mock' | 'other' | null;
  request_id: string;
  attempt: number;
  max_attempts: number;
  priority_class: PriorityClass;
  priority: number;
  parameters: Record<string, unknown>;
  references: { asset_id: string; role: string }[];
  persona_reference_ids: string[];
  adapter_ids: string[];
  output_count: number;
  timeout_s: number;
  deadline_at: Date | null;
  state: JobState;
  not_before: Date;
  engine_job_id: string | null;
  engine_state: string | null;
  progress: Record<string, unknown> | null;
  submission: Record<string, unknown> | null;
  submission_sha256: string | null;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  dispatched_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  last_polled_at: Date | null;
  error: (ErrorObject & Record<string, unknown>) | null;
  error_code: string | null;
  error_class: string | null;
  resource_usage: Record<string, unknown> | null;
  gpu_seconds: number;
  wall_seconds: number;
  output_asset_ids: string[];
  requested_by_type: 'user' | 'agent' | 'system' | 'schedule';
  requested_by_id: string;
  agent_run_id: string | null;
  idempotency_key: string;
  request_hash: string;
  trace_id: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Job as returned by the API: the stored submission (with signed URLs) is omitted. */
export function publicJob(job: JobRow): Omit<JobRow, 'submission' | 'lease_owner' | 'lease_expires_at'> & { validation_scope: string } {
  const { submission: _s, lease_owner: _l, lease_expires_at: _e, ...rest } = job;
  return {
    ...rest,
    // Contract-mock output proves the platform workflow only; it is never a real-engine validation.
    validation_scope: job.engine_kind === null ? 'not_dispatched' : job.engine_kind === 'contract_mock' ? 'contract_mock' : 'real_engine',
  };
}

// -----------------------------------------------------------------------------
// Events and transitions
// -----------------------------------------------------------------------------

export async function recordEvent(
  db: Db | pg.Pool,
  job: Pick<JobRow, 'id' | 'workspace_id' | 'attempt' | 'engine_job_id'>,
  e: { type: string; from?: JobState | null; to?: JobState | null; actor: Actor | { type: 'engine'; id: string }; details?: Record<string, unknown>; attempt?: number },
): Promise<void> {
  await db.query(
    `INSERT INTO inference.visual_job_events (workspace_id, visual_job_id, event_type, from_state, to_state, attempt,
       engine_job_id, actor_type, actor_id, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      job.workspace_id,
      job.id,
      e.type,
      e.from ?? null,
      e.to ?? null,
      e.attempt ?? job.attempt,
      job.engine_job_id,
      e.actor.type,
      e.actor.id,
      JSON.stringify(e.details ?? {}),
    ],
  );
}

const JSON_COLUMNS = new Set(['progress', 'error', 'resource_usage', 'submission', 'parameters', 'references']);

type Patch = Partial<Record<keyof JobRow, unknown>>;

/**
 * Conditional state transition (optimistic: WHERE state = current). Returns the
 * updated row, or null if another process changed the job first. Writes the
 * transition event in the same statement batch.
 */
export async function transition(
  db: Db | pg.Pool,
  job: JobRow,
  to: JobState,
  patch: Patch,
  event: { type: string; actor: Actor | { type: 'engine'; id: string }; details?: Record<string, unknown> },
): Promise<JobRow | null> {
  if (job.state !== to && !canTransition(job.state, to)) {
    throw new Error(`illegal visual job transition ${job.state} → ${to} (job ${job.id})`);
  }
  const sets = ['state = $3', 'updated_at = now()'];
  const params: unknown[] = [job.id, job.state, to];
  for (const [col, value] of Object.entries(patch)) {
    params.push(value !== null && JSON_COLUMNS.has(col) ? JSON.stringify(value) : value);
    sets.push(`${col === 'references' ? '"references"' : col} = $${params.length}`);
  }
  const res = await db.query<JobRow>(
    `UPDATE inference.visual_jobs SET ${sets.join(', ')} WHERE id = $1 AND state = $2 RETURNING *`,
    params,
  );
  const updated = res.rows[0];
  if (!updated) return null;
  await recordEvent(db, { ...updated, attempt: job.attempt }, { ...event, from: job.state, to, attempt: job.attempt });
  return updated;
}

/** Side effects of reaching a terminal state: content item status, audit, outbox. */
export async function onTerminal(db: Db | pg.Pool, job: JobRow, actor: Actor): Promise<void> {
  if (job.content_item_id) {
    if (job.state === 'failed') {
      await db.query(
        `UPDATE content.content_items SET status = 'needs_rework', updated_at = now()
          WHERE id = $1 AND status IN ('generating', 'validating')`,
        [job.content_item_id],
      );
    } else if (job.state === 'succeeded') {
      const valid = await db.query(`SELECT 1 FROM content.media_assets WHERE id = ANY($1::uuid[]) AND status = 'valid'`, [job.output_asset_ids]);
      await db.query(
        `UPDATE content.content_items SET status = $2, updated_at = now()
          WHERE id = $1 AND status IN ('generating', 'validating', 'needs_rework')`,
        [job.content_item_id, valid.rowCount && valid.rowCount > 0 ? 'ready_for_review' : 'needs_rework'],
      );
    }
  }
  await audit(db as Db, {
    workspaceId: job.workspace_id,
    influencerId: job.influencer_id,
    actor,
    action: `visual_job.${job.state}`,
    subjectType: 'visual_job',
    subjectId: job.id,
    traceId: job.trace_id,
    metadata: {
      workflow: `${job.workflow_key}@${job.workflow_version}`,
      attempt: job.attempt,
      engine_id: job.engine_id,
      engine_kind: job.engine_kind,
      error: job.error,
      output_asset_ids: job.output_asset_ids,
      gpu_seconds: job.gpu_seconds,
    },
  });
  await outbox(db as Db, {
    workspaceId: job.workspace_id,
    eventType: `visual.job_${job.state}`,
    aggregateType: 'visual_job',
    aggregateId: job.id,
    payload: { influencer_id: job.influencer_id, content_item_id: job.content_item_id, output_asset_ids: job.output_asset_ids },
  });
}

/**
 * Ends the current attempt with a classified error: schedules attempt+1 with
 * backoff when the class is retryable and attempts remain (contract §8),
 * otherwise fails the job.
 */
export async function failAttempt(
  db: Db | pg.Pool,
  job: JobRow,
  error: ErrorObject,
  actor: Actor,
  policy: { baseMs: number; maxMs: number },
  usage: { gpuSeconds?: number | null; wallSeconds?: number | null; resourceUsage?: unknown } = {},
): Promise<JobRow | null> {
  const now = Date.now();
  const deadlinePassed = job.deadline_at !== null && job.deadline_at.getTime() <= now;
  const retry = isRetryableClass(error.class) && error.retryable !== false && job.attempt < job.max_attempts && !deadlinePassed;
  const common: Patch = {
    error,
    error_code: error.code,
    error_class: error.class,
    lease_owner: null,
    lease_expires_at: null,
    gpu_seconds: job.gpu_seconds + (usage.gpuSeconds ?? 0),
    wall_seconds: job.wall_seconds + (usage.wallSeconds ?? 0),
    ...(usage.resourceUsage !== undefined ? { resource_usage: usage.resourceUsage } : {}),
  };
  if (retry) {
    const delay = retryDelayMs(job.attempt, policy, error.retry_after_ms);
    return transition(
      db,
      job,
      'queued',
      {
        ...common,
        attempt: job.attempt + 1,
        submission: null,
        submission_sha256: null,
        engine_id: null,
        engine_job_id: null,
        engine_state: null,
        progress: null,
        dispatched_at: null,
        not_before: new Date(now + delay),
      },
      { type: 'retry_scheduled', actor, details: { error, next_attempt: job.attempt + 1, delay_ms: delay } },
    );
  }
  const failed = await transition(
    db,
    job,
    'failed',
    { ...common, finished_at: new Date(now) },
    {
      type: 'failed',
      actor,
      details: { error, reason: deadlinePassed ? 'deadline_passed' : job.attempt >= job.max_attempts && isRetryableClass(error.class) ? 'attempts_exhausted' : 'terminal_error' },
    },
  );
  if (failed) await onTerminal(db, failed, actor);
  return failed;
}

// -----------------------------------------------------------------------------
// Creation
// -----------------------------------------------------------------------------

export interface CreateJobInput {
  idempotency_key: string;
  purpose?: string;
  workflow?: { key: string; version_range: string };
  parameters?: Record<string, unknown>;
  references?: { asset_id: string; role: string }[];
  output_count?: number;
  priority_class?: PriorityClass;
  content_item_id?: string | null;
  deadline_at?: string | null;
  use_adapters?: boolean;
}

export async function createVisualJob(
  db: Db,
  ctx: Ctx,
  validator: ContractValidator,
  limits: { maxAttempts: number; jobTimeoutCapSeconds: number },
  influencerId: string,
  input: CreateJobInput,
): Promise<{ job: JobRow; replayed: boolean }> {
  requirePermission(ctx, 'visual_job.create');
  requireInfluencerAccess(ctx, influencerId);
  if ((input.purpose ? 1 : 0) + (input.workflow ? 1 : 0) !== 1) {
    throw unprocessable('WORKFLOW_SELECTION', 'Provide exactly one of purpose (binding) or workflow {key, version_range}');
  }
  const requestHash = canonicalSha256Hex({ influencer_id: influencerId, ...input });
  const existing = await maybeOne<JobRow>(db, 'SELECT * FROM inference.visual_jobs WHERE workspace_id = $1 AND idempotency_key = $2', [
    ctx.workspaceId,
    input.idempotency_key,
  ]);
  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw conflict('IDEMPOTENCY_CONFLICT', 'idempotency_key was already used with a different request', { visual_job_id: existing.id });
    }
    return { job: existing, replayed: true };
  }

  const influencer = await maybeOne<{ id: string; status: string; active_persona_version_id: string | null; paused: boolean | null }>(
    db,
    `SELECT i.id, i.status, i.active_persona_version_id, rc.paused
       FROM identity.influencers i LEFT JOIN identity.persona_runtime_config rc ON rc.influencer_id = i.id
      WHERE i.id = $1 FOR SHARE OF i`,
    [influencerId],
  );
  if (!influencer) throw notFound('Influencer', influencerId);
  if (!['draft', 'active'].includes(influencer.status)) {
    throw conflict('INFLUENCER_NOT_GENERATING', `Influencer is ${influencer.status}`);
  }
  if (!influencer.active_persona_version_id) {
    throw conflict('NO_ACTIVE_PERSONA', 'Generation requires an approved, active persona version (persona identity)');
  }

  // Workflow: via the influencer's binding for a purpose, or an explicit key + range.
  let binding: { id: string; workflow_key: string; version_range: string; default_parameters: Record<string, unknown>; priority_class: PriorityClass | null; output_count: number | null } | null = null;
  let workflow: WorkflowRow | null;
  if (input.purpose) {
    binding = await maybeOne(
      db,
      `SELECT id, workflow_key, version_range, default_parameters, priority_class, output_count
         FROM identity.workflow_bindings WHERE influencer_id = $1 AND purpose = $2 AND status = 'active'`,
      [influencerId, input.purpose],
    );
    if (!binding) throw unprocessable('NO_BINDING', `No active workflow binding for purpose ${input.purpose}`);
    workflow = await resolveWorkflowVersion(db, binding.workflow_key, binding.version_range);
  } else {
    workflow = await resolveWorkflowVersion(db, input.workflow!.key, input.workflow!.version_range);
  }
  if (!workflow || !isUsable(workflow)) {
    const ref = binding ? `${binding.workflow_key} ${binding.version_range}` : `${input.workflow!.key} ${input.workflow!.version_range}`;
    throw unprocessable('NO_APPROVED_VERSION', `No approved, usable workflow version for ${ref}`);
  }
  const manifest = workflow.manifest;

  const parameters = { ...(binding?.default_parameters ?? {}), ...(input.parameters ?? {}) };
  const paramCheck = validator.validateParameters(workflow.manifest_sha256, manifest.input_schema, parameters);
  if (!paramCheck.ok) {
    throw unprocessable('PARAMETER_VALIDATION_FAILED', `Parameters do not match ${workflow.workflow_key}@${workflow.version} input_schema`, {
      violations: paramCheck.violations,
    });
  }

  const outputCount = input.output_count ?? binding?.output_count ?? manifest.outputs.count.default ?? manifest.outputs.count.min;
  if (outputCount < manifest.outputs.count.min || outputCount > manifest.outputs.count.max) {
    throw unprocessable('OUTPUT_COUNT_OUT_OF_RANGE', `output_count must be between ${manifest.outputs.count.min} and ${manifest.outputs.count.max}`);
  }

  // Per-job references: this influencer's own valid assets only, within manifest limits.
  const references = input.references ?? [];
  const refRules = manifest.references?.assets ?? {};
  if (references.length > (refRules.max ?? 0) || references.length < (refRules.min ?? 0)) {
    throw unprocessable('REFERENCE_NOT_ALLOWED', `Workflow accepts ${refRules.min ?? 0}–${refRules.max ?? 0} references`);
  }
  for (const ref of references) {
    if (refRules.roles && !refRules.roles.includes(ref.role)) {
      throw unprocessable('REFERENCE_NOT_ALLOWED', `Reference role ${ref.role} is not accepted (allowed: ${refRules.roles.join(', ') || 'none'})`);
    }
  }
  if (references.length > 0) {
    const owned = await db.query<{ id: string }>(
      `SELECT id FROM content.media_assets WHERE id = ANY($1::uuid[]) AND influencer_id = $2 AND status = 'valid'`,
      [references.map((r) => r.asset_id), influencerId],
    );
    const ownedIds = new Set(owned.rows.map((r) => r.id));
    const foreign = references.filter((r) => !ownedIds.has(r.asset_id)).map((r) => r.asset_id);
    if (foreign.length > 0) {
      throw unprocessable('REFERENCE_NOT_OWNED', 'References must be valid assets of the same influencer', { asset_ids: foreign });
    }
  }

  // Persona identity: approved, unretired references of THIS influencer only.
  const personaRefs = await db.query<{ id: string }>(
    `SELECT id FROM identity.reference_assets
      WHERE influencer_id = $1 AND approved_by IS NOT NULL AND retired_at IS NULL ORDER BY is_canonical DESC, created_at`,
    [influencerId],
  );
  let adapterIds: string[] = [];
  const adapterRules = manifest.references?.adapters;
  if (input.use_adapters !== false && adapterRules && (adapterRules.max ?? 0) > 0) {
    const adapters = await db.query<{ id: string }>(
      `SELECT id FROM identity.model_adapters
        WHERE influencer_id = $1 AND status = 'ready' AND approved_by IS NOT NULL AND engine_ref IS NOT NULL
          AND kind = ANY($2::text[]) AND (cardinality(workflow_keys) = 0 OR $3 = ANY(workflow_keys))
        ORDER BY created_at DESC LIMIT $4`,
      [influencerId, adapterRules.kinds ?? ['lora', 'other'], workflow.workflow_key, adapterRules.max],
    );
    adapterIds = adapters.rows.map((a) => a.id);
  }

  if (input.content_item_id) {
    const item = await maybeOne<{ influencer_id: string; status: string }>(
      db,
      'SELECT influencer_id, status FROM content.content_items WHERE id = $1 FOR UPDATE',
      [input.content_item_id],
    );
    if (!item || item.influencer_id !== influencerId) throw unprocessable('CONTENT_ITEM_MISMATCH', 'Content item does not belong to this influencer');
    if (['published', 'archived', 'rejected', 'failed'].includes(item.status)) {
      throw conflict('CONTENT_ITEM_CLOSED', `Content item is ${item.status}`);
    }
    await db.query(
      `UPDATE content.content_items SET status = 'generating', updated_at = now()
        WHERE id = $1 AND status IN ('planned', 'briefed', 'needs_rework', 'changes_requested')`,
      [input.content_item_id],
    );
  }

  const priorityClass: PriorityClass =
    input.priority_class ?? binding?.priority_class ?? manifest.resources.default_priority ?? (workflow.output_kind === 'video' ? 'video' : 'scheduled_image');
  const timeoutS = Math.min(manifest.timeouts.max_runtime_s, limits.jobTimeoutCapSeconds);
  const id = uuidv7();
  const insertSql = `INSERT INTO inference.visual_jobs (id, workspace_id, influencer_id, persona_version_id, content_item_id, binding_id,
         workflow_id, workflow_key, workflow_version, request_id, max_attempts, priority_class, priority, parameters,
         "references", persona_reference_ids, adapter_ids, output_count, timeout_s, deadline_at, requested_by_type,
         requested_by_id, idempotency_key, request_hash, trace_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)
       RETURNING *`;
  const insertParams = [
    id,
    ctx.workspaceId,
    influencerId,
    influencer.active_persona_version_id,
    input.content_item_id ?? null,
    binding?.id ?? null,
    workflow.id,
    workflow.workflow_key,
    workflow.version,
    uuidv7(),
    limits.maxAttempts,
    priorityClass,
    PRIORITY_OF_CLASS[priorityClass],
    JSON.stringify(parameters),
    JSON.stringify(references),
    personaRefs.rows.map((r) => r.id),
    adapterIds,
    outputCount,
    timeoutS,
    input.deadline_at ?? null,
    ctx.actor.type === 'external' ? 'system' : ctx.actor.type,
    ctx.actor.id,
    input.idempotency_key,
    requestHash,
    ctx.traceId ?? null,
  ];

  // Savepoint: a concurrent request with the same idempotency key must resolve to a replay, not a 500.
  await db.query('SAVEPOINT create_visual_job');
  let job: JobRow;
  try {
    job = await one<JobRow>(db, insertSql, insertParams);
    await db.query('RELEASE SAVEPOINT create_visual_job');
  } catch (err) {
    if (pgCode(err) !== PG.uniqueViolation) throw err;
    await db.query('ROLLBACK TO SAVEPOINT create_visual_job');
    const winner = await one<JobRow>(db, 'SELECT * FROM inference.visual_jobs WHERE workspace_id = $1 AND idempotency_key = $2', [
      ctx.workspaceId,
      input.idempotency_key,
    ]);
    if (winner.request_hash !== requestHash) {
      throw conflict('IDEMPOTENCY_CONFLICT', 'idempotency_key was already used with a different request', { visual_job_id: winner.id });
    }
    return { job: winner, replayed: true };
  }
  await recordEvent(db, job, {
    type: 'created',
    to: 'queued',
    actor: ctx.actor,
    details: {
      workflow: `${workflow.workflow_key}@${workflow.version}`,
      manifest_sha256: workflow.manifest_sha256,
      binding_id: binding?.id ?? null,
      persona_version_id: job.persona_version_id,
      persona_reference_ids: job.persona_reference_ids,
      reference_asset_ids: references.map((r) => r.asset_id),
      adapter_ids: adapterIds,
      priority_class: priorityClass,
      timeout_s: timeoutS,
    },
  });
  await auditCtx(db, ctx, {
    influencerId,
    action: 'visual_job.create',
    subjectType: 'visual_job',
    subjectId: id,
    metadata: { workflow: `${workflow.workflow_key}@${workflow.version}`, purpose: input.purpose ?? null, content_item_id: input.content_item_id ?? null, requested_by: actorRef(ctx.actor) },
  });
  await outbox(db, {
    workspaceId: ctx.workspaceId,
    eventType: 'visual.job_created',
    aggregateType: 'visual_job',
    aggregateId: id,
    payload: { influencer_id: influencerId, workflow_key: workflow.workflow_key, workflow_version: workflow.version },
  });
  return { job, replayed: false };

}

// -----------------------------------------------------------------------------
// Reads and cancellation
// -----------------------------------------------------------------------------

export async function getVisualJob(db: Db, ctx: Ctx, jobId: string): Promise<{ job: JobRow; events: unknown[] }> {
  requirePermission(ctx, 'visual_job.read');
  const job = await maybeOne<JobRow>(db, 'SELECT * FROM inference.visual_jobs WHERE id = $1', [jobId]);
  if (!job) throw notFound('Visual job', jobId);
  requireInfluencerAccess(ctx, job.influencer_id);
  const events = await db.query(
    `SELECT id, occurred_at, event_type, from_state, to_state, attempt, engine_job_id, actor_type, actor_id, details
       FROM inference.visual_job_events WHERE visual_job_id = $1 ORDER BY id`,
    [jobId],
  );
  return { job, events: events.rows };
}

export async function listVisualJobs(db: Db, ctx: Ctx, influencerId: string, state?: string): Promise<JobRow[]> {
  requirePermission(ctx, 'visual_job.read');
  requireInfluencerAccess(ctx, influencerId);
  const { rows } = await db.query<JobRow>(
    `SELECT * FROM inference.visual_jobs WHERE influencer_id = $1 AND ($2::text IS NULL OR state = $2)
      ORDER BY created_at DESC LIMIT 200`,
    [influencerId, state ?? null],
  );
  return rows;
}

/**
 * Cancels a job. Queued jobs are cancelled immediately; dispatched jobs move to
 * cancel_requested and the poller cancels them on the engine (contract §6).
 */
export async function cancelVisualJob(db: Db, ctx: Ctx, jobId: string, reason: string | null): Promise<JobRow> {
  requirePermission(ctx, 'visual_job.cancel');
  const job = await maybeOne<JobRow>(db, 'SELECT * FROM inference.visual_jobs WHERE id = $1 FOR UPDATE', [jobId]);
  if (!job) throw notFound('Visual job', jobId);
  requireInfluencerAccess(ctx, job.influencer_id);
  if (job.state === 'cancel_requested') return job;
  if (['succeeded', 'failed', 'cancelled'].includes(job.state)) {
    throw conflict('JOB_ALREADY_TERMINAL', `Job is already ${job.state}`);
  }
  if (job.state === 'ingesting' || job.state === 'timed_out') {
    throw conflict('JOB_NOT_CANCELLABLE', `Job is ${job.state}; it will finish or retry on its own`);
  }
  const details = { reason, requested_by: actorRef(ctx.actor) };
  let updated: JobRow | null;
  if (job.state === 'queued') {
    updated = await transition(db, job, 'cancelled', { finished_at: new Date(), error: { code: 'CANCELLED', class: 'cancelled', message: reason ?? 'cancelled by user', retryable: false } }, { type: 'cancelled', actor: ctx.actor, details });
    if (updated) await onTerminal(db, updated, ctx.actor);
  } else {
    updated = await transition(db, job, 'cancel_requested', {}, { type: 'cancel_requested', actor: ctx.actor, details });
    await auditCtx(db, ctx, { influencerId: job.influencer_id, action: 'visual_job.cancel_request', subjectType: 'visual_job', subjectId: job.id, metadata: details });
  }
  if (!updated) throw conflict('CONCURRENT_UPDATE', 'Job changed state concurrently; retry');
  return updated;
}
