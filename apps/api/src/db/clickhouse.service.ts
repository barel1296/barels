import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { loadConfig } from '../config/config';

/**
 * Thin ClickHouse access used ONLY by the semantic metrics layer and the
 * ingestion writers. No other module may query ClickHouse directly — the
 * semantic layer is the single read path (docs/04 §4.6).
 */
@Injectable()
export class ClickHouseService implements OnModuleDestroy {
  private readonly client: ClickHouseClient;

  constructor() {
    const cfg = loadConfig();
    this.client = createClient({
      url: cfg.CLICKHOUSE_URL,
      database: cfg.CLICKHOUSE_DB,
      username: cfg.CLICKHOUSE_USER,
      password: cfg.CLICKHOUSE_PASSWORD,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.close();
  }

  async select<R extends Record<string, unknown>>(
    sql: string,
    params: Record<string, unknown>,
  ): Promise<R[]> {
    const rs = await this.client.query({
      query: sql,
      query_params: params,
      format: 'JSONEachRow',
    });
    return rs.json<R>();
  }

  async insertRows(
    table: string,
    rows: Record<string, unknown>[],
  ): Promise<void> {
    if (rows.length === 0) return;
    await this.client.insert({ table, values: rows, format: 'JSONEachRow' });
  }
}
