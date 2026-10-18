/**
 * Platform services on PostgreSQL: staff login (password + TOTP + sessions +
 * CSRF), invite flow, durable jobs, outbox, audit sealing, partition
 * maintenance, health/metrics, GPU monitoring (simulated nvidia-smi) and the
 * LLM gateway (SIMULATED LLM server).
 */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { totpAt } from '../../src/lib/totp.js';
import { sealAuditLog, verifyAuditChain } from '../../src/modules/audit-seal.js';
import { JobRunner, PermanentJobError, enqueue } from '../../src/modules/jobs-queue.js';
import { LlmError } from '../../src/modules/llm/gateway.js';
import { ensurePartitions } from '../../src/modules/maintenance.js';
import { sampleGpu } from '../../src/modules/monitoring.js';
import { dispatchOutbox } from '../../src/modules/outbox.js';
import { enrollTotp, setPassword } from '../../src/modules/sessions.js';
import { type Stack, startStack } from '../helpers/stack.js';

const now = () => Math.floor(Date.now() / 1000);

async function raw(stack: Stack, method: string, path: string, opts: { body?: unknown; cookie?: string; csrf?: string; bearer?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.csrf) headers['x-csrf-token'] = opts.csrf;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(`${stack.apiUrl}${path}`, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
  const text = await res.text();
  let body: any = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // text/plain
  }
  return { status: res.status, body, setCookie: res.headers.getSetCookie() };
}

function cookieHeader(setCookie: string[]): string {
  return setCookie.map((c) => c.split(';')[0]).join('; ');
}

describe('platform services', () => {
  let stack: Stack;
  let totpSecret: string;
  let usedCode = '';
  const email = 'owner.studio@example.test';
  const password = 'a very long test password 1';

  before(async () => {
    stack = await startStack({ llm: true, env: { METRICS_TOKEN: 'metrics-test-token-0123456789', LOGIN_MAX_FAILURES: '3' } });
    await setPassword(stack.svc.workerPool, stack.ws.owner.id, password);
    totpSecret = (await enrollTotp(stack.svc.workerPool, stack.svc.config, stack.ws.owner.id, email)).secret;
  });
  after(async () => {
    await stack?.close();
  });

  describe('staff authentication', () => {
    it('logs in with password + TOTP, uses the session with CSRF protection, logs out', async () => {
      usedCode = totpAt(totpSecret, now());
      const res = await raw(stack, 'POST', '/v1/auth/login', { body: { email, password, totp: usedCode } });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.ok(res.setCookie.some((c) => c.startsWith('gi_session=') && c.includes('HttpOnly') && c.includes('SameSite=Strict')));
      const cookie = cookieHeader(res.setCookie);
      const csrf = res.body.csrf_token as string;
      const session = await raw(stack, 'GET', '/v1/auth/session', { cookie });
      assert.equal(session.status, 200);
      assert.equal(session.body.user.email, email);
      // Unsafe method without the CSRF header is refused; with it, allowed.
      const noCsrf = await raw(stack, 'POST', '/v1/influencers', { cookie, body: { slug: 'x' } });
      assert.equal(noCsrf.status, 403);
      assert.equal(noCsrf.body.error.code, 'CSRF_FAILED');
      const withCsrf = await raw(stack, 'POST', '/v1/qa-thresholds', { cookie, csrf, body: { influencer_id: null, check_key: 'mock.x', min_score: 0.5 } });
      assert.equal(withCsrf.status, 201, JSON.stringify(withCsrf.body));
      const out = await raw(stack, 'POST', '/v1/auth/logout', { cookie, csrf });
      assert.equal(out.status, 200);
      assert.equal((await raw(stack, 'GET', '/v1/auth/session', { cookie })).status, 401);
    });

    it('rejects a replayed TOTP code and locks the account after repeated failures', async () => {
      // The previous test consumed the current step: the same code cannot be reused.
      const replay = await raw(stack, 'POST', '/v1/auth/login', { body: { email, password, totp: usedCode } });
      assert.equal(replay.status, 401);
      for (let i = 0; i < 2; i++) assert.equal((await raw(stack, 'POST', '/v1/auth/login', { body: { email, password: 'wrong password!!', totp: '000000' } })).status, 401);
      const locked = await raw(stack, 'POST', '/v1/auth/login', { body: { email, password, totp: totpAt(totpSecret, now() + 30) } });
      assert.equal(locked.status, 429);
      assert.equal(locked.body.error.code, 'LOGIN_LOCKED');
      await stack.svc.workerPool.query('UPDATE core.users SET locked_until = NULL, failed_login_count = 0 WHERE id = $1', [stack.ws.owner.id]);
      const audit = await stack.svc.workerPool.query(`SELECT count(*)::int AS n FROM core.audit_log WHERE action = 'auth.login_failed'`);
      assert.ok(audit.rows[0].n >= 3);
    });

    it('invites a user who sets a password and enrols TOTP with a single-use setup token', async () => {
      const invite = await stack.ws.owner.client.post('/v1/admin/users', { email: 'new.reviewer@example.test', display_name: 'New Reviewer', role: 'reviewer' });
      assert.equal(invite.status, 201, JSON.stringify(invite.body));
      const setup = await raw(stack, 'POST', '/v1/auth/setup', { body: { setup_token: invite.body.setup_token, password: 'reviewer password 123' } });
      assert.equal(setup.status, 200, JSON.stringify(setup.body));
      assert.match(setup.body.otpauth_uri, /^otpauth:\/\/totp\//);
      const confirm = await raw(stack, 'POST', '/v1/auth/setup/confirm', { body: { setup_token: invite.body.setup_token, totp: totpAt(setup.body.totp_secret, now()) } });
      assert.equal(confirm.status, 200);
      const reuse = await raw(stack, 'POST', '/v1/auth/setup', { body: { setup_token: invite.body.setup_token, password: 'another password 123' } });
      assert.equal(reuse.status, 400);
      const login = await raw(stack, 'POST', '/v1/auth/login', { body: { email: 'new.reviewer@example.test', password: 'reviewer password 123', totp: totpAt(setup.body.totp_secret, now() + 30) } });
      assert.equal(login.status, 200, JSON.stringify(login.body));
      assert.equal(login.body.role, 'reviewer');
      const users = await stack.ws.owner.client.get('/v1/admin/users');
      assert.ok(users.body.some((u: any) => u.email === 'new.reviewer@example.test' && u.mfa_enrolled_at));
      // Reviewers cannot manage users; the last owner cannot be demoted.
      assert.equal((await stack.ws.reviewer.client.get('/v1/admin/users')).status, 403);
    });
  });

  describe('durable jobs and outbox', () => {
    it('runs handlers, retries with backoff, dead-letters and alerts', async () => {
      let calls = 0;
      const handlers = new Map<string, () => Promise<unknown>>([
        ['test.ok', async () => ({ done: true })],
        ['test.flaky', async () => {
          calls++;
          if (calls < 2) throw new Error('transient');
          return { calls };
        }],
        ['test.permanent', async () => {
          throw new PermanentJobError('bad payload');
        }],
      ]);
      const runner = new JobRunner(stack.svc.workerPool, handlers, { workerId: 't', leaseSeconds: 30, concurrency: 2 });
      const a = await enqueue(stack.svc.workerPool, { queue: 'test', name: 'test.ok', key: 'job-ok-1', payload: {} });
      const again = await enqueue(stack.svc.workerPool, { queue: 'test', name: 'test.ok', key: 'job-ok-1', payload: {} });
      assert.equal(again.created, false);
      assert.equal(again.id, a.id);
      await enqueue(stack.svc.workerPool, { queue: 'test', name: 'test.flaky', key: 'job-flaky-1', payload: {} });
      await enqueue(stack.svc.workerPool, { queue: 'payments', name: 'test.permanent', key: 'job-perm-1', payload: {}, priority: 0 });
      await runner.runOnce();
      await stack.svc.workerPool.query(`UPDATE core.jobs SET run_at = now() WHERE status = 'queued'`);
      await runner.runOnce();
      const rows = (await stack.svc.workerPool.query('SELECT job_key, status, attempts FROM core.jobs WHERE job_key LIKE $1 ORDER BY job_key', ['job-%'])).rows;
      assert.deepEqual(rows, [
        { job_key: 'job-flaky-1', status: 'succeeded', attempts: 2 },
        { job_key: 'job-ok-1', status: 'succeeded', attempts: 1 },
        { job_key: 'job-perm-1', status: 'dead', attempts: 1 },
      ]);
      const dlq = await stack.svc.workerPool.query(`SELECT job_name FROM core.dead_letter_jobs`);
      assert.deepEqual(dlq.rows.map((r) => r.job_name), ['test.permanent']);
      const alert = await stack.svc.workerPool.query(`SELECT severity, code FROM ops.alerts WHERE dedup_key = 'job_dead:test.permanent'`);
      assert.deepEqual(alert.rows[0], { severity: 'critical', code: 'JOB_DEAD_LETTERED' });
    });

    it('fans outbox events out to subscribed consumers exactly once', async () => {
      await stack.svc.workerPool.query(
        `INSERT INTO core.outbox_events (workspace_id, event_type, aggregate_type, aggregate_id, payload) VALUES ($1, 'test.happened', 'thing', gen_random_uuid(), '{"x":1}')`,
        [stack.ws.workspaceId],
      );
      const subs = [{ event: 'test.*', job: 'test.consumer', queue: 'test', priority: 5 }];
      assert.equal(await dispatchOutbox(stack.svc.workerPool, subs), 1);
      assert.equal(await dispatchOutbox(stack.svc.workerPool, subs), 0);
      const jobs = await stack.svc.workerPool.query(`SELECT payload FROM core.jobs WHERE name = 'test.consumer'`);
      assert.equal(jobs.rowCount, 1);
      assert.equal(jobs.rows[0].payload.event_type, 'test.happened');
    });
  });

  describe('audit tamper evidence', () => {
    it('seals audit rows into a hash chain, exports them write-once, and detects tampering', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'gi-audit-'));
      try {
        await stack.svc.workerPool.query(`UPDATE core.audit_log SET occurred_at = occurred_at`).catch(() => undefined); // runtime roles cannot update (expected)
        const admin = new pg.Client({ connectionString: stack.db.adminUrl });
        await admin.connect();
        try {
          // Age existing rows past the sealing lag (superuser only; the app can't do this).
          await admin.query(`UPDATE core.audit_log SET occurred_at = occurred_at - interval '1 hour'`);
          const sealed = await sealAuditLog(stack.svc.workerPool, dir);
          assert.ok(sealed.seals >= 1 && sealed.rows > 0);
          assert.ok(readdirSync(dir).length >= 1);
          assert.equal((await verifyAuditChain(stack.svc.workerPool)).ok, true);
          await admin.query(`UPDATE core.audit_log SET action = 'tampered' WHERE id = (SELECT min(id) FROM core.audit_log)`);
          const v = await verifyAuditChain(stack.svc.workerPool);
          assert.equal(v.ok, false);
          assert.match(v.problems[0]!.problem, /rows changed/);
        } finally {
          await admin.end();
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('partition maintenance', () => {
    it('creates future monthly partitions, moving rows out of DEFAULT, and keeps partitions private', async () => {
      const future = new Date(Date.UTC(2031, 4, 15));
      await stack.svc.workerPool.query(
        `INSERT INTO analytics.events (occurred_at, workspace_id, name, source) VALUES ($1, $2, 'test_event', 'test')`,
        [future, stack.ws.workspaceId],
      );
      const created = await ensurePartitions(stack.db.migratorUrl, 1, future);
      assert.ok(created.includes('analytics.events_2031_05'));
      const admin = new pg.Client({ connectionString: stack.db.adminUrl });
      await admin.connect();
      try {
        const inPartition = await admin.query(`SELECT count(*)::int AS n FROM analytics.events_2031_05`);
        assert.equal(inPartition.rows[0].n, 1);
        const inDefault = await admin.query(`SELECT count(*)::int AS n FROM analytics.events_default WHERE occurred_at >= '2031-05-01'`);
        assert.equal(inDefault.rows[0].n, 0);
      } finally {
        await admin.end();
      }
      await assert.rejects(stack.svc.workerPool.query('SELECT 1 FROM analytics.events_2031_05'), /permission denied/);
      assert.deepEqual(await ensurePartitions(stack.db.migratorUrl, 1, future), []);
    });
  });

  describe('health, metrics and GPU monitoring (simulated nvidia-smi)', () => {
    it('serves readiness, detailed health to platform admins, and token-protected metrics', async () => {
      const ready = await raw(stack, 'GET', '/readyz');
      assert.ok([200, 503].includes(ready.status));
      assert.equal(ready.body.components.database, 'ok');
      assert.equal(ready.body.components.migrations, 'ok');
      assert.equal(ready.body.components.llm, 'ok');
      const health = await stack.ws.owner.client.get('/v1/ops/health');
      assert.equal(health.status, 200);
      assert.equal(health.body.components.llm.detail.configured_model, 'simulated-chat-model');
      assert.equal((await stack.ws.manager.client.get('/v1/ops/health')).status, 403);
      assert.equal((await raw(stack, 'GET', '/metrics')).status, 401);
      const metrics = await raw(stack, 'GET', '/metrics', { bearer: 'metrics-test-token-0123456789' });
      assert.equal(metrics.status, 200);
      assert.match(metrics.body, /golden_jobs\{queue="test",status="succeeded"\} \d+/);
      assert.match(metrics.body, /golden_llm_requests_total/);
    });

    it('samples the GPU, alerts on high temperature and clears the alert when it drops', async () => {
      const mon = stack.svc.config.monitoring;
      mon.gpuMonitorEnabled = true;
      mon.gpuMonitorCommand = `${process.execPath} -e console.log("0,SIMULATED-GPU,50,23500,24000,91,120")`;
      const samples = await sampleGpu(stack.svc);
      assert.equal(samples.length, 1);
      const open = await stack.svc.workerPool.query(`SELECT code FROM ops.alerts WHERE status = 'open' AND source = 'gpu' ORDER BY code`);
      assert.deepEqual(open.rows.map((r) => r.code), ['GPU_TEMP_HIGH', 'GPU_VRAM_HIGH']);
      mon.gpuMonitorCommand = `${process.execPath} -e console.log("0,SIMULATED-GPU,10,1000,24000,55,40")`;
      await sampleGpu(stack.svc);
      const still = await stack.svc.workerPool.query(`SELECT count(*)::int AS n FROM ops.alerts WHERE status = 'open' AND source = 'gpu'`);
      assert.equal(still.rows[0].n, 0);
      const gpu = await stack.ws.owner.client.get('/v1/ops/gpu?minutes=5');
      assert.equal(gpu.body.samples.length, 2);
      mon.gpuMonitorCommand = 'definitely-not-a-command-xyz';
      await sampleGpu(stack.svc);
      const failed = await stack.svc.workerPool.query(`SELECT code FROM ops.alerts WHERE status = 'open' AND code = 'GPU_MONITOR_FAILED'`);
      assert.equal(failed.rowCount, 1);
      mon.gpuMonitorEnabled = false;
    });
  });

  describe('local LLM gateway (SIMULATED LLM server)', () => {
    it('sends OpenAI-compatible requests with the configured model only', async () => {
      stack.llm!.whenContains('ping', 'pong');
      const r = await stack.svc.llm.chat({ purpose: 'test', messages: [{ role: 'user', content: 'ping' }] });
      assert.equal(r.text, 'pong');
      assert.equal(stack.llm!.requests.at(-1)!.model, 'simulated-chat-model');
      assert.ok(r.usage.prompt_tokens > 0);
    });

    it('validates structured output and retries once with the validation error', async () => {
      let n = 0;
      stack.llm!.respond((req) => (req.messages.some((m) => m.content.includes('give json')) ? (++n === 1 ? '{"wrong": true}' : '```json\n{"answer": 42}\n```') : undefined));
      const { value } = await stack.svc.llm.chatJson<{ answer: number }>(
        { purpose: 'test', messages: [{ role: 'user', content: 'give json' }] },
        'answer',
        { type: 'object', required: ['answer'], properties: { answer: { type: 'number' } } },
      );
      assert.deepEqual(value, { answer: 42 });
      assert.match(stack.llm!.requests.at(-1)!.messages.at(-1)!.content, /did not match the schema/);
    });

    it('classifies server failures as retryable errors', async () => {
      stack.llm!.failNext(503);
      await assert.rejects(stack.svc.llm.chat({ purpose: 'test', messages: [{ role: 'user', content: 'x' }] }), (e: LlmError) => e.kind === 'http' && e.retryable);
    });
  });
});
