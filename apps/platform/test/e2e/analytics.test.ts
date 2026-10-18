/**
 * Analytics end to end — SIMULATED Instagram insights, SIMULATED Telegram,
 * SIMULATED LLM and the contract-mock engine. Proves ingestion into
 * metric_snapshots, the daily KPI rollup (persona time zone), cost
 * attribution from configured estimates, Stars→fiat estimates from a recorded
 * valuation, and the portfolio overview. GPU seconds are engine-reported; the
 * contract mock reports 0, so this test sets a value to exercise attribution.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { sha256Hex } from '../../src/lib/canonical-json.js';
import { uuidv7 } from '../../src/lib/ids.js';
import { encodeSolidPng } from '../../src/lib/png.js';
import { ingestInstagramMetrics, ingestTelegramChannelCounts } from '../../src/modules/analytics/ingest.js';
import { publisherTick } from '../../src/modules/publishing.js';
import { type InstagramSimulator, startInstagramSimulator } from '../../src/simulators/instagram.js';
import { type Stack, setupEngine, setupInfluencer, startStack } from '../helpers/stack.js';

const lisbonToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

describe('analytics (SIMULATED Instagram + Telegram + LLM, contract-mock engine)', () => {
  let stack: Stack;
  let ig: InstagramSimulator;
  let influencerId: string;
  let botToken: string;
  let mediaId: string;
  const db = () => stack.svc.workerPool;
  const today = lisbonToday();

  before(async () => {
    ig = await startInstagramSimulator();
    stack = await startStack({
      llm: true,
      telegram: true,
      env: {
        PUBLISHING_ADAPTERS: 'instagram,telegram',
        INSTAGRAM_GRAPH_BASE_URL: ig.baseUrl,
        INSTAGRAM_CONTAINER_POLL_MS: '10',
        COST_GPU_HOUR_USD: '0.5',
        COST_LLM_PER_1K_TOKENS_USD: '0.01',
        COST_FIXED_MONTHLY_USD: '300',
      },
    });
    stack.svc.config.instagram.publicMediaBaseUrl = stack.apiUrl;
    ({ influencerId } = await setupInfluencer(stack, 'golden'));
    const owner = stack.ws.owner.client;
    await owner.post(`/v1/influencers/${influencerId}/status`, { status: 'active' });
    await owner.patch(`/v1/influencers/${influencerId}/runtime-config`, { free_replies_per_day: 20, default_conversation_mode: 'ai_auto' });

    // Instagram account + one published post.
    const acct = ig.addAccount('golden.ai');
    const acc = await owner.post('/v1/integration-accounts', { influencer_id: influencerId, provider: 'instagram', external_account_id: acct.igUserId, credential: acct.token });
    const igCh = (await owner.post(`/v1/influencers/${influencerId}/channels`, { integration_account_id: acc.body.id, kind: 'instagram_account', external_id: acct.igUserId })).body.id;
    const png = encodeSolidPng(16, 16, [9, 9, 9]);
    const sha = sha256Hex(png);
    const key = stack.svc.store.keyFor(stack.ws.workspaceId, influencerId, sha, 'png');
    await stack.svc.store.put(key, png, sha);
    const asset = uuidv7();
    await db().query(
      `INSERT INTO content.media_assets (id, workspace_id, influencer_id, kind, storage_key, mime_type, bytes, width, height, sha256, origin, status)
       VALUES ($1, $2, $3, 'image', $4, 'image/png', $5, 16, 16, $6, 'edited', 'valid')`,
      [asset, stack.ws.workspaceId, influencerId, key, png.length, Buffer.from(sha, 'hex')],
    );
    const m = stack.ws.manager.client;
    const item = await m.post(`/v1/influencers/${influencerId}/content-items`, { format: 'ig_image', brief: { theme: 'café' } });
    const rev = await m.post(`/v1/content-items/${item.body.id}/revisions`, { caption: 'Coffee time', assets: [{ media_asset_id: asset, role: 'primary' }] });
    const req = await m.post(`/v1/revisions/${rev.body.id}/approval-requests`);
    await stack.ws.reviewer.client.post(`/v1/approvals/${req.body.id}/decisions`, { decision: 'approve', payload_hash: req.body.payload_hash });
    await m.post(`/v1/content-items/${item.body.id}/publications`, { channel_id: igCh, scheduled_for: new Date().toISOString() });
    await publisherTick(stack.svc);
    mediaId = (await db().query(`SELECT external_post_id FROM publishing.publications WHERE channel_id = $1`, [igCh])).rows[0].external_post_id;

    // Telegram bot + public channel + one conversation with an AI reply.
    botToken = stack.telegram!.addBot('golden_stats_bot').token;
    const bot = await owner.post(`/v1/influencers/${influencerId}/telegram/bot`, { token: botToken });
    await owner.post(`/v1/influencers/${influencerId}/channels`, { integration_account_id: bot.body.account_id, kind: 'telegram_public_channel', external_id: '-1009990001' });
    const fan = { id: 424242, is_bot: false, first_name: 'Sam' };
    stack.telegram!.userMessage(botToken, fan, '/start');
    await stack.drive(async () => false, 2).catch(() => undefined);
    stack.telegram!.callback(botToken, fan, 'consent:accept');
    await stack.drive(async () => false, 2).catch(() => undefined);
    stack.telegram!.userMessage(botToken, fan, 'hello there');
    await stack.drive(async () => (await db().query(`SELECT 1 FROM conversation.messages WHERE author_type = 'ai' AND status = 'sent'`)).rowCount === 1);
  });
  after(async () => {
    await stack?.close();
    await ig?.close();
  });

  it('ingests Instagram account and post insights, skipping a metric the API rejects', async () => {
    ig.setInsights(mediaId, { reach: 500, likes: 40, comments: 5, saved: 3, shares: 2 });
    ig.unsupportedMetrics = ['views'];
    const r = await ingestInstagramMetrics(stack.svc);
    assert.equal(r.accounts, 1);
    assert.equal(r.posts, 1);
    assert.deepEqual(r.rejected_metrics, ['views']);
    const snaps = await db().query(`SELECT metric, value FROM analytics.metric_snapshots WHERE subject_type = 'publication' ORDER BY metric`);
    assert.deepEqual(
      snaps.rows.map((s) => [s.metric, Number(s.value)]),
      [
        ['comments', 5],
        ['likes', 40],
        ['reach', 500],
        ['saved', 3],
        ['shares', 2],
      ],
    );
    const tg = await ingestTelegramChannelCounts(stack.svc);
    assert.equal(tg.channels, 1);
  });

  it('rolls up the day: audience, conversations, revenue, costs and a fiat estimate', async () => {
    // Money: one 300-Star payment and a completed 100-Star refund today.
    const fan = (await db().query(`SELECT id FROM crm.fans LIMIT 1`)).rows[0].id;
    const payId = uuidv7();
    await db().query(
      `INSERT INTO monetization.payments (id, workspace_id, influencer_id, fan_id, kind, amount_stars, external_dedup_key, telegram_payment_charge_id, raw, received_at)
       VALUES ($1, $2, $3, $4, 'one_time', 300, 'tg:an1', 'an1', '{}', now())`,
      [payId, stack.ws.workspaceId, influencerId, fan],
    );
    await db().query(
      `INSERT INTO monetization.refunds (workspace_id, payment_id, amount_stars, reason, requested_by, status, completed_at) VALUES ($1, $2, 100, 'test', 'operator', 'completed', now())`,
      [stack.ws.workspaceId, payId],
    );
    const val = await stack.ws.owner.client.post('/v1/star-valuations', { effective_date: '2026-01-01', fiat_per_star: 0.013, method: 'finance_manual', source_ref: 'test fixture' });
    assert.equal(val.status, 201, JSON.stringify(val.body));
    // GPU time: one generation through the contract mock; its engine-reported GPU seconds are set here (the mock reports 0).
    await setupEngine(stack);
    await stack.ws.manager.client.put(`/v1/influencers/${influencerId}/workflow-bindings/feed_photo`, { workflow_key: 'mock.persona_portrait', version_range: '^1.0', default_parameters: { aspect_ratio: '4:5' }, priority_class: 'scheduled_image' });
    const job = await stack.ws.manager.client.post(`/v1/influencers/${influencerId}/visual-jobs`, { purpose: 'feed_photo', parameters: { scene: 'x', seed: 1 }, output_count: 1 }, { 'Idempotency-Key': 'analytics-job-0001' });
    assert.equal(job.status, 202, JSON.stringify(job.body));
    await stack.drive(async () => ['succeeded', 'failed'].includes((await stack.ws.manager.client.get(`/v1/visual-jobs/${job.body.id}`)).body.state));
    await db().query(`UPDATE inference.visual_jobs SET gpu_seconds = 720 WHERE id = $1`, [job.body.id]);

    const rc = await stack.ws.owner.client.post('/v1/analytics/recompute', { from: today, to: today });
    assert.equal(rc.status, 200, JSON.stringify(rc.body));
    const k = (await stack.ws.compliance.client.get(`/v1/influencers/${influencerId}/kpis?from=${today}&to=${today}`)).body[0];
    assert.equal(k.ig_followers, 1200);
    assert.equal(k.ig_reach, 500);
    assert.equal(k.ig_engagements, 50);
    assert.equal(k.tg_public_members, 42);
    assert.equal(k.new_fans, 1);
    assert.equal(k.bot_active_users, 1);
    assert.equal(k.messages_inbound, 1);
    assert.equal(k.messages_ai, 1);
    assert.equal(Number(k.revenue_stars), 300);
    assert.equal(Number(k.refunds_stars), 100);
    assert.equal(k.purchases, 1);
    assert.equal(k.free_to_paid_conversions, 1);
    assert.equal(Number(k.media_cost_usd), 0.1, '720 GPU-seconds × $0.50/h');
    assert.ok(Number(k.llm_cost_usd) > 0, 'tokens × configured rate');
    const daysInMonth = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate();
    assert.equal(Number(k.allocated_fixed_cost_usd).toFixed(4), (300 / daysInMonth).toFixed(4));
    assert.equal(Number(k.est_revenue_fiat), 2.6, '(300 − 100) Stars × 0.013');
    assert.ok(k.star_valuation_id);
    assert.equal(Number(k.est_contribution_margin).toFixed(4), (2.6 - Number(k.llm_cost_usd) - 0.1).toFixed(4));
    // Idempotent.
    await stack.ws.owner.client.post('/v1/analytics/recompute', { from: today, to: today });
    assert.equal((await db().query(`SELECT count(*)::int AS n FROM analytics.daily_influencer_kpis`)).rows[0].n, 1);
  });

  it('serves the portfolio overview, post performance and usage for capacity planning', async () => {
    const o = await stack.ws.owner.client.get(`/v1/analytics/overview?from=${today}&to=${today}`);
    assert.equal(o.status, 200);
    assert.equal(o.body.influencers.length, 1);
    assert.equal(o.body.totals.revenue_stars, 300);
    assert.equal(o.body.totals.ai_message_share, 1);
    const posts = await stack.ws.manager.client.get(`/v1/influencers/${influencerId}/post-performance`);
    assert.equal(Number(posts.body[0].metrics.reach), 500);
    const usage = await stack.ws.owner.client.get(`/v1/analytics/usage?from=${today}&to=${today}`);
    assert.ok(usage.body.llm.some((u: any) => u.operation === 'conversation.reply' && u.calls >= 1));
    assert.ok(usage.body.gpu.some((g: any) => g.workflow_key === 'mock.persona_portrait' && g.gpu_seconds === 720));
    assert.equal((await stack.ws.reviewer.client.get(`/v1/analytics/overview?from=${today}&to=${today}`)).status, 403);
    assert.equal((await stack.ws.manager.client.post('/v1/star-valuations', { effective_date: today, fiat_per_star: 1, method: 'finance_manual' })).status, 403);
  });
});
