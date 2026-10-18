/**
 * Channel publishing end to end — SIMULATED Instagram Graph API and SIMULATED
 * Telegram Bot API. Proves: approved non-mock content is published through
 * the adapters with the AI disclosure in every caption; Instagram fetches the
 * media through short-lived signed URLs as JPEG (PNG converted to a derived
 * asset); carousels and albums; rate limits are retried, ambiguous failures
 * are never retried; comments are ingested, risky ones flagged, staff replies
 * are guarded. Real Meta/Telegram behaviour (app review, permissions, limits)
 * must still be verified on the real platforms.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ingestInstagramComments } from '../../src/integrations/instagram/comments.js';
import { sha256Hex } from '../../src/lib/canonical-json.js';
import { uuidv7 } from '../../src/lib/ids.js';
import { encodeSolidPng } from '../../src/lib/png.js';
import { publisherTick } from '../../src/modules/publishing.js';
import { type InstagramSimulator, startInstagramSimulator } from '../../src/simulators/instagram.js';
import { type Stack, setupInfluencer, startStack } from '../helpers/stack.js';

describe('publishing adapters (SIMULATED Instagram + SIMULATED Telegram)', () => {
  let stack: Stack;
  let ig: InstagramSimulator;
  let influencerId: string;
  let igChannel: string;
  let tgChannel: string;
  let igAccount: { token: string; igUserId: string };
  let botToken: string;
  let colour = 10;

  const db = () => stack.svc.workerPool;

  async function pngAsset(): Promise<string> {
    const png = encodeSolidPng(32, 32, [colour++, 120, 200]);
    const sha = sha256Hex(png);
    const key = stack.svc.store.keyFor(stack.ws.workspaceId, influencerId, sha, 'png');
    await stack.svc.store.put(key, png, sha);
    const id = uuidv7();
    // An "edited" asset (no contract-mock origin) stands in for real engine output.
    await db().query(
      `INSERT INTO content.media_assets (id, workspace_id, influencer_id, kind, storage_key, mime_type, bytes, width, height, sha256, origin, status)
       VALUES ($1, $2, $3, 'image', $4, 'image/png', $5, 32, 32, $6, 'edited', 'valid')`,
      [id, stack.ws.workspaceId, influencerId, key, png.length, Buffer.from(sha, 'hex')],
    );
    return id;
  }

  /** Approved content scheduled on the given channels; returns publication ids by channel. */
  async function approvedPost(images: number, channels: string[], caption = 'Golden hour in the hills ☀️'): Promise<Record<string, string>> {
    const m = stack.ws.manager.client;
    const assets = [];
    for (let i = 0; i < images; i++) assets.push({ media_asset_id: await pngAsset(), role: images > 1 ? 'carousel' : 'primary' });
    const item = await m.post(`/v1/influencers/${influencerId}/content-items`, { format: images > 1 ? 'ig_carousel' : 'ig_image' });
    assert.equal(item.status, 201, JSON.stringify(item.body));
    const rev = await m.post(`/v1/content-items/${item.body.id}/revisions`, { caption, hashtags: ['sunset', 'travel'], assets });
    assert.equal(rev.status, 201, JSON.stringify(rev.body));
    const req = await m.post(`/v1/revisions/${rev.body.id}/approval-requests`);
    const dec = await stack.ws.reviewer.client.post(`/v1/approvals/${req.body.id}/decisions`, { decision: 'approve', payload_hash: req.body.payload_hash });
    assert.equal(dec.status, 200, JSON.stringify(dec.body));
    const out: Record<string, string> = {};
    for (const ch of channels) {
      const pub = await m.post(`/v1/content-items/${item.body.id}/publications`, { channel_id: ch, scheduled_for: new Date().toISOString() });
      assert.equal(pub.status, 201, JSON.stringify(pub.body));
      assert.equal(pub.body.execution.will_execute, true);
      out[ch] = pub.body.id;
    }
    return out;
  }
  const pubRow = async (id: string) => (await db().query(`SELECT status, external_post_id, permalink, last_error, scheduled_for FROM publishing.publications WHERE id = $1`, [id])).rows[0];

  before(async () => {
    ig = await startInstagramSimulator();
    stack = await startStack({
      telegram: true,
      env: { PUBLISHING_ADAPTERS: 'instagram,telegram', INSTAGRAM_GRAPH_BASE_URL: ig.baseUrl, INSTAGRAM_CONTAINER_POLL_MS: '10', INSTAGRAM_CONTAINER_TIMEOUT_S: '5' },
    });
    // Instagram fetches media from the platform's public URL; here that is the test API.
    stack.svc.config.instagram.publicMediaBaseUrl = stack.apiUrl;
    ({ influencerId } = await setupInfluencer(stack, 'golden'));
    const owner = stack.ws.owner.client;
    assert.equal((await owner.post(`/v1/influencers/${influencerId}/status`, { status: 'active' })).status, 200);
    igAccount = ig.addAccount('golden.ai');
    const acc = await owner.post('/v1/integration-accounts', { influencer_id: influencerId, provider: 'instagram', external_account_id: igAccount.igUserId, credential: igAccount.token });
    assert.equal(acc.status, 201, JSON.stringify(acc.body));
    igChannel = (await owner.post(`/v1/influencers/${influencerId}/channels`, { integration_account_id: acc.body.id, kind: 'instagram_account', external_id: igAccount.igUserId, username: 'golden.ai' })).body.id;
    botToken = stack.telegram!.addBot('golden_pub_bot').token;
    const bot = await owner.post(`/v1/influencers/${influencerId}/telegram/bot`, { token: botToken });
    tgChannel = (await owner.post(`/v1/influencers/${influencerId}/channels`, { integration_account_id: bot.body.account_id, kind: 'telegram_public_channel', external_id: '-1007770001', username: 'golden_public' })).body.id;
  });
  after(async () => {
    await stack?.close();
    await ig?.close();
  });

  it('publishes a single image to Instagram (signed URL, PNG→JPEG derivative) and Telegram with the AI disclosure', async () => {
    const pubs = await approvedPost(1, [igChannel, tgChannel]);
    const r = await publisherTick(stack.svc);
    assert.equal(r.published, 2, JSON.stringify(r));
    const igPub = await pubRow(pubs[igChannel]!);
    assert.equal(igPub.status, 'published');
    const media = ig.media.get(igPub.external_post_id)!;
    assert.match(igPub.permalink, /^https:\/\/www\.instagram\.com\/p\//);
    assert.match(media.caption, /Golden hour in the hills/);
    assert.match(media.caption, /#sunset #travel/);
    assert.match(media.caption, /AI-generated virtual creator/, 'the AI disclosure is in the caption');
    const fetched = media.container.fetched[0]!;
    assert.equal(fetched.jpeg, true, 'Instagram received a JPEG');
    assert.match(fetched.url, /\/v1\/assets\/[0-9a-f-]+\/content\?exp=\d+&sig=/);
    const derived = await db().query(`SELECT origin, parent_asset_id, mime_type, provenance FROM content.media_assets WHERE mime_type = 'image/jpeg'`);
    assert.equal(derived.rows[0].origin, 'derived');
    assert.ok(derived.rows[0].parent_asset_id);
    assert.equal(derived.rows[0].provenance.transform, 'png_to_jpeg_q92_flatten_white');
    // An unsigned or expired URL is refused by the platform.
    const bare = fetched.url.split('?')[0]!;
    assert.equal((await fetch(bare)).status, 403);

    const tgPub = await pubRow(pubs[tgChannel]!);
    assert.equal(tgPub.status, 'published');
    assert.match(tgPub.permalink, /^https:\/\/t\.me\/golden_public\/\d+$/);
    const photo = stack.telegram!.sent(botToken, 'sendPhoto').at(-1)!.params as { chat_id: string; caption: string; files: { bytes: number }[] };
    assert.equal(photo.chat_id, '-1007770001');
    assert.match(photo.caption, /AI-generated virtual creator/);
    assert.ok(photo.files[0]!.bytes > 0);
    const quota = await db().query(`SELECT quota_used, quota_total FROM publishing.quota_snapshots WHERE channel_id = $1`, [igChannel]);
    assert.equal(quota.rows[0].quota_total, 100);
  });

  it('publishes carousels and albums', async () => {
    const pubs = await approvedPost(3, [igChannel, tgChannel], 'Three looks, one weekend');
    await publisherTick(stack.svc);
    const igPub = await pubRow(pubs[igChannel]!);
    assert.equal(igPub.status, 'published', JSON.stringify(igPub.last_error));
    const parent = ig.media.get(igPub.external_post_id)!.container;
    assert.equal(parent.params.media_type, 'CAROUSEL');
    assert.equal(parent.params.children!.split(',').length, 3);
    const tgPub = await pubRow(pubs[tgChannel]!);
    assert.equal(tgPub.external_post_id.split(',').length, 3);
    const album = stack.telegram!.sent(botToken, 'sendMediaGroup').at(-1)!.params as { files: unknown[]; media: string };
    assert.equal(album.files.length, 3);
    assert.match(JSON.parse(album.media)[0].caption, /AI-generated virtual creator/);
  });

  it('rate limits are retried later; a failure at media_publish is ambiguous and never retried', async () => {
    const pubs = await approvedPost(1, [igChannel, tgChannel]);
    ig.failNext('content_publishing_limit', 400, 4, 'Application request limit reached');
    stack.telegram!.failNext('sendPhoto', 429, 'Too Many Requests: retry after 7', 7);
    await publisherTick(stack.svc);
    for (const id of Object.values(pubs)) {
      const row = await pubRow(id);
      assert.equal(row.status, 'scheduled');
      assert.equal(row.last_error.code, 'PUBLISH_RETRY');
      assert.ok(row.scheduled_for.getTime() > Date.now(), 'retry is scheduled in the future');
    }
    await db().query(`UPDATE publishing.publications SET scheduled_for = now() WHERE id = ANY($1)`, [Object.values(pubs)]);
    ig.failNext('media_publish', 500, 2, 'An unexpected error has occurred');
    await publisherTick(stack.svc);
    const igRow = await pubRow(pubs[igChannel]!);
    assert.equal(igRow.status, 'unknown', 'the post may exist: a human must check before retrying');
    assert.equal(igRow.last_error.code, 'PUBLISH_OUTCOME_UNKNOWN');
    assert.equal((await pubRow(pubs[tgChannel]!)).status, 'published');
  });

  it('ingests comments, flags risky ones, ignores its own, and guards staff replies', async () => {
    const pubs = await approvedPost(1, [igChannel]);
    await publisherTick(stack.svc);
    const mediaId = (await pubRow(pubs[igChannel]!)).external_post_id;
    const nice = ig.addComment(mediaId, { text: 'love this look!', fromId: '9001', username: 'fan_one' });
    ig.addComment(mediaId, { text: 'honestly I want to end my life', fromId: '9002', username: 'fan_two' });
    ig.addComment(mediaId, { text: 'thank you!', fromId: igAccount.igUserId, username: 'golden.ai', parentId: nice });
    const first = await ingestInstagramComments(stack.svc);
    assert.equal(first.new, 2);
    assert.equal(first.flagged, 1);
    assert.equal((await ingestInstagramComments(stack.svc)).new, 0, 'idempotent');
    const alert = await db().query(`SELECT severity FROM ops.alerts WHERE code = 'COMMENT_SELF_HARM_RISK'`);
    assert.equal(alert.rows[0].severity, 'critical');
    const list = await stack.ws.manager.client.get(`/v1/influencers/${influencerId}/comments`);
    assert.equal(list.status, 200);
    const niceRow = list.body.find((c: any) => c.body === 'love this look!');
    assert.equal(list.body.find((c: any) => c.author_username === 'fan_two').status, 'escalated');
    const bad = await stack.ws.manager.client.post(`/v1/comments/${niceRow.id}/reply`, { body: 'DM me on t.me/goldenprivate' });
    assert.equal(bad.status, 422);
    const ok = await stack.ws.manager.client.post(`/v1/comments/${niceRow.id}/reply`, { body: 'Thank you so much! 💛' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ig.replies.at(-1), { commentId: niceRow.external_comment_id, message: 'Thank you so much! 💛' });
    assert.equal((await stack.ws.manager.client.post(`/v1/comments/${niceRow.id}/hide`)).status, 403, 'managers reply but do not moderate');
    const hide = await stack.ws.owner.client.post(`/v1/comments/${niceRow.id}/hide`);
    assert.equal(hide.status, 200);
    assert.equal(ig.hidden.get(niceRow.external_comment_id), true);
  });

  it('an Instagram token rejection marks the account for reconnection and alerts', async () => {
    ig.failNext('comments', 400, 190, 'Error validating access token');
    await assert.rejects(ingestInstagramComments(stack.svc));
    const acc = await db().query(`SELECT status FROM core.integration_accounts WHERE provider = 'instagram'`);
    assert.equal(acc.rows[0].status, 'needs_reauth');
    assert.equal((await db().query(`SELECT 1 FROM ops.alerts WHERE code = 'INSTAGRAM_TOKEN_REJECTED'`)).rowCount, 1);
  });
});
