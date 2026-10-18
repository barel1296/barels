import type pg from 'pg';
import type { Db } from '../db/tx.js';

export interface AlertInput {
  workspaceId?: string | null;
  severity: 'info' | 'warning' | 'critical';
  source: string;
  code: string;
  /** One open alert per dedup key; repeats increment `occurrences`. */
  dedupKey: string;
  message: string;
  details?: Record<string, unknown>;
}

export async function raiseAlert(db: Db | pg.Pool, a: AlertInput): Promise<void> {
  await db.query(
    `INSERT INTO ops.alerts (workspace_id, severity, source, code, dedup_key, message, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (dedup_key) WHERE status <> 'resolved'
     DO UPDATE SET occurrences = ops.alerts.occurrences + 1, last_seen_at = now(), message = EXCLUDED.message,
                   details = EXCLUDED.details,
                   severity = CASE WHEN EXCLUDED.severity = 'critical' THEN 'critical' ELSE ops.alerts.severity END`,
    [a.workspaceId ?? null, a.severity, a.source, a.code, a.dedupKey, a.message, JSON.stringify(a.details ?? {})],
  );
}

/** Resolves the open alert for a key (condition cleared). */
export async function resolveAlert(db: Db | pg.Pool, dedupKey: string): Promise<void> {
  await db.query(`UPDATE ops.alerts SET status = 'resolved', resolved_at = now() WHERE dedup_key = $1 AND status <> 'resolved'`, [dedupKey]);
}

export async function listAlerts(db: Db | pg.Pool, status: 'open' | 'all' = 'open'): Promise<unknown[]> {
  const { rows } = await db.query(
    `SELECT * FROM ops.alerts WHERE ($1 = 'all' OR status <> 'resolved')
      ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, last_seen_at DESC LIMIT 500`,
    [status],
  );
  return rows;
}

export async function acknowledgeAlert(db: Db | pg.Pool, id: string, userId: string): Promise<boolean> {
  const res = await db.query(
    `UPDATE ops.alerts SET status = 'acknowledged', acknowledged_by = $2, acknowledged_at = now() WHERE id = $1 AND status = 'open'`,
    [id, userId],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function closeAlert(db: Db | pg.Pool, id: string): Promise<boolean> {
  const res = await db.query(`UPDATE ops.alerts SET status = 'resolved', resolved_at = now() WHERE id = $1 AND status <> 'resolved'`, [id]);
  return (res.rowCount ?? 0) > 0;
}
