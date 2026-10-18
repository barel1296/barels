import type { Db } from '../../db/tx.js';
import { one } from '../../db/tx.js';
import { badRequest } from '../../lib/errors.js';
import type { Registry } from '../../registry.js';
import type { Services } from '../../services.js';
import { auditCtx } from '../audit.js';
import { type Ctx, requireInfluencerAccess, requirePermission } from '../context.js';
import { ingestInstagramMetrics, ingestTelegramChannelCounts } from './ingest.js';
import { rollupRange, rollupRecent } from './rollup.js';

/** Analytics read models for the dashboard: per influencer, portfolio overview (20–30 influencers), posts, usage. */
export async function kpis(db: Db, ctx: Ctx, influencerId: string, from: string, to: string): Promise<unknown[]> {
  requirePermission(ctx, 'analytics.read');
  requireInfluencerAccess(ctx, influencerId);
  const { rows } = await db.query(`SELECT * FROM analytics.daily_influencer_kpis WHERE influencer_id = $1 AND kpi_date BETWEEN $2 AND $3 ORDER BY kpi_date`, [influencerId, from, to]);
  return rows;
}

export async function overview(db: Db, ctx: Ctx, from: string, to: string): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'analytics.read');
  const scope = ctx.influencerScope ? [...ctx.influencerScope] : null;
  const { rows } = await db.query(
    `SELECT i.id AS influencer_id, i.display_name, i.status,
            coalesce(sum(k.revenue_stars), 0)::float8 AS revenue_stars, coalesce(sum(k.refunds_stars), 0)::float8 AS refunds_stars,
            coalesce(sum(k.purchases), 0)::int AS purchases, coalesce(sum(k.new_fans), 0)::int AS new_fans,
            coalesce(sum(k.messages_inbound), 0)::int AS messages_inbound, coalesce(sum(k.messages_ai), 0)::int AS messages_ai,
            coalesce(sum(k.messages_human), 0)::int AS messages_human,
            coalesce(sum(k.llm_cost_usd + k.media_cost_usd + k.other_variable_cost_usd), 0)::float8 AS variable_cost_usd,
            coalesce(sum(k.allocated_fixed_cost_usd), 0)::float8 AS fixed_cost_usd,
            sum(k.est_revenue_fiat)::float8 AS est_revenue_fiat,
            (array_agg(k.active_subscribers ORDER BY k.kpi_date DESC))[1] AS active_subscribers,
            (array_agg(k.ig_followers ORDER BY k.kpi_date DESC) FILTER (WHERE k.ig_followers IS NOT NULL))[1] AS ig_followers
       FROM identity.influencers i LEFT JOIN analytics.daily_influencer_kpis k ON k.influencer_id = i.id AND k.kpi_date BETWEEN $1 AND $2
      WHERE i.status <> 'archived' AND ($3::uuid[] IS NULL OR i.id = ANY($3))
      GROUP BY i.id ORDER BY revenue_stars DESC, i.display_name`,
    [from, to, scope],
  );
  const totals = rows.reduce<Record<string, number>>((t, r) => {
    for (const k of ['revenue_stars', 'refunds_stars', 'purchases', 'new_fans', 'messages_inbound', 'messages_ai', 'messages_human', 'variable_cost_usd', 'fixed_cost_usd']) t[k] = (t[k] ?? 0) + Number(r[k] ?? 0);
    return t;
  }, {});
  const automation = totals.messages_ai! + totals.messages_human! > 0 ? totals.messages_ai! / (totals.messages_ai! + totals.messages_human!) : null;
  return { from, to, influencers: rows, totals: { ...totals, ai_message_share: automation }, note: 'Costs are operator-configured estimates; fiat revenue is an estimate from the latest star valuation.' };
}

export async function postPerformance(db: Db, ctx: Ctx, influencerId: string, limit = 50): Promise<unknown[]> {
  requirePermission(ctx, 'analytics.read');
  requireInfluencerAccess(ctx, influencerId);
  const { rows } = await db.query(
    `SELECT p.id AS publication_id, p.content_item_id, c.kind AS channel_kind, p.external_post_id, p.permalink, p.published_at, ci.format, ci.brief->>'theme' AS theme,
            coalesce((SELECT jsonb_object_agg(metric, value) FROM (
               SELECT DISTINCT ON (s.metric) s.metric, s.value FROM analytics.metric_snapshots s
                WHERE s.influencer_id = p.influencer_id AND s.subject_type = 'publication' AND s.subject_ref = p.external_post_id
                ORDER BY s.metric, s.captured_at DESC) m), '{}'::jsonb) AS metrics
       FROM publishing.publications p JOIN publishing.channels c ON c.id = p.channel_id JOIN content.content_items ci ON ci.id = p.content_item_id
      WHERE p.influencer_id = $1 AND p.status = 'published' ORDER BY p.published_at DESC LIMIT $2`,
    [influencerId, Math.min(limit, 500)],
  );
  return rows;
}

/** Capacity and cost inputs: LLM tokens by operation and GPU seconds by workflow, per influencer (docs/12, docs/13). */
export async function usage(db: Db, ctx: Ctx, from: string, to: string): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'analytics.read');
  const scope = ctx.influencerScope ? [...ctx.influencerScope] : null;
  const llm = await db.query(
    `SELECT influencer_id, operation, count(*)::int AS calls,
            coalesce(sum((quantities->>'prompt_tokens')::numeric), 0)::float8 AS prompt_tokens,
            coalesce(sum((quantities->>'completion_tokens')::numeric), 0)::float8 AS completion_tokens,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY (quantities->>'latency_ms')::numeric) AS p95_latency_ms
       FROM analytics.usage_events WHERE category = 'llm' AND occurred_at >= $1::date AND occurred_at < $2::date + 1 AND ($3::uuid[] IS NULL OR influencer_id = ANY($3))
      GROUP BY influencer_id, operation ORDER BY influencer_id, operation`,
    [from, to, scope],
  );
  const gpu = await db.query(
    `SELECT influencer_id, workflow_key, engine_kind, count(*)::int AS jobs, count(*) FILTER (WHERE state = 'succeeded')::int AS succeeded,
            coalesce(sum(gpu_seconds), 0)::float8 AS gpu_seconds
       FROM inference.visual_jobs WHERE finished_at >= $1::date AND finished_at < $2::date + 1 AND ($3::uuid[] IS NULL OR influencer_id = ANY($3))
      GROUP BY influencer_id, workflow_key, engine_kind ORDER BY influencer_id, workflow_key`,
    [from, to, scope],
  );
  return { from, to, llm: llm.rows, gpu: gpu.rows };
}

export async function recordStarValuation(
  db: Db,
  ctx: Ctx,
  input: { effective_date: string; fiat_currency?: string; fiat_per_star: number; method: 'realized_payouts_trailing_90d' | 'platform_quoted_rate' | 'finance_manual'; source_ref?: string | null },
): Promise<unknown> {
  requirePermission(ctx, 'valuation.manage');
  if (!(input.fiat_per_star > 0)) throw badRequest('INVALID_VALUATION', 'fiat_per_star must be positive');
  const row = await one(
    db,
    `INSERT INTO monetization.star_valuations (workspace_id, effective_date, fiat_currency, fiat_per_star, method, source_ref, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [ctx.workspaceId, input.effective_date, input.fiat_currency ?? 'USD', input.fiat_per_star, input.method, input.source_ref ?? null, ctx.userId],
  );
  await auditCtx(db, ctx, { action: 'star_valuation.record', subjectType: 'star_valuation', subjectId: String((row as { id: string }).id), metadata: input });
  return row;
}

export async function listStarValuations(db: Db, ctx: Ctx): Promise<unknown[]> {
  requirePermission(ctx, 'analytics.read');
  const { rows } = await db.query(`SELECT * FROM monetization.star_valuations WHERE workspace_id = $1 OR workspace_id IS NULL ORDER BY effective_date DESC LIMIT 100`, [ctx.workspaceId]);
  return rows;
}

export async function recompute(svc: Services, db: Db, ctx: Ctx, from: string, to: string, influencerId?: string): Promise<{ rows: number }> {
  requirePermission(ctx, 'analytics.manage');
  if (to < from) throw badRequest('INVALID_RANGE', 'to must not be before from');
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  if (days > 400) throw badRequest('RANGE_TOO_LARGE', 'At most 400 days per recompute');
  const ids = influencerId
    ? [influencerId]
    : (await db.query<{ id: string }>(`SELECT id FROM identity.influencers WHERE status <> 'archived'`)).rows.map((r) => r.id).filter((id) => !ctx.influencerScope || ctx.influencerScope.has(id));
  if (influencerId) requireInfluencerAccess(ctx, influencerId);
  return { rows: await rollupRange(svc, ids, from, to) };
}

export function analyticsContribution(svc: Services, r: Registry): void {
  r.periodic.push({ name: 'analytics.rollup', intervalSeconds: 3600, run: () => rollupRecent(svc) });
  r.periodic.push({ name: 'analytics.telegram_member_counts', intervalSeconds: 6 * 3600, run: () => ingestTelegramChannelCounts(svc) });
  if (svc.config.publishing.adapters.includes('instagram')) {
    r.periodic.push({ name: 'analytics.instagram_insights', intervalSeconds: 6 * 3600, run: () => ingestInstagramMetrics(svc) });
  }
}
