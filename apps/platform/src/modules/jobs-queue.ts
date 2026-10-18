import type pg from 'pg';
import type { Db } from '../db/tx.js';
import { uuidv7 } from '../lib/ids.js';
import { raiseAlert } from './alerts.js';

/**
 * Durable job queue on PostgreSQL (core.jobs) for every non-GPU background task.
 * Priorities: 0 = payment integrity (P0) … 9 = maintenance. Idempotent by job_key.
 * GPU work does not use this queue: it goes through inference.visual_jobs and the
 * GPU-aware dispatcher.
 */
export interface EnqueueOptions {
  workspaceId?: string | null;
  queue: string;
  name: string;
  key: string;
  payload: Record<string, unknown>;
  priority?: number;
  runAt?: Date;
  maxAttempts?: number;
}

export const PRIORITY = { payments: 0, conversation: 1, publishing: 3, default: 5, analytics: 7, maintenance: 9 } as const;

export async function enqueue(db: Db | pg.Pool, o: EnqueueOptions): Promise<{ id: string; created: boolean }> {
  const res = await db.query<{ id: string }>(
    `INSERT INTO core.jobs (id, workspace_id, queue, name, job_key, payload, priority, run_at, max_attempts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, coalesce($8, now()), $9)
     ON CONFLICT (job_key) DO NOTHING RETURNING id`,
    [uuidv7(), o.workspaceId ?? null, o.queue, o.name, o.key, JSON.stringify(o.payload), o.priority ?? PRIORITY.default, o.runAt ?? null, o.maxAttempts ?? 8],
  );
  if (res.rows[0]) return { id: res.rows[0].id, created: true };
  const existing = await db.query<{ id: string }>('SELECT id FROM core.jobs WHERE job_key = $1', [o.key]);
  return { id: existing.rows[0]!.id, created: false };
}

export interface JobRecord {
  id: string;
  workspace_id: string | null;
  queue: string;
  name: string;
  job_key: string;
  payload: Record<string, unknown>;
  priority: number;
  attempts: number;
  max_attempts: number;
}

/** Throw to fail a job without retrying (it goes straight to the dead-letter table). */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

/** Throw to retry later without counting as an error worth alerting on. */
export class RetryLaterError extends Error {
  constructor(
    message: string,
    readonly delayMs: number,
  ) {
    super(message);
    this.name = 'RetryLaterError';
  }
}

export type JobHandler = (job: JobRecord) => Promise<unknown>;

export function backoffMs(attempt: number): number {
  const ceiling = Math.min(600_000, 2_000 * 2 ** Math.max(0, attempt - 1));
  return Math.floor(ceiling / 2 + Math.random() * (ceiling / 2));
}

export class JobRunner {
  constructor(
    private readonly pool: pg.Pool,
    private readonly handlers: Map<string, JobHandler>,
    private readonly opts: { workerId: string; leaseSeconds: number; concurrency: number },
  ) {}

  /** Returns jobs whose lease expired (worker crashed mid-job) to the queue. */
  async recoverExpired(): Promise<number> {
    const res = await this.pool.query(
      `UPDATE core.jobs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, updated_at = now(),
              last_error = jsonb_build_object('message', 'lease expired; requeued')
        WHERE status = 'running' AND lease_expires_at < now()`,
    );
    return res.rowCount ?? 0;
  }

  /** Claims and runs up to `limit` due jobs. Returns how many ran. */
  async runOnce(limit = this.opts.concurrency * 4): Promise<number> {
    await this.recoverExpired();
    const names = [...this.handlers.keys()];
    if (names.length === 0) return 0;
    const { rows } = await this.pool.query<JobRecord>(
      `UPDATE core.jobs SET status = 'running', attempts = attempts + 1, lease_owner = $1,
              lease_expires_at = now() + make_interval(secs => $2), updated_at = now()
        WHERE id IN (
          SELECT id FROM core.jobs
           WHERE status = 'queued' AND run_at <= now() AND name = ANY($3::text[])
           ORDER BY priority, run_at
           LIMIT $4
           FOR UPDATE SKIP LOCKED)
        RETURNING id, workspace_id, queue, name, job_key, payload, priority, attempts, max_attempts`,
      [this.opts.workerId, this.opts.leaseSeconds, names, limit],
    );
    // Priority order is preserved within the batch; run with bounded concurrency.
    const queue = [...rows].sort((a, b) => a.priority - b.priority);
    const workers = Array.from({ length: Math.min(this.opts.concurrency, queue.length) }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) await this.execute(job);
    });
    await Promise.all(workers);
    return rows.length;
  }

  private async execute(job: JobRecord): Promise<void> {
    const handler = this.handlers.get(job.name)!;
    try {
      const result = await handler(job);
      await this.pool.query(
        `UPDATE core.jobs SET status = 'succeeded', result = $2, completed_at = now(), updated_at = now(), lease_owner = NULL, lease_expires_at = NULL
          WHERE id = $1`,
        [job.id, result === undefined ? null : JSON.stringify(result)],
      );
    } catch (err) {
      const e = err as Error;
      const error = { name: e.name, message: e.message.slice(0, 2000) };
      if (err instanceof RetryLaterError && job.attempts < job.max_attempts) {
        await this.pool.query(
          `UPDATE core.jobs SET status = 'queued', run_at = now() + make_interval(secs => $2::float8 / 1000), last_error = $3,
                  updated_at = now(), lease_owner = NULL, lease_expires_at = NULL WHERE id = $1`,
          [job.id, err.delayMs, JSON.stringify(error)],
        );
        return;
      }
      const dead = err instanceof PermanentJobError || job.attempts >= job.max_attempts;
      if (!dead) {
        await this.pool.query(
          `UPDATE core.jobs SET status = 'queued', run_at = now() + make_interval(secs => $2::float8 / 1000), last_error = $3,
                  updated_at = now(), lease_owner = NULL, lease_expires_at = NULL WHERE id = $1`,
          [job.id, backoffMs(job.attempts), JSON.stringify(error)],
        );
        return;
      }
      await this.pool.query(
        `UPDATE core.jobs SET status = 'dead', last_error = $2, completed_at = now(), updated_at = now(), lease_owner = NULL, lease_expires_at = NULL
          WHERE id = $1`,
        [job.id, JSON.stringify(error)],
      );
      await this.pool.query(
        `INSERT INTO core.dead_letter_jobs (workspace_id, queue, job_id, job_name, payload, error, attempts)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (queue, job_id) DO NOTHING`,
        [job.workspace_id, job.queue, job.id, job.name, JSON.stringify(job.payload), JSON.stringify(error), job.attempts],
      );
      await raiseAlert(this.pool, {
        workspaceId: job.workspace_id,
        severity: job.priority === PRIORITY.payments ? 'critical' : 'warning',
        source: 'jobs',
        code: 'JOB_DEAD_LETTERED',
        dedupKey: `job_dead:${job.name}`,
        message: `Job ${job.name} failed permanently (${error.message})`,
        details: { job_id: job.id, job_key: job.job_key, queue: job.queue, attempts: job.attempts },
      });
    }
  }
}

/** Requeues a dead or failed job (operator action). */
export async function retryJob(pool: pg.Pool, jobId: string): Promise<boolean> {
  const res = await pool.query(
    `UPDATE core.jobs SET status = 'queued', attempts = 0, run_at = now(), updated_at = now(), completed_at = NULL
      WHERE id = $1 AND status IN ('dead', 'failed')`,
    [jobId],
  );
  if (res.rowCount) await pool.query(`UPDATE core.dead_letter_jobs SET status = 'replayed', resolved_at = now() WHERE job_id = $1`, [jobId]);
  return (res.rowCount ?? 0) > 0;
}
