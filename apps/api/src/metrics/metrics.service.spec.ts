import { BadRequestException } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import type { DbService } from '../db/db.service';
import type { ClickHouseService } from '../db/clickhouse.service';

const spendDef = {
  key: 'spend',
  version: 1,
  display_name: 'Spend',
  formula: { table: 'spend_metrics_daily', timeCol: 'date', valueExpr: 'sum(spend_usd)' },
  dimensions: ['channel', 'campaign_id', 'country', 'platform'],
  grains: ['day', 'week', 'month'],
  value_format: 'currency',
  caveats: [],
};

function makeService(chRows: Record<string, unknown>[][] = [[]]) {
  const captured: { sql: string; params: Record<string, unknown> }[] = [];
  let call = 0;
  const db = {
    query: async () => [spendDef],
  } as unknown as DbService;
  const ch = {
    select: async (sql: string, params: Record<string, unknown>) => {
      captured.push({ sql, params });
      const rows = chRows[Math.min(call, chRows.length - 1)] ?? [];
      call += 1;
      return rows;
    },
  } as unknown as ClickHouseService;
  return { service: new MetricsService(db, ch), captured };
}

const baseReq = {
  metricKey: 'spend',
  grain: 'day' as const,
  dimensions: [] as string[],
  filters: {} as Record<string, string | string[]>,
  range: { from: '2026-05-01', to: '2026-05-31' },
};

describe('MetricsService — the single read path', () => {
  it('builds a tenant-scoped, parameter-bound query', async () => {
    const { service, captured } = makeService([[{ bucket: '2026-05-01', value: 100 }]]);
    const res = await service.query('11111111-1111-4111-8111-111111111111', baseReq);
    const main = captured[0]!;
    expect(main.sql).toContain('tenant_id = {tenantId:UUID}');
    expect(main.params.tenantId).toBe('11111111-1111-4111-8111-111111111111');
    expect(res.rows).toHaveLength(1);
    expect(res.sqlHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects dimensions outside the definition allowlist', async () => {
    const { service } = makeService();
    await expect(
      service.query('t', { ...baseReq, dimensions: ['user_id'] }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects filters outside the allowlist (no arbitrary WHERE injection)', async () => {
    const { service } = makeService();
    await expect(
      service.query('t', { ...baseReq, filters: { 'spend_usd; DROP TABLE x': 'oops' } }),
    ).rejects.toThrow(BadRequestException);
  });

  it('never string-interpolates filter values — they travel as bound params', async () => {
    const { service, captured } = makeService([[]]);
    const hostile = "DE' OR 1=1 --";
    await service.query('t', { ...baseReq, filters: { country: hostile } });
    const main = captured[0]!;
    expect(main.sql).not.toContain(hostile);
    expect(main.sql).toContain('country IN {f0:Array(String)}');
    expect(main.params.f0).toEqual([hostile]);
  });

  it('rejects grains not allowed by the definition', async () => {
    const { service } = makeService();
    await expect(
      service.query('t', { ...baseReq, grain: 'hour' as 'day' }),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('MetricsService.decompose', () => {
  it('computes group_delta_share contributions deterministically', async () => {
    const windowA = [
      { country: 'DE', value: 100 },
      { country: 'US', value: 200 },
    ];
    const windowB = [
      { country: 'DE', value: 40 },
      { country: 'US', value: 210 },
    ];
    const { service } = makeService([windowA, windowB]);
    const res = await service.decompose('t', {
      metricKey: 'spend',
      windowA: { from: '2026-05-01', to: '2026-05-07' },
      windowB: { from: '2026-05-08', to: '2026-05-14' },
      dimensions: ['country'],
      filters: {},
    });
    expect(res.totalDelta).toBe(-50);
    const de = res.contributors.find((c) => c.group.country === 'DE')!;
    expect(de.delta).toBe(-60);
    expect(de.deltaShare).toBeCloseTo(1.2);
    // Largest absolute contributor first.
    expect(res.contributors[0]!.group.country).toBe('DE');
  });
});
