import { maybeOne, one } from '../../db/tx.js';
import type { Services } from '../../services.js';

/**
 * Daily KPI rollup per influencer (analytics.daily_influencer_kpis), computed
 * for the influencer's own calendar day (persona time zone). Idempotent:
 * re-running a day replaces its row. Money is in Telegram Stars; fiat is only
 * an estimate from the latest recorded star valuation, and costs are the
 * operator's configured estimates (0 when not configured).
 */
const ENGAGEMENT_METRICS = ['likes', 'comments', 'saved', 'shares'];

export async function rollupDay(svc: Services, influencerId: string, day: string): Promise<Record<string, unknown>> {
  const db = svc.workerPool;
  const inf = await one<{ workspace_id: string; timezone: string }>(db, 'SELECT workspace_id, timezone FROM identity.influencers WHERE id = $1', [influencerId]);
  const w = await one<{ start: Date; end: Date }>(db, `SELECT ($1::date::timestamp AT TIME ZONE $2) AS start, (($1::date + 1)::timestamp AT TIME ZONE $2) AS end`, [day, inf.timezone]);
  const p = [influencerId, w.start, w.end];

  const latest = async (subjectType: string, metric: string, kinds: string[]): Promise<number | null> => {
    const r = await maybeOne<{ v: number }>(
      db,
      `SELECT sum(v)::float8 AS v FROM (
         SELECT DISTINCT ON (s.channel_id) s.value AS v FROM analytics.metric_snapshots s JOIN publishing.channels c ON c.id = s.channel_id
          WHERE s.influencer_id = $1 AND s.subject_type = $2 AND s.metric = $3 AND c.kind = ANY($4) AND s.captured_at < $5
          ORDER BY s.channel_id, s.captured_at DESC) t`,
      [influencerId, subjectType, metric, kinds, w.end],
    );
    return r?.v ?? null;
  };
  const postMetric = async (metrics: string[]): Promise<number | null> => {
    const r = await maybeOne<{ v: number | null }>(
      db,
      `SELECT sum(v)::float8 AS v FROM (
         SELECT DISTINCT ON (s.subject_ref, s.metric) s.value AS v FROM analytics.metric_snapshots s
          WHERE s.influencer_id = $1 AND s.subject_type = 'publication' AND s.metric = ANY($4)
            AND s.subject_ref IN (SELECT external_post_id FROM publishing.publications WHERE influencer_id = $1 AND published_at >= $2 AND published_at < $3)
          ORDER BY s.subject_ref, s.metric, s.captured_at DESC) t`,
      [...p, metrics],
    );
    return r?.v ?? null;
  };

  const conv = await one<{ inbound: number; ai: number; human: number; active: number }>(
    db,
    `SELECT count(*) FILTER (WHERE direction = 'inbound')::int AS inbound,
            count(*) FILTER (WHERE author_type = 'ai' AND status = 'sent')::int AS ai,
            count(*) FILTER (WHERE author_type = 'operator' AND status = 'sent')::int AS human,
            count(DISTINCT fan_id) FILTER (WHERE direction = 'inbound')::int AS active
       FROM conversation.messages WHERE influencer_id = $1 AND created_at >= $2 AND created_at < $3`,
    p,
  );
  const newFans = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM crm.fan_influencer_profiles WHERE influencer_id = $1 AND first_interaction_at >= $2 AND first_interaction_at < $3`, p);
  const pay = await one<{ stars: number; purchases: number; initial: number; renewals: number }>(
    db,
    `SELECT coalesce(sum(amount_stars), 0)::float8 AS stars, count(*)::int AS purchases,
            count(*) FILTER (WHERE kind = 'subscription_initial')::int AS initial, count(*) FILTER (WHERE kind = 'subscription_renewal')::int AS renewals
       FROM monetization.payments WHERE influencer_id = $1 AND received_at >= $2 AND received_at < $3`,
    p,
  );
  const refunds = await one<{ stars: number }>(
    db,
    `SELECT coalesce(sum(r.amount_stars), 0)::float8 AS stars FROM monetization.refunds r JOIN monetization.payments pm ON pm.id = r.payment_id
      WHERE pm.influencer_id = $1 AND r.status = 'completed' AND r.completed_at >= $2 AND r.completed_at < $3`,
    p,
  );
  const subs = await one<{ active: number; churned: number }>(
    db,
    `SELECT count(*) FILTER (WHERE started_at < $3 AND coalesce(ended_at, 'infinity') > $3)::int AS active,
            count(*) FILTER (WHERE ended_at >= $2 AND ended_at < $3 AND status IN ('expired', 'refunded'))::int AS churned
       FROM monetization.subscriptions WHERE influencer_id = $1`,
    p,
  );
  const conversions = await one<{ n: number }>(
    db,
    `SELECT count(*)::int AS n FROM (SELECT fan_id, min(received_at) AS first FROM monetization.payments WHERE influencer_id = $1 GROUP BY fan_id) f
      WHERE f.first >= $2 AND f.first < $3`,
    p,
  );
  const llm = await one<{ tokens: number; cost: number }>(
    db,
    `SELECT coalesce(sum((quantities->>'prompt_tokens')::numeric + (quantities->>'completion_tokens')::numeric), 0)::float8 AS tokens, coalesce(sum(cost_usd), 0)::float8 AS cost
       FROM analytics.usage_events WHERE influencer_id = $1 AND category = 'llm' AND occurred_at >= $2 AND occurred_at < $3`,
    p,
  );
  const gpu = await one<{ s: number }>(db, `SELECT coalesce(sum(gpu_seconds), 0)::float8 AS s FROM inference.visual_jobs WHERE influencer_id = $1 AND finished_at >= $2 AND finished_at < $3`, p);
  const activeInfluencers = await one<{ n: number }>(db, `SELECT greatest(count(*), 1)::int AS n FROM identity.influencers WHERE status = 'active'`);
  const daysInMonth = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 0)).getUTCDate();
  const costs = svc.config.costs;
  const llmCost = llm.cost + (llm.tokens / 1000) * costs.llmPer1kTokensUsd;
  const mediaCost = (gpu.s / 3600) * costs.gpuHourUsd;
  const fixed = costs.fixedMonthlyUsd / daysInMonth / activeInfluencers.n;
  const valuation = await maybeOne<{ id: string; fiat_per_star: number }>(
    db,
    `SELECT id, fiat_per_star FROM monetization.star_valuations WHERE (workspace_id = $1 OR workspace_id IS NULL) AND effective_date <= $2 ORDER BY effective_date DESC, workspace_id NULLS LAST LIMIT 1`,
    [inf.workspace_id, day],
  );
  const netStars = pay.stars - refunds.stars;
  const estRevenue = valuation ? netStars * valuation.fiat_per_star : null;
  const int = (v: number | null) => (v === null ? null : Math.round(v));
  const row = {
    ig_followers: int(await latest('account', 'followers_count', ['instagram_account'])),
    ig_reach: int(await postMetric(['reach'])),
    ig_engagements: int(await postMetric(ENGAGEMENT_METRICS)),
    tg_public_members: int(await latest('channel', 'member_count', ['telegram_public_channel'])),
    tg_premium_members: int(await latest('channel', 'member_count', ['telegram_premium_channel'])),
    bot_active_users: conv.active,
    new_fans: newFans.n,
    messages_inbound: conv.inbound,
    messages_ai: conv.ai,
    messages_human: conv.human,
    revenue_stars: Math.round(pay.stars),
    refunds_stars: Math.round(refunds.stars),
    purchases: pay.purchases,
    new_subscriptions: pay.initial,
    renewals: pay.renewals,
    churned_subscriptions: subs.churned,
    active_subscribers: subs.active,
    free_to_paid_conversions: conversions.n,
    llm_cost_usd: llmCost,
    media_cost_usd: mediaCost,
    other_variable_cost_usd: 0,
    allocated_fixed_cost_usd: fixed,
    est_revenue_fiat: estRevenue,
    star_valuation_id: valuation?.id ?? null,
    est_contribution_margin: estRevenue === null ? null : estRevenue - llmCost - mediaCost,
  };
  const cols = Object.keys(row);
  await db.query(
    `INSERT INTO analytics.daily_influencer_kpis (workspace_id, influencer_id, kpi_date, ${cols.join(', ')}, computed_at)
     VALUES ($1, $2, $3, ${cols.map((_, i) => `$${i + 4}`).join(', ')}, now())
     ON CONFLICT (influencer_id, kpi_date) DO UPDATE SET ${cols.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, computed_at = now()`,
    [inf.workspace_id, influencerId, day, ...Object.values(row)],
  );
  return { influencer_id: influencerId, kpi_date: day, gpu_seconds: gpu.s, llm_tokens: llm.tokens, ...row };
}

function localDate(tz: string, d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Recomputes today and yesterday (persona time zone) for every non-archived influencer. */
export async function rollupRecent(svc: Services, now = new Date()): Promise<{ rows: number }> {
  const { rows } = await svc.workerPool.query<{ id: string; timezone: string }>(`SELECT id, timezone FROM identity.influencers WHERE status <> 'archived'`);
  let n = 0;
  for (const inf of rows) {
    for (const d of [new Date(now.getTime() - 86_400_000), now]) {
      await rollupDay(svc, inf.id, localDate(inf.timezone, d));
      n++;
    }
  }
  return { rows: n };
}

export async function rollupRange(svc: Services, influencerIds: string[], from: string, to: string): Promise<number> {
  let n = 0;
  for (const id of influencerIds) {
    for (let d = new Date(`${from}T12:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
      await rollupDay(svc, id, d.toISOString().slice(0, 10));
      n++;
    }
  }
  return n;
}

