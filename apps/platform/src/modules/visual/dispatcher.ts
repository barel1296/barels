import type pg from 'pg';
import { EngineCallError } from '../../contract/client.js';
import { CONTRACT_VERSION, type AssetRef, type ErrorObject, type JobSubmission } from '../../contract/types.js';
import { withTx } from '../../db/tx.js';
import { canonicalSha256Hex } from '../../lib/canonical-json.js';
import { signAssetUrl } from '../../lib/crypto.js';
import type { Services } from '../../services.js';
import { type EngineRow, loadEngine } from './engines.js';
import { type JobRow, WORKER_ACTOR, failAttempt, onTerminal, recordEvent, transition } from './jobs.js';
import { applyEngineStatus } from './poller.js';
import { type Candidate, effectivePriority, isOverQuota, rankCandidates, selectForDispatch } from './scheduler.js';
import { SLOT_STATES, retryDelayMs } from './state-machine.js';

const KILL_SWITCH = 'kill_switch.media_generation';

const USABLE_WORKFLOW_SQL = `(w.status = 'approved' OR (w.status = 'deprecated' AND (w.sunset_at IS NULL OR w.sunset_at > now())))`;

/** Global media kill switch (core.feature_flags, workspace_id NULL). */
async function globallyPaused(pool: pg.Pool): Promise<boolean> {
  const { rows } = await pool.query<{ value: unknown }>(
    `SELECT value FROM core.feature_flags WHERE workspace_id IS NULL AND influencer_id IS NULL AND key = $1`,
    [KILL_SWITCH],
  );
  return rows[0]?.value === true;
}

/**
 * Jobs whose dispatch lease expired (worker crashed between claim and submit
 * outcome) go back to the queue with the SAME attempt and stored body, so the
 * re-send is an idempotent replay on the engine (contract §7).
 */
export async function recoverStaleDispatches(svc: Services): Promise<number> {
  const { rows } = await svc.workerPool.query<JobRow>(
    `SELECT * FROM inference.visual_jobs WHERE state = 'dispatching' AND lease_expires_at < now() LIMIT 100`,
  );
  let n = 0;
  for (const job of rows) {
    const updated = await transition(svc.workerPool, job, 'queued', { lease_owner: null, lease_expires_at: null, not_before: new Date() }, {
      type: 'dispatch_recovered',
      actor: WORKER_ACTOR,
      details: { stale_lease_owner: job.lease_owner, submission_sha256: job.submission_sha256 },
    });
    if (updated) n++;
  }
  return n;
}

/** Queued jobs that can no longer run: workflow disabled/rejected/past sunset, or deadline passed. */
export async function failUnrunnableQueued(svc: Services): Promise<number> {
  const { rows } = await svc.workerPool.query<JobRow & { usable: boolean }>(
    `SELECT j.*, ${USABLE_WORKFLOW_SQL} AS usable
       FROM inference.visual_jobs j JOIN inference.visual_workflows w ON w.id = j.workflow_id
      WHERE j.state = 'queued' AND (NOT ${USABLE_WORKFLOW_SQL} OR j.deadline_at <= now())
      LIMIT 100`,
  );
  let n = 0;
  for (const { usable, ...job } of rows) {
    const error: ErrorObject = usable
      ? { code: 'DEADLINE_EXCEEDED', class: 'timeout', message: 'deadline_at passed before the job could run', retryable: false }
      : { code: 'WORKFLOW_DISABLED', class: 'conflict', message: `${job.workflow_key}@${job.workflow_version} is no longer approved`, retryable: false };
    const failed = await transition(svc.workerPool, job, 'failed', { finished_at: new Date(), error, error_code: error.code, error_class: error.class }, {
      type: 'failed',
      actor: WORKER_ACTOR,
      details: { error, reason: 'not_runnable' },
    });
    if (failed) {
      await onTerminal(svc.workerPool, failed, WORKER_ACTOR);
      n++;
    }
  }
  return n;
}

interface CandidateRow extends JobRow {
  gpu_required: boolean;
  vram_mb_peak: number | null;
  gpu_quota_seconds_day: number | null;
}

/**
 * Claims the jobs this engine should run now, under a per-engine advisory lock
 * so concurrent dispatchers never exceed the engine's slots.
 */
async function claimForEngine(svc: Services, engine: EngineRow): Promise<JobRow[]> {
  const cfg = svc.config.worker;
  return withTx(svc.workerPool, async (db) => {
    const lock = await db.query<{ ok: boolean }>(`SELECT pg_try_advisory_xact_lock(hashtext('golden.dispatch:' || $1)) AS ok`, [engine.id]);
    if (!lock.rows[0]?.ok) return [];
    const inflight = await db.query<{ gpu_required: boolean; vram_mb_peak: number | null }>(
      `SELECT w.gpu_required, w.vram_mb_peak
         FROM inference.visual_jobs j JOIN inference.visual_workflows w ON w.id = j.workflow_id
        WHERE j.engine_id = $1 AND j.state = ANY($2::text[])`,
      [engine.id, SLOT_STATES],
    );
    const capacity = Math.min(engine.advertised_max_concurrent_jobs ?? 1, engine.dispatch_limit ?? Number.MAX_SAFE_INTEGER);
    const slots = capacity - inflight.rowCount!;
    if (slots <= 0) return [];
    const { rows } = await db.query<CandidateRow>(
      `SELECT j.*, w.gpu_required, w.vram_mb_peak, rc.gpu_quota_seconds_day
         FROM inference.visual_jobs j
         JOIN inference.engine_workflows ew ON ew.workflow_id = j.workflow_id AND ew.engine_id = $1 AND ew.available
         JOIN inference.visual_workflows w ON w.id = j.workflow_id AND ${USABLE_WORKFLOW_SQL}
         JOIN identity.influencers i ON i.id = j.influencer_id AND i.status IN ('draft', 'active')
         JOIN core.workspaces ws ON ws.id = j.workspace_id AND ws.status = 'active'
         LEFT JOIN identity.persona_runtime_config rc ON rc.influencer_id = j.influencer_id
        WHERE j.state = 'queued' AND j.not_before <= now() AND NOT coalesce(rc.paused, false)
          AND NOT EXISTS (
            SELECT 1 FROM core.feature_flags f
             WHERE f.key = '${KILL_SWITCH}' AND f.value = 'true'::jsonb AND f.workspace_id = j.workspace_id
               AND (f.influencer_id IS NULL OR f.influencer_id = j.influencer_id))
        ORDER BY j.priority, j.not_before
        LIMIT 200
        FOR UPDATE OF j SKIP LOCKED`,
      [engine.id],
    );
    if (rows.length === 0) return [];
    const usage = await db.query<{ influencer_id: string; used: number }>(
      `SELECT influencer_id, coalesce(sum(gpu_seconds), 0)::float8 AS used
         FROM inference.visual_jobs
        WHERE influencer_id = ANY($1::uuid[]) AND finished_at >= date_trunc('day', now())
        GROUP BY influencer_id`,
      [[...new Set(rows.map((r) => r.influencer_id))]],
    );
    const used = new Map(usage.rows.map((u) => [u.influencer_id, u.used]));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const candidates: Candidate[] = rows.map((r) => ({
      id: r.id,
      influencerId: r.influencer_id,
      priority: r.priority,
      createdAt: r.created_at,
      queuedSince: r.not_before,
      deadlineAt: r.deadline_at,
      gpuRequired: r.gpu_required,
      vramMbPeak: r.vram_mb_peak,
      usedGpuSecondsToday: used.get(r.influencer_id) ?? 0,
      quotaGpuSecondsPerDay: r.gpu_quota_seconds_day,
    }));
    const now = new Date();
    const policy = { agingStepSeconds: cfg.agingStepSeconds, deadlineUrgencySeconds: cfg.deadlineUrgencySeconds };
    const ranked = rankCandidates(candidates, now, policy);
    const chosen = selectForDispatch(
      ranked,
      inflight.rows.map((r) => ({ gpuRequired: r.gpu_required, vramMbPeak: r.vram_mb_peak })),
      slots,
      engine.media_lane_vram_mb,
    );
    const claimed: JobRow[] = [];
    for (const c of chosen) {
      const { gpu_required: _g, vram_mb_peak: _v, gpu_quota_seconds_day: _q, ...job } = byId.get(c.id)!;
      const updated = await transition(
        db,
        job,
        'dispatching',
        {
          engine_id: engine.id,
          engine_kind: engine.engine_kind,
          lease_owner: cfg.workerId,
          lease_expires_at: new Date(Date.now() + cfg.leaseSeconds * 1000),
          dispatched_at: now,
        },
        {
          type: 'dispatching',
          actor: WORKER_ACTOR,
          details: {
            engine_id: engine.id,
            engine_key: engine.engine_key,
            engine_kind: engine.engine_kind,
            base_priority: c.priority,
            effective_priority: effectivePriority(c, now, policy),
            over_quota: isOverQuota(c),
            used_gpu_seconds_today: c.usedGpuSecondsToday,
            quota_gpu_seconds_day: c.quotaGpuSecondsPerDay,
            free_slots: slots,
          },
        },
      );
      if (updated) claimed.push(updated);
    }
    return claimed;
  });
}

const ROLE_BY_REFERENCE_KIND: Record<string, string> = {
  face_canonical: 'face',
  face_angle: 'face',
  body: 'identity',
  outfit: 'outfit',
  style: 'style',
  environment: 'environment',
};

interface AssetForRef {
  id: string;
  sha256: Buffer;
  mime_type: string;
  bytes: number;
  width: number | null;
  height: number | null;
}

function toAssetRef(svc: Services, a: AssetForRef, role: string, expUnix: number): AssetRef {
  const sig = signAssetUrl(svc.config.assetUrlSecret, a.id, expUnix);
  return {
    asset_id: a.id,
    role,
    sha256: a.sha256.toString('hex'),
    mime_type: a.mime_type,
    bytes: a.bytes,
    ...(a.width ? { width: a.width } : {}),
    ...(a.height ? { height: a.height } : {}),
    uri: `${svc.config.publicBaseUrl}/v1/assets/${a.id}/content?exp=${expUnix}&sig=${sig}`,
    expires_at: new Date(expUnix * 1000).toISOString(),
  };
}

/** Builds the contract submission for the job's current attempt. */
export async function buildSubmission(svc: Services, job: JobRow): Promise<JobSubmission> {
  const db = svc.workerPool;
  const persona = await db.query<{ version: number; visual_identity: Record<string, unknown> }>(
    'SELECT version, visual_identity FROM identity.persona_versions WHERE id = $1',
    [job.persona_version_id],
  );
  const personaRefs = await db.query<AssetForRef & { kind: string }>(
    `SELECT m.id, m.sha256, m.mime_type, m.bytes, m.width, m.height, r.kind
       FROM identity.reference_assets r JOIN content.media_assets m ON m.id = r.media_asset_id
      WHERE r.id = ANY($1::uuid[]) AND r.influencer_id = $2 AND r.retired_at IS NULL AND r.approved_by IS NOT NULL
      ORDER BY array_position($1::uuid[], r.id)`,
    [job.persona_reference_ids, job.influencer_id],
  );
  const jobRefAssets = await db.query<AssetForRef>(
    `SELECT id, sha256, mime_type, bytes, width, height FROM content.media_assets
      WHERE id = ANY($1::uuid[]) AND influencer_id = $2`,
    [job.references.map((r) => r.asset_id), job.influencer_id],
  );
  const adapters = await db.query<{ id: string; kind: 'lora' | 'other'; engine_ref: string }>(
    `SELECT id, kind, engine_ref FROM identity.model_adapters
      WHERE id = ANY($1::uuid[]) AND influencer_id = $2 AND status = 'ready' AND approved_by IS NOT NULL`,
    [job.adapter_ids, job.influencer_id],
  );
  const expUnix = Math.floor(Date.now() / 1000) + svc.config.assetUrlTtlSeconds;
  const assetsById = new Map(jobRefAssets.rows.map((a) => [a.id, a]));
  const references: AssetRef[] = [];
  for (const r of job.references) {
    const asset = assetsById.get(r.asset_id);
    if (asset) references.push(toAssetRef(svc, asset, r.role, expUnix));
  }
  const adapterRefs = adapters.rows.map((a) => ({ adapter_id: a.id, kind: a.kind, engine_ref: a.engine_ref }));
  return {
    contract_version: CONTRACT_VERSION,
    request_id: job.request_id,
    attempt: job.attempt,
    workflow: { key: job.workflow_key, version: job.workflow_version },
    influencer_id: job.influencer_id,
    persona: {
      influencer_id: job.influencer_id,
      persona_version_id: job.persona_version_id,
      persona_version: persona.rows[0]?.version ?? 1,
      visual_traits: persona.rows[0]?.visual_identity ?? {},
      reference_assets: personaRefs.rows.map((a) => toAssetRef(svc, a, ROLE_BY_REFERENCE_KIND[a.kind] ?? 'identity', expUnix)),
      adapters: adapterRefs,
    },
    parameters: job.parameters,
    references,
    // Identity adapters travel with the persona; per-job adapters are not used in Phase 1.
    adapters: [],
    output: { count: job.output_count, transfer: 'http_download' },
    priority: job.priority_class,
    timeout_s: job.timeout_s,
    deadline_at: job.deadline_at ? job.deadline_at.toISOString() : null,
    trace: { trace_id: job.trace_id ?? job.id, requested_by: `${job.requested_by_type}:${job.requested_by_id}` },
  };
}

/** Submits one claimed job (state dispatching) to its engine and records the outcome. */
export async function submitClaimed(svc: Services, engine: EngineRow, claimed: JobRow): Promise<void> {
  const pool = svc.workerPool;
  const policy = { baseMs: svc.config.worker.retryBaseMs, maxMs: svc.config.worker.retryMaxMs };
  let job = claimed;
  let body = job.submission as JobSubmission | null;
  if (!body || body.attempt !== job.attempt) {
    body = await buildSubmission(svc, job);
    const check = svc.validator.validate('job-submission', body);
    if (!check.ok) {
      // A platform defect, not an engine problem: fail loudly without contacting the engine.
      await failAttempt(pool, job, { code: 'PLATFORM_CONTRACT_VIOLATION', class: 'permanent', message: 'platform built a submission that violates the contract', retryable: false, details: { violations: check.violations } }, WORKER_ACTOR, policy);
      return;
    }
    const sha = canonicalSha256Hex(body);
    const res = await pool.query<JobRow>(
      `UPDATE inference.visual_jobs SET submission = $2, submission_sha256 = $3, updated_at = now()
        WHERE id = $1 AND state = 'dispatching' AND attempt = $4 RETURNING *`,
      [job.id, JSON.stringify(body), sha, job.attempt],
    );
    if (!res.rows[0]) return; // cancelled or recovered meanwhile
    job = res.rows[0];
  }
  const client = svc.engineClients.forRow(engine);
  try {
    const { replayed, job: status } = await client.submitJob(body);
    const engineActor = { type: 'engine' as const, id: engine.engine_key };
    let submitted = await transition(
      pool,
      job,
      'submitted',
      { engine_job_id: status.job_id, engine_state: status.state, lease_owner: null, lease_expires_at: null, last_polled_at: new Date() },
      { type: 'submitted', actor: engineActor, details: { engine_job_id: status.job_id, replayed, submission_sha256: job.submission_sha256, engine_state: status.state } },
    );
    if (!submitted) {
      // Cancelled while the submit was in flight: remember the engine job so the poller can cancel it.
      const res = await pool.query<JobRow>(
        `UPDATE inference.visual_jobs SET engine_job_id = $2, engine_id = $3, engine_state = $4, updated_at = now()
          WHERE id = $1 AND state = 'cancel_requested' AND engine_job_id IS NULL RETURNING *`,
        [job.id, status.job_id, engine.id, status.state],
      );
      if (res.rows[0]) await recordEvent(pool, res.rows[0], { type: 'submitted_after_cancel_request', actor: engineActor, details: { engine_job_id: status.job_id } });
      return;
    }
    await applyEngineStatus(svc, engine, submitted, status);
  } catch (err) {
    if (!(err instanceof EngineCallError)) {
      await failAttempt(pool, job, { code: 'PLATFORM_ERROR', class: 'permanent', message: (err as Error).message, retryable: false }, WORKER_ACTOR, policy);
      return;
    }
    await recordEvent(pool, job, { type: 'submit_failed', actor: WORKER_ACTOR, details: { error: err.error, http_status: err.httpStatus, ambiguous: err.ambiguous } });
    if (err.kind === 'network') {
      await pool.query(`UPDATE inference.visual_engines SET health = 'unreachable', last_error = $2 WHERE id = $1`, [engine.id, JSON.stringify(err.error)]);
    }
    if (err.code === 'IDEMPOTENCY_CONFLICT') {
      // The engine saw a different body under this key: move to a fresh attempt.
      await failAttempt(pool, job, { ...err.error, class: 'transient', retryable: true }, WORKER_ACTOR, policy);
      return;
    }
    if (err.ambiguous || err.retryable) {
      // Same attempt, same stored body: the re-send is an idempotent replay (contract §7).
      const { rows } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM inference.visual_job_events WHERE visual_job_id = $1 AND attempt = $2 AND event_type = 'submit_failed'`,
        [job.id, job.attempt],
      );
      const delay = retryDelayMs(rows[0]?.n ?? 1, policy, err.retryAfterMs ?? err.error.retry_after_ms);
      await transition(pool, job, 'queued', { lease_owner: null, lease_expires_at: null, not_before: new Date(Date.now() + delay), engine_id: null }, {
        type: 'submit_retry_scheduled',
        actor: WORKER_ACTOR,
        details: { delay_ms: delay, same_attempt: true, error: err.error },
      });
      return;
    }
    await failAttempt(pool, job, err.error, WORKER_ACTOR, policy);
  }
}

/** One scheduling pass over all active engines. Returns the number of jobs submitted. */
export async function dispatchTick(svc: Services): Promise<number> {
  await recoverStaleDispatches(svc);
  await failUnrunnableQueued(svc);
  if (await globallyPaused(svc.workerPool)) return 0;
  const engines = await svc.workerPool.query<{ id: string }>(
    `SELECT id FROM inference.visual_engines WHERE status = 'active' AND health NOT IN ('unreachable', 'maintenance') ORDER BY engine_key`,
  );
  let submitted = 0;
  for (const { id } of engines.rows) {
    const engine = await loadEngine(svc.workerPool, id);
    const claimed = await claimForEngine(svc, engine);
    for (const job of claimed) {
      await submitClaimed(svc, engine, job);
      submitted++;
    }
  }
  return submitted;
}
