import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { sha256Hex } from '../lib/canonical-json.js';

export interface Migration {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export async function loadMigrations(dir: string): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => FILE_RE.test(f)).sort();
  const migrations: Migration[] = [];
  for (const file of files) {
    const m = FILE_RE.exec(file)!;
    // Normalise line endings so a Windows checkout produces the same checksum.
    const sql = (await readFile(join(dir, file), 'utf8')).replace(/\r\n/g, '\n');
    migrations.push({ version: m[1]!, name: m[2]!, sql, checksum: sha256Hex(sql) });
  }
  const versions = new Set(migrations.map((m) => m.version));
  if (versions.size !== migrations.length) throw new Error('duplicate migration version');
  return migrations;
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Applies pending migrations in order, each in its own transaction, under an
 * advisory lock (safe against concurrent runners). Refuses to run if an applied
 * migration's file changed (checksum mismatch).
 */
export async function migrate(connectionString: string, dir: string, log: (msg: string) => void = () => {}): Promise<MigrationResult> {
  const migrations = await loadMigrations(dir);
  const client = new pg.Client({ connectionString, application_name: 'golden-migrate' });
  await client.connect();
  try {
    await client.query(`SELECT pg_advisory_lock(hashtext('golden.schema_migrations'))`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        version    text PRIMARY KEY,
        name       text NOT NULL,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now(),
        applied_by text NOT NULL DEFAULT current_user
      )`);
    const { rows } = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM public.schema_migrations',
    );
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));
    for (const [version] of applied) {
      if (!migrations.some((m) => m.version === version)) throw new Error(`applied migration ${version} is missing from ${dir}`);
    }
    const result: MigrationResult = { applied: [], alreadyApplied: [] };
    for (const m of migrations) {
      const existing = applied.get(m.version);
      if (existing !== undefined) {
        if (existing !== m.checksum) {
          throw new Error(`migration ${m.version}_${m.name} was modified after it was applied (checksum mismatch)`);
        }
        result.alreadyApplied.push(m.version);
        continue;
      }
      log(`applying ${m.version}_${m.name}`);
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO public.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [
          m.version,
          m.name,
          m.checksum,
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`migration ${m.version}_${m.name} failed: ${(err as Error).message}`);
      }
      result.applied.push(m.version);
    }
    return result;
  } finally {
    await client.query(`SELECT pg_advisory_unlock(hashtext('golden.schema_migrations'))`).catch(() => undefined);
    await client.end();
  }
}

/**
 * Runs db/bootstrap.sql as a superuser, substituting psql-style :'name'
 * variables with escaped literals (same file works with `psql -v`).
 */
export async function bootstrapCluster(
  adminConnectionString: string,
  bootstrapFile: string,
  vars: Record<string, string>,
): Promise<void> {
  const raw = await readFile(bootstrapFile, 'utf8');
  const client = new pg.Client({ connectionString: adminConnectionString, application_name: 'golden-bootstrap' });
  await client.connect();
  try {
    // Like psql, only substitute outside comment lines.
    const sql = raw
      .split('\n')
      .map((line) =>
        line.trimStart().startsWith('--')
          ? line
          : line.replace(/:'([a-z_]+)'/g, (_m, name: string) => {
              const value = vars[name];
              if (value === undefined) throw new Error(`bootstrap variable ${name} not provided`);
              return client.escapeLiteral(value);
            }),
      )
      .join('\n');
    await client.query(sql);
  } finally {
    await client.end();
  }
}
