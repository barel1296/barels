import { EngineCallError, type EngineClient } from '../../contract/client.js';
import type { ErrorObject, JobStatus } from '../../contract/types.js';
import type { Services } from '../../services.js';
import { type EngineRow, loadEngine } from './engines.js';
import { ingestOutputs } from './ingest.js';
import { type JobRow, WORKER_ACTOR, failAttempt, onTerminal, recordEvent, transition } from './jobs.js';
import { POLLED_STATES } from './state-machine.js';

const TERMINAL_ENGINE_STATES = new Set(['succeeded', 'failed', 'cancelled']);

function policyOf(svc: Services) {
  return { baseMs: svc.config.worker.retryBaseMs, maxMs: svc.config.worker.retryMaxMs };
}

function usageOf(status: JobStatus) {
  return {
    gpuSeconds: status.resource_usage?.gpu_seconds ?? 0,
    wallSeconds: status.resource_usage?.wall_seconds ?? 0,
    resourceUsage: status.resource_usage ?? null,
  };
}

/** Records progress only when the stage changes or the fraction moves by ≥ 0.25 (keeps the event log readable). */
function progressWorthRecording(prev: JobRow['progress'], next: JobStatus['progress']): boolean {
  if (!next) return false;
  if (!prev) return true;
  if ((prev.stage ?? null) !== (next.stage ?? null)) return true;
  const a = typeof prev.fraction === 'number' ? prev.fraction : 0;
  const b = typeof next.fraction === 'number' ? next.fraction : 0;
  return Math.abs(b - a) >= 0.25;
}

/**
 * Applies an engine job status (from submit, poll or cancel) to a platform job
 * in `submitted` or `running` (contract §6.1 → §6.2 mapping).
 */
export async function applyEngineStatus(svc: Services, engine: EngineRow, job: JobRow, status: JobStatus): Promise<void> {
  const pool = svc.workerPool;
  const engineActor = { type: 'engine' as const, id: engine.engine_key };
  if (status.job_id !== job.engine_job_id) {
    await failAttempt(pool, job, { code: 'ENGINE_PROTOCOL_ERROR', class: 'permanent', message: `status for ${status.job_id}, expected ${job.engine_job_id}`, retryable: false }, WORKER_ACTOR, policyOf(svc));
    return;
  }
  switch (status.state) {
    case 'queued':
    case 'cancelling': {
      if (status.state !== job.engine_state) {
        await pool.query('UPDATE inference.visual_jobs SET engine_state = $2, updated_at = now() WHERE id = $1', [job.id, status.state]);
        await recordEvent(pool, job, { type: 'engine_state', actor: engineActor, details: { engine_state: status.state } });
      }
      return;
    }
    case 'running': {
      if (job.state === 'submitted') {
        await transition(pool, job, 'running', { engine_state: 'running', progress: status.progress ?? null, started_at: job.started_at ?? new Date() }, {
          type: 'running',
          actor: engineActor,
          details: { progress: status.progress ?? null, engine_started_at: status.started_at ?? null },
        });
      } else if (progressWorthRecording(job.progress, status.progress)) {
        await pool.query('UPDATE inference.visual_jobs SET progress = $2, engine_state = $3, updated_at = now() WHERE id = $1', [
          job.id,
          JSON.stringify(status.progress),
          status.state,
        ]);
        await recordEvent(pool, job, { type: 'progress', actor: engineActor, details: { progress: status.progress } });
      }
      return;
    }
    case 'succeeded': {
      const ingesting = await transition(
        pool,
        job,
        'ingesting',
        {
          engine_state: 'succeeded',
          progress: status.progress ?? null,
          started_at: job.started_at ?? (status.started_at ? new Date(status.started_at) : new Date()),
          lease_owner: svc.config.worker.workerId,
          lease_expires_at: new Date(Date.now() + svc.config.worker.leaseSeconds * 1000),
        },
        { type: 'engine_succeeded', actor: engineActor, details: { outputs: status.outputs?.length ?? 0, resource_usage: status.resource_usage ?? null } },
      );
      if (ingesting) await ingestOutputs(svc, engine, ingesting, status);
      return;
    }
    case 'failed': {
      const error: ErrorObject = status.error ?? { code: 'EXECUTION_FAILED', class: 'permanent', message: 'engine reported failure without error', retryable: false };
      await failAttempt(pool, job, error, WORKER_ACTOR, policyOf(svc), usageOf(status));
      return;
    }
    case 'cancelled': {
      await failAttempt(
        pool,
        job,
        { code: 'CANCELLED', class: 'cancelled', message: 'engine cancelled the job without a platform request', retryable: false },
        WORKER_ACTOR,
        policyOf(svc),
        usageOf(status),
      );
      return;
    }
  }
}

async function finalizeCancelled(svc: Services, job: JobRow, status: JobStatus | null, note: string): Promise<void> {
  const usage = status ? usageOf(status) : { gpuSeconds: 0, wallSeconds: 0, resourceUsage: null };
  const cancelled = await transition(
    svc.workerPool,
    job,
    'cancelled',
    {
      finished_at: new Date(),
      engine_state: status?.state ?? job.engine_state,
      error: { code: 'CANCELLED', class: 'cancelled', message: note, retryable: false },
      error_code: 'CANCELLED',
      error_class: 'cancelled',
      lease_owner: null,
      lease_expires_at: null,
      gpu_seconds: job.gpu_seconds + (usage.gpuSeconds ?? 0),
      wall_seconds: job.wall_seconds + (usage.wallSeconds ?? 0),
      resource_usage: usage.resourceUsage,
    },
    { type: 'cancelled', actor: WORKER_ACTOR, details: { engine_state: status?.state ?? null, note } },
  );
  if (cancelled) await onTerminal(svc.workerPool, cancelled, WORKER_ACTOR);
}

async function reconcileCancel(svc: Services, client: EngineClient, job: JobRow): Promise<void> {
  if (!job.engine_job_id) {
    // Cancelled before the submit returned; once the dispatch lease is gone nothing can still be in flight from us.
    if (!job.lease_expires_at || job.lease_expires_at < new Date()) {
      await finalizeCancelled(svc, job, null, 'cancelled before the engine accepted the job');
    }
    return;
  }
  try {
    const status = await client.cancelJob(job.engine_job_id);
    // Terminal on the engine (cancelled, or finished first): the user asked to cancel, so outputs are not ingested.
    if (TERMINAL_ENGINE_STATES.has(status.state)) {
      await finalizeCancelled(svc, job, status, status.state === 'cancelled' ? 'cancelled by request' : `engine finished (${status.state}) before cancel took effect; outputs discarded`);
    } else if (status.state !== job.engine_state) {
      await svc.workerPool.query('UPDATE inference.visual_jobs SET engine_state = $2, updated_at = now() WHERE id = $1', [job.id, status.state]);
    }
  } catch (err) {
    if (err instanceof EngineCallError && err.code === 'JOB_NOT_FOUND') {
      await finalizeCancelled(svc, job, null, 'engine no longer knows the job');
    } else {
      await recordEvent(svc.workerPool, job, { type: 'cancel_call_failed', actor: WORKER_ACTOR, details: { error: (err as EngineCallError).error ?? String(err) } });
    }
  }
}

async function reconcileTimedOut(svc: Services, client: EngineClient, job: JobRow): Promise<void> {
  const timeoutError: ErrorObject = {
    code: 'PLATFORM_TIMEOUT',
    class: 'timeout',
    message: `job exceeded timeout_s=${job.timeout_s}`,
    retryable: true,
  };
  let status: JobStatus | null = null;
  let lost = false;
  try {
    status = await client.getJob(job.engine_job_id!);
  } catch (err) {
    // Unreachable engine: keep waiting until the grace period ends.
    lost = err instanceof EngineCallError && err.code === 'JOB_NOT_FOUND';
  }
  const graceOver = job.dispatched_at !== null && Date.now() > job.dispatched_at.getTime() + (job.timeout_s + svc.config.worker.timeoutGraceSeconds) * 1000;
  if (lost || graceOver || (status && TERMINAL_ENGINE_STATES.has(status.state))) {
    await failAttempt(svc.workerPool, job, timeoutError, WORKER_ACTOR, policyOf(svc), status ? usageOf(status) : {});
    return;
  }
  await client.cancelJob(job.engine_job_id!).catch(() => undefined);
}

/** Reconciles one dispatched job with the engine. */
export async function reconcileJob(svc: Services, job: JobRow): Promise<void> {
  const engine = await loadEngine(svc.workerPool, job.engine_id!);
  const client = svc.engineClients.forRow(engine);
  if (job.state === 'cancel_requested') return reconcileCancel(svc, client, job);
  if (job.state === 'timed_out') return reconcileTimedOut(svc, client, job);

  if (job.dispatched_at && Date.now() > job.dispatched_at.getTime() + job.timeout_s * 1000) {
    const cancel = await client.cancelJob(job.engine_job_id!).then(
      (s) => ({ engine_state: s.state }),
      (e: unknown) => ({ cancel_error: e instanceof EngineCallError ? e.error : String(e) }),
    );
    await transition(svc.workerPool, job, 'timed_out', { lease_owner: null, lease_expires_at: null }, {
      type: 'timed_out',
      actor: WORKER_ACTOR,
      details: { timeout_s: job.timeout_s, ...cancel },
    });
    return;
  }

  let status: JobStatus;
  try {
    status = await client.getJob(job.engine_job_id!);
  } catch (err) {
    if (!(err instanceof EngineCallError)) throw err;
    if (err.code === 'JOB_NOT_FOUND') {
      // Engine restarted and lost the job: a transient failure of this attempt.
      await failAttempt(svc.workerPool, job, { code: 'ENGINE_JOB_LOST', class: 'transient', message: 'engine no longer knows this job', retryable: true }, WORKER_ACTOR, policyOf(svc));
    } else if (err.kind === 'protocol') {
      await failAttempt(svc.workerPool, job, err.error, WORKER_ACTOR, policyOf(svc));
    } else {
      // Network / 5xx: keep the job, the timeout bounds how long we wait.
      await recordEvent(svc.workerPool, job, { type: 'poll_failed', actor: WORKER_ACTOR, details: { error: err.error } });
    }
    return;
  }
  await applyEngineStatus(svc, engine, job, status);
}

/** Claims due jobs in polled states with a lease and reconciles them. */
export async function pollTick(svc: Services): Promise<number> {
  const cfg = svc.config.worker;
  const { rows } = await svc.workerPool.query<JobRow>(
    `UPDATE inference.visual_jobs SET lease_owner = $1, lease_expires_at = now() + make_interval(secs => $2)
      WHERE id IN (
        SELECT id FROM inference.visual_jobs
         WHERE state = ANY($3::text[]) AND (lease_expires_at IS NULL OR lease_expires_at < now())
           AND (last_polled_at IS NULL OR last_polled_at < now() - make_interval(secs => $4::float8 / 1000))
         ORDER BY last_polled_at NULLS FIRST
         LIMIT 50
         FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    [cfg.workerId, cfg.leaseSeconds, POLLED_STATES, cfg.pollIntervalMs],
  );
  for (const job of rows) {
    try {
      await reconcileJob(svc, job);
    } catch (err) {
      console.error(`[poller] job ${job.id}: ${(err as Error).stack ?? err}`);
    } finally {
      await svc.workerPool.query(
        `UPDATE inference.visual_jobs SET lease_owner = NULL, lease_expires_at = NULL, last_polled_at = now()
          WHERE id = $1 AND lease_owner = $2 AND state <> 'ingesting'`,
        [job.id, cfg.workerId],
      );
    }
  }
  return rows.length;
}

/** Re-runs ingestion for jobs left in `ingesting` by a crashed worker (lease expired). */
export async function ingestRecoveryTick(svc: Services): Promise<number> {
  const cfg = svc.config.worker;
  const { rows } = await svc.workerPool.query<JobRow>(
    `UPDATE inference.visual_jobs SET lease_owner = $1, lease_expires_at = now() + make_interval(secs => $2)
      WHERE id IN (
        SELECT id FROM inference.visual_jobs
         WHERE state = 'ingesting' AND (lease_expires_at IS NULL OR lease_expires_at < now())
         LIMIT 20 FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    [cfg.workerId, cfg.leaseSeconds],
  );
  for (const job of rows) {
    try {
      await recordEvent(svc.workerPool, job, { type: 'ingest_recovered', actor: WORKER_ACTOR });
      const engine = await loadEngine(svc.workerPool, job.engine_id!);
      const status = await svc.engineClients.forRow(engine).getJob(job.engine_job_id!);
      await ingestOutputs(svc, engine, job, status);
    } catch (err) {
      const error: ErrorObject =
        err instanceof EngineCallError
          ? err.code === 'JOB_NOT_FOUND'
            ? { code: 'ENGINE_JOB_LOST', class: 'transient', message: 'outputs no longer available on the engine', retryable: true }
            : err.error
          : { code: 'PLATFORM_ERROR', class: 'transient', message: (err as Error).message, retryable: true };
      await failAttempt(svc.workerPool, job, error, WORKER_ACTOR, policyOf(svc));
    }
  }
  return rows.length;
}
