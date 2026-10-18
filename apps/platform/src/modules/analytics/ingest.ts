import type pg from 'pg';
import { instagramClientFor } from '../../integrations/instagram/comments.js';
import { InstagramApiError, type InstagramClient } from '../../integrations/instagram/client.js';
import { clientForAccount } from '../../integrations/telegram/bot.js';
import type { Services } from '../../services.js';

/**
 * Metrics ingestion into analytics.metric_snapshots (append-only): Instagram
 * account and per-post insights, Telegram channel member counts. Metric names
 * are configuration (INSTAGRAM_MEDIA_METRICS) because Meta renames them
 * between API versions; a metric the API rejects is skipped and reported.
 */
async function snapshot(
  db: pg.Pool,
  s: { workspaceId: string; influencerId: string; channelId: string; subjectType: 'account' | 'publication' | 'channel'; subjectRef: string; metric: string; value: number; source: 'instagram_insights' | 'telegram_bot_api' },
): Promise<void> {
  await db.query(
    `INSERT INTO analytics.metric_snapshots (captured_at, workspace_id, influencer_id, channel_id, subject_type, subject_ref, metric, value, period, source)
     VALUES (now(), $1, $2, $3, $4, $5, $6, $7, 'lifetime', $8)`,
    [s.workspaceId, s.influencerId, s.channelId, s.subjectType, s.subjectRef, s.metric, s.value, s.source],
  );
}

async function mediaInsights(ig: InstagramClient, mediaId: string, metrics: string[]): Promise<{ values: Record<string, number>; rejected: string[] }> {
  const values: Record<string, number> = {};
  const rejected: string[] = [];
  const read = (data: { name: string; values?: { value: number }[]; total_value?: { value: number } }[]) => {
    for (const d of data) {
      const v = d.total_value?.value ?? d.values?.[0]?.value;
      if (typeof v === 'number') values[d.name] = v;
    }
  };
  try {
    read((await ig.insights(mediaId, metrics)).data);
  } catch (err) {
    if (!(err instanceof InstagramApiError) || err.code !== 100) throw err;
    // One unsupported metric fails the whole call: retry one by one.
    for (const m of metrics) {
      try {
        read((await ig.insights(mediaId, [m])).data);
      } catch (e) {
        if (e instanceof InstagramApiError && e.code === 100) rejected.push(m);
        else throw e;
      }
    }
  }
  return { values, rejected };
}

export async function ingestInstagramMetrics(svc: Services, opts: { days?: number } = {}): Promise<{ accounts: number; posts: number; snapshots: number; rejected_metrics: string[] }> {
  const db = svc.workerPool;
  const channels = await db.query<{ id: string; workspace_id: string; influencer_id: string; external_id: string; integration_account_id: string }>(
    `SELECT c.id, c.workspace_id, c.influencer_id, c.external_id, c.integration_account_id FROM publishing.channels c
       JOIN core.integration_accounts a ON a.id = c.integration_account_id
      WHERE c.kind = 'instagram_account' AND c.status = 'active' AND a.status = 'active'`,
  );
  let posts = 0;
  let snapshots = 0;
  const rejected = new Set<string>();
  for (const ch of channels.rows) {
    const ig = await instagramClientFor(svc, ch.integration_account_id);
    const base = { workspaceId: ch.workspace_id, influencerId: ch.influencer_id, channelId: ch.id };
    const acct = await ig.media(ch.external_id, 'followers_count,media_count');
    for (const metric of ['followers_count', 'media_count']) {
      if (typeof acct[metric] === 'number') {
        await snapshot(db, { ...base, subjectType: 'account', subjectRef: ch.external_id, metric, value: acct[metric] as number, source: 'instagram_insights' });
        snapshots++;
      }
    }
    const pubs = await db.query<{ external_post_id: string }>(
      `SELECT external_post_id FROM publishing.publications WHERE channel_id = $1 AND status = 'published' AND external_post_id IS NOT NULL
          AND published_at > now() - make_interval(days => $2)`,
      [ch.id, opts.days ?? 30],
    );
    for (const p of pubs.rows) {
      const { values, rejected: r } = await mediaInsights(ig, p.external_post_id, svc.config.analytics.instagramMediaMetrics);
      r.forEach((m) => rejected.add(m));
      for (const [metric, value] of Object.entries(values)) {
        await snapshot(db, { ...base, subjectType: 'publication', subjectRef: p.external_post_id, metric, value, source: 'instagram_insights' });
        snapshots++;
      }
      posts++;
    }
  }
  return { accounts: channels.rows.length, posts, snapshots, rejected_metrics: [...rejected] };
}

export async function ingestTelegramChannelCounts(svc: Services): Promise<{ channels: number }> {
  const db = svc.workerPool;
  const channels = await db.query<{ id: string; workspace_id: string; influencer_id: string; external_id: string; integration_account_id: string }>(
    `SELECT c.id, c.workspace_id, c.influencer_id, c.external_id, c.integration_account_id FROM publishing.channels c
       JOIN core.integration_accounts a ON a.id = c.integration_account_id
      WHERE c.kind IN ('telegram_public_channel', 'telegram_premium_channel') AND c.status = 'active' AND a.status = 'active'`,
  );
  let n = 0;
  for (const ch of channels.rows) {
    try {
      const client = await clientForAccount(svc, ch.integration_account_id);
      const count = await client.getChatMemberCount(ch.external_id);
      await snapshot(db, { workspaceId: ch.workspace_id, influencerId: ch.influencer_id, channelId: ch.id, subjectType: 'channel', subjectRef: ch.external_id, metric: 'member_count', value: count, source: 'telegram_bot_api' });
      n++;
    } catch (err) {
      console.error(`[analytics] member count for channel ${ch.id} failed: ${(err as Error).message}`);
    }
  }
  return { channels: n };
}
