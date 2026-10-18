import pg from 'pg';

/**
 * Monthly partition maintenance for the partitioned tables. Runs as the schema
 * owner (aios_migrator, `npm run cli -- db:maintain`), daily from the Windows
 * scheduled task. Rows that already landed in the DEFAULT partition for a month
 * are moved into the new partition in the same transaction.
 */
export const PARTITIONED: { schema: string; table: string; column: string }[] = [
  { schema: 'core', table: 'audit_log', column: 'occurred_at' },
  { schema: 'conversation', table: 'messages', column: 'created_at' },
  { schema: 'analytics', table: 'metric_snapshots', column: 'captured_at' },
  { schema: 'analytics', table: 'events', column: 'occurred_at' },
  { schema: 'analytics', table: 'usage_events', column: 'occurred_at' },
];

function monthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function addMonths(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

export async function ensurePartitions(ownerUrl: string, monthsAhead = 3, now = new Date()): Promise<string[]> {
  const client = new pg.Client({ connectionString: ownerUrl, application_name: 'golden-maintenance' });
  await client.connect();
  const created: string[] = [];
  try {
    for (const t of PARTITIONED) {
      for (let i = 0; i <= monthsAhead; i++) {
        const from = addMonths(monthStart(now), i);
        const to = addMonths(from, 1);
        const name = `${t.table}_${from.getUTCFullYear()}_${String(from.getUTCMonth() + 1).padStart(2, '0')}`;
        const exists = await client.query(
          `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2`,
          [t.schema, name],
        );
        if (exists.rowCount) continue;
        await client.query('BEGIN');
        try {
          await client.query(`CREATE TABLE "${t.schema}"."${name}" (LIKE "${t.schema}"."${t.table}" INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`);
          await client.query(
            `WITH moved AS (DELETE FROM "${t.schema}"."${t.table}_default" WHERE "${t.column}" >= $1 AND "${t.column}" < $2 RETURNING *)
             INSERT INTO "${t.schema}"."${name}" SELECT * FROM moved`,
            [iso(from), iso(to)],
          );
          await client.query(`ALTER TABLE "${t.schema}"."${t.table}" ATTACH PARTITION "${t.schema}"."${name}" FOR VALUES FROM ('${iso(from)}') TO ('${iso(to)}')`);
          // Partitions are reached only through the parent, where RLS applies.
          await client.query(`REVOKE ALL ON "${t.schema}"."${name}" FROM aios_app, aios_worker`);
          await client.query('COMMIT');
          created.push(`${t.schema}.${name}`);
        } catch (err) {
          await client.query('ROLLBACK');
          throw new Error(`creating partition ${t.schema}.${name} failed: ${(err as Error).message}`);
        }
      }
    }
  } finally {
    await client.end();
  }
  return created;
}
