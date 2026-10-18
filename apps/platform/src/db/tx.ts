import type pg from 'pg';

export type Db = pg.PoolClient;

/** Runs fn in a transaction. Rolls back on any error. */
export async function withTx<T>(pool: pg.Pool, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Tenant transaction: sets app.workspace_id for this transaction only, so
 * row-level security policies scope every statement to one workspace.
 */
export async function withTenant<T>(pool: pg.Pool, workspaceId: string, fn: (db: Db) => Promise<T>): Promise<T> {
  return withTx(pool, async (db) => {
    await db.query(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);
    return fn(db);
  });
}

export async function one<T extends pg.QueryResultRow>(db: Db | pg.Pool, sql: string, params: unknown[] = []): Promise<T> {
  const res = await db.query<T>(sql, params);
  if (res.rowCount !== 1 || !res.rows[0]) throw new Error(`expected exactly one row, got ${res.rowCount}`);
  return res.rows[0];
}

export async function maybeOne<T extends pg.QueryResultRow>(db: Db | pg.Pool, sql: string, params: unknown[] = []): Promise<T | null> {
  const res = await db.query<T>(sql, params);
  return res.rows[0] ?? null;
}
