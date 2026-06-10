import { ConflictException, ForbiddenException } from '@nestjs/common';
import { ActionsService } from './actions.service';
import type { DbService } from '../db/db.service';
import type { AuthContext } from '../auth/auth.types';

type Row = Record<string, unknown>;

/** Fake transaction client driven by a scripted table state. */
class FakeClient {
  queries: { sql: string; params: unknown[] }[] = [];
  constructor(private readonly responses: (sql: string, params: unknown[]) => Row[]) {}
  async query(sql: string, params: unknown[] = []): Promise<{ rows: Row[]; rowCount: number }> {
    this.queries.push({ sql, params });
    const rows = this.responses(sql, params);
    return { rows, rowCount: rows.length };
  }
}

function makeService(responses: (sql: string, params: unknown[]) => Row[]) {
  const client = new FakeClient(responses);
  const db = {
    withContext: async (_ctx: unknown, fn: (c: FakeClient) => Promise<unknown>) => fn(client),
  } as unknown as DbService;
  return { service: new ActionsService(db), client };
}

const baseAction: Row = {
  id: 'a1',
  recommendation_id: 'r1',
  kind: 'budget_change',
  status: 'awaiting_approval',
  diff: { summary: 'reduce budget 20%' },
  diff_hash: 'hash-the-user-saw-1234',
  payload: { magnitudeUsd: 240, healthDomain: 'spend' },
  guardrail_eval: [
    { key: 'max_budget_change_pct_per_day', description: '', passed: true, observed: {}, limit: {} },
  ],
  expires_at: null,
  autonomy_level: 2,
};

const approverAuth: AuthContext = {
  kind: 'user',
  userId: 'u1',
  tenantId: 't1',
  roleName: 'approver',
  permissions: new Set(['actions:read', 'actions:approve:budget_change']),
};

function happyResponses(overrides: Partial<Record<string, Row[]>> = {}) {
  return (sql: string): Row[] => {
    if (sql.includes('FROM actions WHERE id')) return overrides.action ?? [{ ...baseAction }];
    if (sql.includes('FROM health_status')) return overrides.health ?? [{ status: 'green' }];
    if (sql.includes('FROM approval_policies'))
      return (
        overrides.policy ?? [
          { rules: { maxMagnitudeUsd: 5000, twoPersonAboveUsd: null, expiryHours: 72 }, autonomy_level: 2 },
        ]
      );
    if (sql.includes('count(DISTINCT user_id)')) return overrides.approverCount ?? [{ n: '1' }];
    if (sql.includes('count(*) AS n FROM actions')) return [{ n: '0' }];
    return [];
  };
}

describe('ActionsService.approve — hard safety rules', () => {
  it('approves with the exact echoed diff hash and writes audit + approval', async () => {
    const { service, client } = makeService(happyResponses());
    const result = await service.approve(approverAuth, 'a1', 'hash-the-user-saw-1234');
    expect(result.status).toBe('approved');
    // L2: no execution path, the note says so explicitly.
    expect(result.note).toMatch(/Execution is not enabled/);
    const sqls = client.queries.map((q) => q.sql);
    expect(sqls.some((s) => s.includes('INSERT INTO approvals'))).toBe(true);
    expect(sqls.some((s) => s.includes("UPDATE actions SET status = 'approved'"))).toBe(true);
    expect(sqls.some((s) => s.includes('INSERT INTO audit_logs'))).toBe(true);
    // No execution-ish statements exist at all.
    expect(sqls.join(' ')).not.toMatch(/execut/i);
  });

  it('rejects a stale diff hash (the user approved something they did not see)', async () => {
    const { service } = makeService(happyResponses());
    await expect(
      service.approve(approverAuth, 'a1', 'a-different-hash-entirely'),
    ).rejects.toThrow(ConflictException);
  });

  it('refuses approval without the per-kind permission', async () => {
    const { service } = makeService(happyResponses());
    const viewer: AuthContext = { ...approverAuth, permissions: new Set(['actions:read']) };
    await expect(
      service.approve(viewer, 'a1', 'hash-the-user-saw-1234'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('refuses approval while any guardrail is failing', async () => {
    const failing = {
      ...baseAction,
      guardrail_eval: [
        { key: 'blast_radius_pct', description: '', passed: false, observed: { pct: 22 }, limit: { maxPct: 10 } },
      ],
    };
    const { service } = makeService(happyResponses({ action: [failing] }));
    await expect(
      service.approve(approverAuth, 'a1', 'hash-the-user-saw-1234'),
    ).rejects.toThrow(/Guardrails failing/);
  });

  it('blocks approval when the relevant health domain is red', async () => {
    const { service } = makeService(happyResponses({ health: [{ status: 'red' }] }));
    await expect(
      service.approve(approverAuth, 'a1', 'hash-the-user-saw-1234'),
    ).rejects.toThrow(/red/);
  });

  it('enforces the magnitude rule: big actions need an elevated role', async () => {
    const big = { ...baseAction, payload: { magnitudeUsd: 9000, healthDomain: 'spend' } };
    const { service } = makeService(happyResponses({ action: [big] }));
    await expect(
      service.approve(approverAuth, 'a1', 'hash-the-user-saw-1234'),
    ).rejects.toThrow(/elevated role/);
    // Same action, admin role: allowed.
    const admin: AuthContext = { ...approverAuth, roleName: 'admin' };
    const { service: s2 } = makeService(happyResponses({ action: [{ ...big }] }));
    await expect(s2.approve(admin, 'a1', 'hash-the-user-saw-1234')).resolves.toMatchObject({
      status: 'approved',
    });
  });

  it('holds the action at awaiting_approval until a second approver (two-person rule)', async () => {
    const { service } = makeService(
      happyResponses({
        policy: [{ rules: { maxMagnitudeUsd: 50000, twoPersonAboveUsd: 100 }, autonomy_level: 2 }],
        approverCount: [{ n: '1' }],
      }),
    );
    const result = await service.approve(approverAuth, 'a1', 'hash-the-user-saw-1234');
    expect(result.status).toBe('awaiting_approval');
    expect(result.note).toMatch(/second approver/);
  });

  it('expires stale actions instead of approving them', async () => {
    const expired = { ...baseAction, expires_at: new Date(Date.now() - 1000).toISOString() };
    const { service, client } = makeService(happyResponses({ action: [expired] }));
    await expect(
      service.approve(approverAuth, 'a1', 'hash-the-user-saw-1234'),
    ).rejects.toThrow(/expired/);
    expect(client.queries.some((q) => q.sql.includes("status = 'expired'"))).toBe(true);
  });

  it('refuses non-human approvals at autonomy level 2', async () => {
    const { service } = makeService(happyResponses());
    const serviceAuth: AuthContext = { ...approverAuth, kind: 'service' };
    await expect(
      service.approve(serviceAuth, 'a1', 'hash-the-user-saw-1234'),
    ).rejects.toThrow(ForbiddenException);
  });
});

describe('ActionsService.reject', () => {
  it('records rejection with reason and cascades to the recommendation', async () => {
    const { service, client } = makeService(happyResponses());
    await service.reject(approverAuth, 'a1', 'wrong_diagnosis', 'CPM rise was the real cause');
    const sqls = client.queries.map((q) => q.sql);
    expect(sqls.some((s) => s.includes('INSERT INTO approvals'))).toBe(true);
    expect(sqls.some((s) => s.includes("SET status = 'rejected'"))).toBe(true);
    expect(sqls.some((s) => s.includes('UPDATE recommendations'))).toBe(true);
  });
});
