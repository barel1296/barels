/**
 * End-to-end API tests against a REAL Postgres (migrations applied).
 * Gated on E2E_DATABASE_URL — run locally with infra up, and in CI with a
 * postgres service container. Covers: registration bootstrap, cross-tenant
 * isolation through the full HTTP stack, RBAC on approvals, the diff-hash
 * echo, idempotency replay, and the audit trail.
 */
import { randomUUID } from 'node:crypto';

const E2E_URL = process.env.E2E_DATABASE_URL;
if (E2E_URL) {
  process.env.DATABASE_URL = E2E_URL;
  process.env.DATABASE_URL_OWNER = process.env.E2E_DATABASE_URL_OWNER ?? E2E_URL;
}

const describeIf = E2E_URL ? describe : describe.skip;

describeIf('API e2e (live Postgres)', () => {
  jest.setTimeout(60_000);

  /* eslint-disable @typescript-eslint/no-require-imports */
  const { Test } = require('@nestjs/testing') as typeof import('@nestjs/testing');
  const request = require('supertest') as typeof import('supertest');
  const { Pool } = require('pg') as typeof import('pg');
  const { canonicalJson } = require('@gros/shared') as typeof import('@gros/shared');
  const { sha256Hex } = require('../common/crypto') as typeof import('../common/crypto');
  const { AppModule } = require('../app.module') as typeof import('../app.module');
  /* eslint-enable @typescript-eslint/no-require-imports */

  let app: import('@nestjs/common').INestApplication;
  let server: Parameters<typeof request>[0];
  let ownerPool: import('pg').Pool;

  const run = randomUUID().slice(0, 8);
  const userA = { email: `a-${run}@e2e.test`, password: 'long-password-A1!' };
  const userB = { email: `b-${run}@e2e.test`, password: 'long-password-B1!' };
  let tokenA = '';
  let tokenB = '';
  let tenantA = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    server = app.getHttpServer();
    ownerPool = new Pool({
      connectionString: process.env.DATABASE_URL_OWNER,
      max: 2,
    });
  });

  afterAll(async () => {
    await app?.close();
    await ownerPool?.end();
  });

  it('registers two tenants (bootstrap: owner role, policies, health domains)', async () => {
    const resA = await request(server).post('/v1/auth/register').send({
      ...userA,
      name: 'Owner A',
      tenantName: 'Tenant A',
      tenantSlug: `e2e-a-${run}`,
    });
    expect(resA.status).toBe(201);
    tokenA = resA.body.accessToken;
    tenantA = resA.body.tenantId;

    const resB = await request(server).post('/v1/auth/register').send({
      ...userB,
      name: 'Owner B',
      tenantName: 'Tenant B',
      tenantSlug: `e2e-b-${run}`,
    });
    expect(resB.status).toBe(201);
    tokenB = resB.body.accessToken;

    // Bootstrap created default approval policies + green health domains.
    const policies = await request(server)
      .get('/v1/approval-policies')
      .set('authorization', `Bearer ${tokenA}`);
    expect(policies.status).toBe(200);
    expect(policies.body.items.length).toBe(7);
    expect(policies.body.items.every((p: { autonomy_level: number }) => p.autonomy_level === 2)).toBe(true);
  });

  it('argon2id is used for new password hashes', async () => {
    const row = await ownerPool.query(
      `SELECT password_hash FROM users WHERE email = $1`,
      [userA.email],
    );
    expect(row.rows[0].password_hash).toMatch(/^\$argon2id\$/);
  });

  it('enforces cross-tenant isolation through the HTTP stack', async () => {
    // Tenant A creates business memory implicitly via its rows; check several
    // list endpoints under B's token never include A's tenant data.
    const meB = await request(server)
      .get('/v1/auth/me')
      .set('authorization', `Bearer ${tokenB}`);
    expect(meB.body.tenant.slug).toBe(`e2e-b-${run}`);

    for (const path of ['/v1/sessions', '/v1/actions', '/v1/recommendations', '/v1/audit-logs']) {
      const res = await request(server).get(path).set('authorization', `Bearer ${tokenB}`);
      expect(res.status).toBe(200);
      const items: { tenant_id?: string }[] = res.body.items ?? [];
      expect(items.every((i) => !i.tenant_id || i.tenant_id !== tenantA)).toBe(true);
    }

    // Unauthenticated requests are rejected.
    const anon = await request(server).get('/v1/sessions');
    expect(anon.status).toBe(401);
  });

  describe('approval workflow', () => {
    let actionId = '';
    let diffHash = '';

    beforeAll(async () => {
      // Prepare an action the way the worker publisher does (direct SQL with
      // tenant context), including a passing guardrail evaluation.
      const client = await ownerPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);
        const session = await client.query(
          `INSERT INTO agent_sessions (tenant_id, playbook_key, trigger_type, title, phase, status)
           VALUES ($1, 'roas_drop', 'user', 'e2e session', 'published', 'published') RETURNING id`,
          [tenantA],
        );
        const diff = {
          summary: 'e2e: reduce budget',
          entries: [{ field: 'daily_budget_usd', entity: 'E2E_Campaign', before: 1000, after: 800 }],
        };
        diffHash = sha256Hex(canonicalJson(diff));
        const action = await client.query(
          `INSERT INTO actions (tenant_id, session_id, kind, target, diff, diff_hash,
                                payload, execution_plan, rollback_plan, monitoring_plan,
                                guardrail_eval, status, idempotency_key)
           VALUES ($1, $2, 'budget_change', $3, $4, $5, $6, $7, $8, $9, $10,
                   'awaiting_approval', $11)
           RETURNING id`,
          [
            tenantA,
            session.rows[0].id,
            JSON.stringify({ entityType: 'campaign', entityId: randomUUID() }),
            JSON.stringify(diff),
            diffHash,
            JSON.stringify({ magnitudeUsd: 200, healthDomain: 'spend' }),
            JSON.stringify({ steps: ['e2e'] }),
            JSON.stringify({ steps: ['restore 1000'] }),
            JSON.stringify({ watchMetric: 'cpi', revertThresholdPct: 20 }),
            JSON.stringify([{ key: 'max_budget_change_pct_per_day', description: '', passed: true, observed: {}, limit: {} }]),
            randomUUID(),
          ],
        );
        actionId = action.rows[0].id;
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    });

    it('rejects approval with a stale diff hash (409)', async () => {
      const res = await request(server)
        .post(`/v1/actions/${actionId}/approve`)
        .set('authorization', `Bearer ${tokenA}`)
        .send({ confirmDiffHash: 'not-the-hash-that-was-rendered' });
      expect(res.status).toBe(409);
      expect(res.body.detail).toMatch(/Diff hash mismatch/);
    });

    it("rejects another tenant's approval attempt entirely (404)", async () => {
      const res = await request(server)
        .post(`/v1/actions/${actionId}/approve`)
        .set('authorization', `Bearer ${tokenB}`)
        .send({ confirmDiffHash: diffHash });
      expect(res.status).toBe(404);
    });

    it('rejects a viewer without the per-kind permission (403)', async () => {
      const invite = await request(server)
        .post('/v1/tenant/members/invite')
        .set('authorization', `Bearer ${tokenA}`)
        .send({ email: `viewer-${run}@e2e.test`, name: 'Viewer', role: 'viewer' });
      expect(invite.status).toBe(201);
      const login = await request(server).post('/v1/auth/login').send({
        email: `viewer-${run}@e2e.test`,
        password: invite.body.temporaryPassword,
      });
      expect(login.status).toBe(200);
      const res = await request(server)
        .post(`/v1/actions/${actionId}/approve`)
        .set('authorization', `Bearer ${login.body.accessToken}`)
        .send({ confirmDiffHash: diffHash });
      expect(res.status).toBe(403);
    });

    it('approves with the exact rendered hash and writes the audit trail', async () => {
      const res = await request(server)
        .post(`/v1/actions/${actionId}/approve`)
        .set('authorization', `Bearer ${tokenA}`)
        .send({ confirmDiffHash: diffHash });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('approved');
      expect(res.body.note).toMatch(/Execution is not enabled/);

      const audit = await request(server)
        .get('/v1/audit-logs?event=action.approved')
        .set('authorization', `Bearer ${tokenA}`);
      expect(audit.body.items.length).toBeGreaterThan(0);
      expect(audit.body.items[0].object_id).toBe(actionId);
    });

    it('cannot approve twice (state machine)', async () => {
      const res = await request(server)
        .post(`/v1/actions/${actionId}/approve`)
        .set('authorization', `Bearer ${tokenA}`)
        .send({ confirmDiffHash: diffHash });
      expect(res.status).toBe(409);
    });
  });

  it('replays idempotent POSTs instead of re-executing them', async () => {
    const key = `e2e-${run}-session`;
    const payload = { question: 'Why did ROAS drop in e2e land?', playbookKey: 'roas_drop', scope: {} };
    const first = await request(server)
      .post('/v1/sessions')
      .set('authorization', `Bearer ${tokenA}`)
      .set('idempotency-key', key)
      .send(payload);
    expect(first.status).toBe(201);
    const second = await request(server)
      .post('/v1/sessions')
      .set('authorization', `Bearer ${tokenA}`)
      .set('idempotency-key', key)
      .send(payload);
    expect(second.body.id).toBe(first.body.id);

    const conflicting = await request(server)
      .post('/v1/sessions')
      .set('authorization', `Bearer ${tokenA}`)
      .set('idempotency-key', key)
      .send({ ...payload, question: 'A different question entirely?' });
    expect(conflicting.status).toBe(422);
  });
});
