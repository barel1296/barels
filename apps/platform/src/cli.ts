import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import pg from 'pg';
import { loadConfig, paths } from './config.js';
import { withTx } from './db/tx.js';
import { bootstrapCluster, migrate } from './db/migrate.js';
import { uuidv7 } from './lib/ids.js';
import { audit } from './modules/audit.js';
import { issueApiToken } from './modules/auth.js';
import { closeServices, createServices } from './services.js';
import { runWorkerOnce } from './worker.js';
import { readFile } from 'node:fs/promises';
import { sealAuditLog, verifyAuditChain } from './modules/audit-seal.js';
import { ensurePartitions } from './modules/maintenance.js';
import { healthReport } from './modules/monitoring.js';
import { benchmarkLlm } from './modules/llm/bench.js';
import { LlmGateway } from './modules/llm/gateway.js';
import { writeFile } from 'node:fs/promises';
import { enrollTotp, issueSetupToken, setPassword } from './modules/sessions.js';

type Flags = Record<string, string | true>;

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[a.slice(2)] = next;
      i++;
    } else {
      flags[a.slice(2)] = true;
    }
  }
  return flags;
}

function need(flags: Flags, name: string): string {
  const v = flags[name];
  if (typeof v !== 'string' || !v) throw new Error(`--${name} is required`);
  return v;
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`environment variable ${name} is required`);
  return v;
}

const CLI_ACTOR = { type: 'system' as const, id: 'cli' };

const commands: Record<string, { help: string; run: (f: Flags) => Promise<void> }> = {
  'keys:generate': {
    help: 'Print fresh random values for MASTER_KEY, ASSET_URL_SECRET and a visual engine token',
    run: async () => {
      console.log(`MASTER_KEY=${randomBytes(32).toString('base64')}`);
      console.log(`ASSET_URL_SECRET=${randomBytes(32).toString('base64')}`);
      console.log(`VEC_ENGINE_TOKEN=${randomBytes(32).toString('base64url')}`);
    },
  },
  'db:bootstrap': {
    help: 'Create runtime roles and the database (superuser PG_ADMIN_URL; PG_*_PASSWORD) [--database golden]',
    run: async (f) => {
      const database = typeof f.database === 'string' ? f.database : 'golden';
      if (!/^[a-z_][a-z0-9_]{0,62}$/.test(database)) throw new Error('invalid database name');
      await bootstrapCluster(env('PG_ADMIN_URL'), resolve(paths.repoRoot, 'db/bootstrap.sql'), {
        migrator_password: env('PG_MIGRATOR_PASSWORD'),
        app_password: env('PG_APP_PASSWORD'),
        worker_password: env('PG_WORKER_PASSWORD'),
      });
      const admin = new pg.Client({ connectionString: env('PG_ADMIN_URL') });
      await admin.connect();
      try {
        const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
        if (exists.rowCount === 0) await admin.query(`CREATE DATABASE ${database} OWNER aios_migrator`);
        await admin.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
        await admin.query(`GRANT CONNECT ON DATABASE ${database} TO aios_app, aios_worker`);
      } finally {
        await admin.end();
      }
      console.log(`roles aios_migrator/aios_app/aios_worker ready; database ${database} owned by aios_migrator`);
    },
  },
  'db:migrate': {
    help: 'Apply pending migrations (MIGRATION_DATABASE_URL, as aios_migrator)',
    run: async () => {
      const dir = process.env.MIGRATIONS_DIR ?? resolve(paths.repoRoot, 'db/migrations');
      const result = await migrate(env('MIGRATION_DATABASE_URL'), dir, (m) => console.log(m));
      console.log(`applied: [${result.applied.join(', ')}]; already applied: [${result.alreadyApplied.join(', ')}]`);
    },
  },
  'workspace:create': {
    help: 'Create a workspace with an owner user and print the owner API token: --slug --name --owner-email --owner-name [--platform-admin]',
    run: async (f) => {
      const svc = createServices(loadConfig());
      try {
        const out = await withTx(svc.workerPool, async (db) => {
          const ws = uuidv7();
          const user = uuidv7();
          await db.query('INSERT INTO core.workspaces (id, slug, name) VALUES ($1, $2, $3)', [ws, need(f, 'slug'), need(f, 'name')]);
          await db.query(
            `INSERT INTO core.users (id, email, display_name, idp_issuer, idp_subject, is_platform_admin) VALUES ($1, $2, $3, 'local', $2::citext::text, $4)`,
            [user, need(f, 'owner-email'), need(f, 'owner-name'), f['platform-admin'] === true],
          );
          await db.query(
            `INSERT INTO core.memberships (workspace_id, user_id, role_id) SELECT $1, $2, id FROM core.roles WHERE key = 'owner' AND workspace_id IS NULL`,
            [ws, user],
          );
          const token = await issueApiToken(db, { userId: user, workspaceId: ws, name: 'cli bootstrap', createdBy: null });
          await audit(db, { workspaceId: ws, actor: CLI_ACTOR, action: 'workspace.create', subjectType: 'workspace', subjectId: ws, metadata: { owner_user_id: user, platform_admin: f['platform-admin'] === true } });
          return { workspace_id: ws, user_id: user, token: token.token };
        });
        console.log(JSON.stringify(out, null, 2));
        console.log('Store the token now; it cannot be shown again.');
      } finally {
        await closeServices(svc);
      }
    },
  },
  'user:add': {
    help: 'Add a user to a workspace with a system role and print an API token: --workspace <slug> --email --name --role [--platform-admin]',
    run: async (f) => {
      const svc = createServices(loadConfig());
      try {
        const out = await withTx(svc.workerPool, async (db) => {
          const ws = await db.query<{ id: string }>('SELECT id FROM core.workspaces WHERE slug = $1', [need(f, 'workspace')]);
          if (!ws.rows[0]) throw new Error('workspace not found');
          const role = await db.query<{ id: string }>('SELECT id FROM core.roles WHERE key = $1 AND workspace_id IS NULL', [need(f, 'role')]);
          if (!role.rows[0]) throw new Error('unknown role');
          const user = uuidv7();
          await db.query(
            `INSERT INTO core.users (id, email, display_name, idp_issuer, idp_subject, is_platform_admin) VALUES ($1, $2, $3, 'local', $2::citext::text, $4)`,
            [user, need(f, 'email'), need(f, 'name'), f['platform-admin'] === true],
          );
          await db.query('INSERT INTO core.memberships (workspace_id, user_id, role_id) VALUES ($1, $2, $3)', [ws.rows[0].id, user, role.rows[0].id]);
          const token = await issueApiToken(db, { userId: user, workspaceId: ws.rows[0].id, name: 'cli', createdBy: null });
          await audit(db, { workspaceId: ws.rows[0].id, actor: CLI_ACTOR, action: 'membership.create', subjectType: 'user', subjectId: user, metadata: { role: f.role } });
          return { user_id: user, token: token.token };
        });
        console.log(JSON.stringify(out, null, 2));
      } finally {
        await closeServices(svc);
      }
    },
  },
  'db:maintain': {
    help: 'Create upcoming monthly partitions (MIGRATION_DATABASE_URL, as aios_migrator) [--months 3]',
    run: async (f) => {
      const months = typeof f.months === 'string' ? Number(f.months) : 3;
      const created = await ensurePartitions(env('MIGRATION_DATABASE_URL'), months);
      console.log(created.length ? `created: ${created.join(', ')}` : 'all partitions present');
    },
  },
  'user:set-password': {
    help: 'Set a user password from env GI_NEW_PASSWORD (never pass passwords as arguments): --email',
    run: async (f) => {
      const svc = createServices(loadConfig());
      try {
        const u = await svc.workerPool.query<{ id: string }>('SELECT id FROM core.users WHERE email = $1', [need(f, 'email')]);
        if (!u.rows[0]) throw new Error('user not found');
        await setPassword(svc.workerPool, u.rows[0].id, env('GI_NEW_PASSWORD'));
        console.log('password set; existing sessions revoked');
      } finally {
        await closeServices(svc);
      }
    },
  },
  'user:enroll-totp': {
    help: 'Generate a new TOTP secret for a user and print the otpauth URI once: --email',
    run: async (f) => {
      const svc = createServices(loadConfig());
      try {
        const u = await svc.workerPool.query<{ id: string; email: string }>('SELECT id, email FROM core.users WHERE email = $1', [need(f, 'email')]);
        if (!u.rows[0]) throw new Error('user not found');
        const r = await enrollTotp(svc.workerPool, svc.config, u.rows[0].id, u.rows[0].email);
        console.log(`otpauth URI (add to an authenticator app, then discard):\n${r.uri}\nsecret: ${r.secret}`);
      } finally {
        await closeServices(svc);
      }
    },
  },
  'user:setup-token': {
    help: 'Issue a single-use 24 h account setup token (password + TOTP enrolment via /v1/auth/setup): --email',
    run: async (f) => {
      const svc = createServices(loadConfig());
      try {
        const u = await svc.workerPool.query<{ id: string }>('SELECT id FROM core.users WHERE email = $1', [need(f, 'email')]);
        if (!u.rows[0]) throw new Error('user not found');
        console.log(await issueSetupToken(svc.workerPool, u.rows[0].id));
      } finally {
        await closeServices(svc);
      }
    },
  },
  'audit:seal': {
    help: 'Seal new audit rows into the hash chain now',
    run: async () => {
      const svc = createServices(loadConfig());
      try {
        console.log(JSON.stringify(await sealAuditLog(svc.workerPool, svc.config.monitoring.auditExportDir)));
      } finally {
        await closeServices(svc);
      }
    },
  },
  'audit:verify': {
    help: 'Recompute the audit seal chain and report tampering (exit 1 on problems)',
    run: async () => {
      const svc = createServices(loadConfig());
      try {
        const r = await verifyAuditChain(svc.workerPool);
        console.log(JSON.stringify(r, null, 2));
        if (!r.ok) process.exitCode = 1;
      } finally {
        await closeServices(svc);
      }
    },
  },
  'backup:record': {
    help: 'Record a backup/restore run from a manifest JSON written by the backup scripts: --manifest <file> [--kind backup|restore_test|restore]',
    run: async (f) => {
      // Files written by Windows PowerShell 5.1 may start with a byte-order mark.
      const manifest = JSON.parse((await readFile(need(f, 'manifest'), 'utf8')).replace(/^\uFEFF/, '')) as { started_at: string; finished_at?: string; status: string; location?: string; error?: string };
      const kind = typeof f.kind === 'string' ? f.kind : 'backup';
      const svc = createServices(loadConfig());
      try {
        await svc.workerPool.query(
          `INSERT INTO ops.backup_runs (kind, started_at, finished_at, status, manifest, location, error, recorded_by) VALUES ($1, $2, $3, $4, $5, $6, $7, 'cli')`,
          [kind, manifest.started_at, manifest.finished_at ?? null, manifest.status, JSON.stringify(manifest), manifest.location ?? null, manifest.error ?? null],
        );
        console.log(`recorded ${kind} (${manifest.status})`);
      } finally {
        await closeServices(svc);
      }
    },
  },
  health: {
    help: 'Print the detailed component health report (exit 1 if down)',
    run: async () => {
      const svc = createServices(loadConfig());
      try {
        const r = await healthReport(svc);
        console.log(JSON.stringify(r, null, 2));
        if (r.status === 'down') process.exitCode = 1;
      } finally {
        await closeServices(svc);
      }
    },
  },
  'llm:bench': {
    help: 'Measure the configured local LLM (--runs 20 --concurrency 2 [--out report.json]); needs LLM_BASE_URL and LLM_CHAT_MODEL',
    run: async (f) => {
      const cfg = loadConfig();
      const report = await benchmarkLlm(new LlmGateway(cfg.llm), { runs: Number(f.runs ?? 20), concurrency: Number(f.concurrency ?? 2), baseUrl: cfg.llm.baseUrl });
      const text = JSON.stringify(report, null, 2);
      if (typeof f.out === 'string') await writeFile(f.out, text);
      console.log(text);
    },
  },
  'worker:once': {
    help: 'Run one pass of every background step (dispatch, poll, ingest recovery, publish)',
    run: async () => {
      const svc = createServices(loadConfig());
      try {
        await runWorkerOnce(svc);
      } finally {
        await closeServices(svc);
      }
    },
  },
};

async function main(): Promise<void> {
  const [name, ...rest] = process.argv.slice(2);
  const cmd = name ? commands[name] : undefined;
  if (!cmd) {
    console.log('Usage: npm run cli -- <command> [flags]\n');
    for (const [n, c] of Object.entries(commands)) console.log(`  ${n.padEnd(18)} ${c.help}`);
    process.exit(name ? 1 : 0);
  }
  await cmd.run(parseFlags(rest));
}

main().catch((err) => {
  console.error(`error: ${(err as Error).message}`);
  process.exit(1);
});
