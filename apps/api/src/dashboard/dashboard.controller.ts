import { Controller, Get, Query } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { MetricsService } from '../metrics/metrics.service';
import { CurrentAuth, RequirePermission } from '../auth/decorators';
import type { AuthContext } from '../auth/auth.types';

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The 10-second Command Center payload (docs/02 P9). Every number here is
 * produced by the semantic metrics layer or by governed Postgres state —
 * there is no third source.
 */
@Controller('v1/dashboard')
export class DashboardController {
  constructor(
    private readonly db: DbService,
    private readonly metrics: MetricsService,
  ) {}

  @Get('command-center')
  @RequirePermission('metrics:read')
  async commandCenter(@CurrentAuth() auth: AuthContext) {
    const today = new Date();
    const d = (offset: number) =>
      isoDate(new Date(today.getTime() - offset * 86400000));

    const safeQuery = async (metricKey: string, from: string, to: string, dims: string[] = []) => {
      try {
        return await this.metrics.query(auth.tenantId, {
          metricKey,
          grain: 'day',
          dimensions: dims,
          filters: {},
          range: { from, to },
        });
      } catch {
        return null;
      }
    };

    const [spend, roas, installs, cpi] = await Promise.all([
      safeQuery('spend', d(14), d(1)),
      safeQuery('roas_d7', d(21), d(8)),
      safeQuery('installs', d(14), d(1)),
      safeQuery('cpi', d(14), d(1)),
    ]);

    const [health, anomalies, recommendations, counts] = await Promise.all([
      this.db.query(
        { tenantId: auth.tenantId, userId: auth.userId },
        `SELECT domain, status, declared_at FROM health_status WHERE tenant_id = $1 ORDER BY domain`,
        [auth.tenantId],
      ),
      this.db.query(
        { tenantId: auth.tenantId, userId: auth.userId },
        `SELECT id, metric_key, scope, direction, magnitude, detector,
                materiality_usd, status, session_id, detected_at
           FROM anomalies
          WHERE tenant_id = $1 AND status IN ('new', 'triaged', 'in_session')
          ORDER BY coalesce(materiality_usd, 0) DESC, detected_at DESC
          LIMIT 10`,
        [auth.tenantId],
      ),
      this.db.query(
        { tenantId: auth.tenantId, userId: auth.userId },
        `SELECT id, title, category, confidence, predicted_impact, session_id, created_at
           FROM recommendations
          WHERE tenant_id = $1 AND status = 'proposed'
          ORDER BY confidence DESC, created_at DESC LIMIT 5`,
        [auth.tenantId],
      ),
      this.db.queryOne<{ awaiting: string; running: string }>(
        { tenantId: auth.tenantId, userId: auth.userId },
        `SELECT
           (SELECT count(*) FROM actions WHERE tenant_id = $1 AND status = 'awaiting_approval') AS awaiting,
           (SELECT count(*) FROM agent_sessions WHERE tenant_id = $1 AND status = 'running') AS running`,
        [auth.tenantId],
      ),
    ]);

    return {
      kpis: {
        spend: spend?.rows ?? [],
        roasD7: roas?.rows ?? [],
        installs: installs?.rows ?? [],
        cpi: cpi?.rows ?? [],
        freshness: spend?.freshnessAt ?? null,
      },
      health,
      signals: {
        risks: anomalies.filter((a) => (a as { direction: string }).direction === 'down'),
        opportunities: anomalies.filter((a) => (a as { direction: string }).direction === 'up'),
      },
      recommendations,
      awaitingApproval: Number(counts?.awaiting ?? 0),
      runningSessions: Number(counts?.running ?? 0),
    };
  }

  @Get('anomalies')
  @RequirePermission('metrics:read')
  async anomalies(@CurrentAuth() auth: AuthContext, @Query('status') status?: string) {
    const conds = ['tenant_id = $1'];
    const params: unknown[] = [auth.tenantId];
    if (status) {
      params.push(status);
      conds.push(`status = $${params.length}`);
    }
    const rows = await this.db.query(
      { tenantId: auth.tenantId, userId: auth.userId },
      `SELECT id, metric_key, scope, direction, magnitude, zscore, detector,
              window_start, window_end, materiality_usd, status, session_id, detected_at
         FROM anomalies WHERE ${conds.join(' AND ')}
        ORDER BY detected_at DESC LIMIT 100`,
      params,
    );
    return { items: rows };
  }

  @Get('creatives')
  @RequirePermission('metrics:read')
  async creatives(@CurrentAuth() auth: AuthContext) {
    // Creative inventory from the registry; performance numbers come from the
    // semantic layer (creative_* metrics) queried by the UI per creative.
    const rows = await this.db.query(
      { tenantId: auth.tenantId, userId: auth.userId },
      `SELECT id, name, format, duration_s, language, tags, first_seen_at
         FROM creatives WHERE tenant_id = $1 ORDER BY first_seen_at DESC NULLS LAST LIMIT 200`,
      [auth.tenantId],
    );
    return { items: rows };
  }
}
