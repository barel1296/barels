import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import pg from 'pg';
import { paths } from '../../src/config.js';
import { bootstrapCluster, migrate } from '../../src/db/migrate.js';

/**
 * Throwaway database per test file on a real PostgreSQL 16 server.
 * TEST_PG_ADMIN_URL must point at a superuser connection (local cluster or the
 * CI postgres service). Roles are created by db/bootstrap.sql exactly as in
 * production; the schema comes from db/migrations.
 */
export const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? 'postgres://postgres@127.0.0.1:55432/postgres';
const ROLE_PASSWORD = process.env.TEST_PG_ROLE_PASSWORD ?? 'golden-test-only-password';

export interface TestDatabase {
  name: string;
  migratorUrl: string;
  appUrl: string;
  workerUrl: string;
  adminUrl: string;
  drop(): Promise<void>;
}

export function urlFor(base: string, user: string, password: string, database: string): string {
  const u = new URL(base);
  u.username = user;
  u.password = password;
  u.pathname = `/${database}`;
  return u.toString();
}

export async function createTestDatabase(): Promise<TestDatabase> {
  await bootstrapCluster(ADMIN_URL, resolve(paths.repoRoot, 'db/bootstrap.sql'), {
    migrator_password: ROLE_PASSWORD,
    app_password: ROLE_PASSWORD,
    worker_password: ROLE_PASSWORD,
  });
  const name = `gi_test_${randomBytes(5).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name} OWNER aios_migrator`);
    await admin.query(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${name} TO aios_app, aios_worker`);
  } finally {
    await admin.end();
  }
  const migratorUrl = urlFor(ADMIN_URL, 'aios_migrator', ROLE_PASSWORD, name);
  await migrate(migratorUrl, resolve(paths.repoRoot, 'db/migrations'));
  return {
    name,
    migratorUrl,
    appUrl: urlFor(ADMIN_URL, 'aios_app', ROLE_PASSWORD, name),
    workerUrl: urlFor(ADMIN_URL, 'aios_worker', ROLE_PASSWORD, name),
    adminUrl: urlFor(ADMIN_URL, new URL(ADMIN_URL).username, decodeURIComponent(new URL(ADMIN_URL).password), name),
    drop: async () => {
      const c = new pg.Client({ connectionString: ADMIN_URL });
      await c.connect();
      try {
        await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await c.end();
      }
    },
  };
}
