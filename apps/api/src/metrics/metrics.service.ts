import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  DecomposeRequest,
  MetricQueryRequest,
  MetricQueryResponse,
} from '@gros/shared';
import { DbService } from '../db/db.service';
import { ClickHouseService } from '../db/clickhouse.service';
import { sha256Hex } from '../common/crypto';

interface MetricDef {
  key: string;
  version: number;
  display_name: string;
  formula: { table: string; timeCol: string; valueExpr: string; defaultWhere?: string };
  dimensions: string[];
  grains: string[];
  value_format: string;
  caveats: string[];
}

/** Column types for parameter binding per known dimension. */
const DIMENSION_TYPES: Record<string, 'UUID' | 'String'> = {
  campaign_id: 'UUID',
  creative_id: 'UUID',
  ad_group_id: 'UUID',
  ad_id: 'UUID',
  app_id: 'UUID',
  channel: 'String',
  country: 'String',
  platform: 'String',
  media_source: 'String',
  store: 'String',
  kind: 'String',
  source_install: 'String',
};

const ALLOWED_TABLES = new Set([
  'spend_metrics_daily',
  'cohort_metrics',
  'creative_metrics_daily',
  'revenue_events',
  'events',
  'attribution',
]);

/**
 * The semantic metrics layer: THE single read path for UI, agents and API
 * consumers (docs/04 §4.6). Queries are composed from reviewed metric
 * definitions; user input only selects among allowlisted dimensions/filters
 * and is always parameter-bound — never string-interpolated.
 */
@Injectable()
export class MetricsService {
  constructor(
    private readonly db: DbService,
    private readonly ch: ClickHouseService,
  ) {}

  async listDefinitions(tenantId: string): Promise<MetricDef[]> {
    const rows = await this.db.query<MetricDef & { formula: unknown; caveats: unknown }>(
      { tenantId },
      `SELECT DISTINCT ON (key) key, version, display_name, formula, dimensions,
              grains, value_format, caveats
         FROM metric_definitions
        WHERE status = 'active' AND (tenant_id IS NULL OR tenant_id = $1)
        ORDER BY key, tenant_id NULLS LAST, version DESC`,
      [tenantId],
    );
    return rows as unknown as MetricDef[];
  }

  async getDefinition(tenantId: string, key: string): Promise<MetricDef> {
    const defs = await this.listDefinitions(tenantId);
    const def = defs.find((d) => d.key === key);
    if (!def) throw new NotFoundException(`Unknown metric: ${key}`);
    if (!ALLOWED_TABLES.has(def.formula.table)) {
      throw new BadRequestException(`Metric ${key} references unknown table`);
    }
    return def;
  }

  async query(tenantId: string, req: MetricQueryRequest): Promise<MetricQueryResponse> {
    const def = await this.getDefinition(tenantId, req.metricKey);
    this.validateRequest(def, req.dimensions, req.grain, req.filters);

    const { sql, params } = this.buildQuery(def, tenantId, req);
    const rows = await this.ch.select<Record<string, unknown>>(sql, params);
    const freshness = await this.freshness(def, tenantId);

    return {
      metricKey: def.key,
      metricVersion: def.version,
      grain: req.grain,
      dimensions: req.dimensions,
      rows,
      freshnessAt: freshness,
      caveats: def.caveats ?? [],
      sqlHash: sha256Hex(sql + JSON.stringify(params)),
    };
  }

  /**
   * Deterministic contribution analysis of a metric change between two
   * windows across one or more dimensions (docs/09 §9.4). Method:
   * group_delta_share — exact for additive metrics; for ratio metrics the
   * response carries an explicit caveat.
   */
  async decompose(tenantId: string, req: DecomposeRequest) {
    const def = await this.getDefinition(tenantId, req.metricKey);
    this.validateRequest(def, req.dimensions, 'day', req.filters);

    const run = async (from: string, to: string) => {
      const { sql, params } = this.buildQuery(def, tenantId, {
        metricKey: req.metricKey,
        grain: 'day',
        dimensions: req.dimensions,
        filters: req.filters,
        range: { from, to },
        aggregateOverTime: true,
      });
      return this.ch.select<Record<string, unknown>>(sql, params);
    };

    const [rowsA, rowsB] = await Promise.all([
      run(req.windowA.from, req.windowA.to),
      run(req.windowB.from, req.windowB.to),
    ]);

    const keyOf = (r: Record<string, unknown>) =>
      req.dimensions.map((d) => String(r[d] ?? '')).join('␟');
    const mapA = new Map(rowsA.map((r) => [keyOf(r), Number(r.value ?? 0)]));
    const mapB = new Map(rowsB.map((r) => [keyOf(r), Number(r.value ?? 0)]));
    const allKeys = new Set([...mapA.keys(), ...mapB.keys()]);

    const totalA = [...mapA.values()].reduce((a, b) => a + b, 0);
    const totalB = [...mapB.values()].reduce((a, b) => a + b, 0);
    const totalDelta = totalB - totalA;

    const contributors = [...allKeys]
      .map((k) => {
        const va = mapA.get(k) ?? 0;
        const vb = mapB.get(k) ?? 0;
        const labelParts = k.split('␟');
        const label = Object.fromEntries(
          req.dimensions.map((d, i) => [d, labelParts[i] ?? '']),
        );
        return {
          group: label,
          valueA: va,
          valueB: vb,
          delta: vb - va,
          deltaShare: totalDelta !== 0 ? (vb - va) / totalDelta : 0,
        };
      })
      .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
      .slice(0, 50);

    const isAdditive = !/nullif|\//i.test(def.formula.valueExpr);
    return {
      metricKey: def.key,
      metricVersion: def.version,
      method: 'group_delta_share',
      windowA: { ...req.windowA, total: totalA },
      windowB: { ...req.windowB, total: totalB },
      totalDelta,
      contributors,
      caveats: isAdditive
        ? []
        : [
            'Metric is a ratio; group_delta_share decomposition reflects group-level ratio deltas, not exact additive contribution.',
          ],
    };
  }

  private validateRequest(
    def: MetricDef,
    dimensions: string[],
    grain: string,
    filters: Record<string, string | string[]>,
  ): void {
    for (const d of dimensions) {
      if (!def.dimensions.includes(d)) {
        throw new BadRequestException(`Dimension not allowed for ${def.key}: ${d}`);
      }
    }
    if (!def.grains.includes(grain)) {
      throw new BadRequestException(`Grain not allowed for ${def.key}: ${grain}`);
    }
    for (const f of Object.keys(filters)) {
      if (!def.dimensions.includes(f)) {
        throw new BadRequestException(`Filter not allowed for ${def.key}: ${f}`);
      }
    }
  }

  private buildQuery(
    def: MetricDef,
    tenantId: string,
    req: {
      metricKey: string;
      grain: string;
      dimensions: string[];
      filters: Record<string, string | string[]>;
      range: { from: string; to: string };
      aggregateOverTime?: boolean;
    },
  ): { sql: string; params: Record<string, unknown> } {
    const f = def.formula;
    const dateExpr = `toDate(${f.timeCol})`;
    const bucketExpr =
      req.grain === 'week'
        ? `toMonday(${dateExpr})`
        : req.grain === 'month'
          ? `toStartOfMonth(${dateExpr})`
          : dateExpr;

    const params: Record<string, unknown> = {
      tenantId,
      from: req.range.from,
      to: req.range.to,
    };
    const where: string[] = [
      `tenant_id = {tenantId:UUID}`,
      `${dateExpr} >= {from:Date}`,
      `${dateExpr} <= {to:Date}`,
    ];
    if (f.defaultWhere) where.push(`(${f.defaultWhere})`);

    let fi = 0;
    for (const [dim, raw] of Object.entries(req.filters)) {
      const values = Array.isArray(raw) ? raw : [raw];
      const type = DIMENSION_TYPES[dim] ?? 'String';
      const p = `f${fi++}`;
      params[p] = values;
      where.push(`${dim} IN {${p}:Array(${type})}`);
    }

    const selectCols: string[] = [];
    const groupCols: string[] = [];
    if (!req.aggregateOverTime) {
      selectCols.push(`${bucketExpr} AS bucket`);
      groupCols.push('bucket');
    }
    for (const d of req.dimensions) {
      selectCols.push(`toString(${d}) AS ${d}`);
      groupCols.push(d);
    }
    selectCols.push(`${f.valueExpr} AS value`);

    const sql = [
      `SELECT ${selectCols.join(', ')}`,
      `FROM ${f.table}`,
      `WHERE ${where.join(' AND ')}`,
      groupCols.length > 0 ? `GROUP BY ${groupCols.join(', ')}` : '',
      groupCols.length > 0 ? `ORDER BY ${groupCols.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    return { sql, params };
  }

  private async freshness(def: MetricDef, tenantId: string): Promise<string | null> {
    const rows = await this.ch.select<{ latest: string | null }>(
      `SELECT toString(max(toDate(${def.formula.timeCol}))) AS latest
         FROM ${def.formula.table} WHERE tenant_id = {tenantId:UUID}`,
      { tenantId },
    );
    const latest = rows[0]?.latest;
    return latest && latest !== '1970-01-01' ? latest : null;
  }
}
