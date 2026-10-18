import type pg from 'pg';

export interface PeriodicTask {
  name: string;
  intervalSeconds: number;
  run: () => Promise<unknown>;
}

/**
 * Runs each periodic task when due. A task row is claimed atomically, so
 * concurrent workers never run the same task twice; a run that crashed is
 * considered stale after max(interval, 1 h) and may be claimed again.
 */
export async function runDuePeriodic(pool: pg.Pool, tasks: PeriodicTask[]): Promise<string[]> {
  const ran: string[] = [];
  for (const t of tasks) {
    await pool.query(
      `INSERT INTO core.periodic_tasks (name, interval_seconds) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET interval_seconds = EXCLUDED.interval_seconds`,
      [t.name, t.intervalSeconds],
    );
    const claim = await pool.query(
      `UPDATE core.periodic_tasks SET last_started_at = now(), run_count = run_count + 1
        WHERE name = $1 AND enabled
          AND (last_started_at IS NULL OR last_started_at <= now() - make_interval(secs => interval_seconds))
          AND (last_started_at IS NULL OR last_finished_at >= last_started_at
               OR last_started_at < now() - make_interval(secs => greatest(interval_seconds, 3600)))
        RETURNING name`,
      [t.name],
    );
    if (!claim.rowCount) continue;
    try {
      const result = await t.run();
      await pool.query(
        `UPDATE core.periodic_tasks SET last_finished_at = now(), last_status = 'ok', last_error = NULL, last_result = $2 WHERE name = $1`,
        [t.name, JSON.stringify(result ?? null)],
      );
    } catch (err) {
      await pool.query(`UPDATE core.periodic_tasks SET last_finished_at = now(), last_status = 'error', last_error = $2 WHERE name = $1`, [
        t.name,
        (err as Error).message.slice(0, 2000),
      ]);
      console.error(`[periodic:${t.name}] ${(err as Error).stack ?? err}`);
    }
    ran.push(t.name);
  }
  return ran;
}

/** Forces a periodic task to run on the next pass (tests and operators). */
export async function makeDue(pool: pg.Pool, name: string): Promise<void> {
  await pool.query(`UPDATE core.periodic_tasks SET last_started_at = NULL, last_finished_at = NULL WHERE name = $1`, [name]);
}
