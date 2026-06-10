import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { loadConfig } from '../config/config';

export interface DbContext {
  tenantId?: string;
  userId?: string;
}

/**
 * All tenant-scoped access goes through withContext(): a transaction that sets
 * app.tenant_id / app.user_id for Postgres Row-Level Security. RLS (FORCE) is
 * the enforcement layer; application-level WHERE clauses are defense in depth.
 */
@Injectable()
export class DbService implements OnModuleDestroy {
  readonly pool: Pool;

  constructor() {
    const cfg = loadConfig();
    this.pool = new Pool({ connectionString: cfg.DATABASE_URL, max: 10 });
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  async withContext<T>(
    ctx: DbContext,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.tenant_id', $1, true),
                set_config('app.user_id', $2, true)`,
        [ctx.tenantId ?? '', ctx.userId ?? ''],
      );
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

  /** Single tenant-scoped query helper. */
  async query<R extends QueryResultRow>(
    ctx: DbContext,
    text: string,
    params: unknown[] = [],
  ): Promise<R[]> {
    return this.withContext(ctx, async (c) => {
      const res = await c.query<R>(text, params);
      return res.rows;
    });
  }

  async queryOne<R extends QueryResultRow>(
    ctx: DbContext,
    text: string,
    params: unknown[] = [],
  ): Promise<R | null> {
    const rows = await this.query<R>(ctx, text, params);
    return rows[0] ?? null;
  }
}
