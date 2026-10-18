/**
 * Golden template replication (contract mock engine for the workflow binding;
 * no external services). Proves configuration is copied to a new influencer
 * while fan data, payments, credentials, channels, identity and content are
 * never copied, and that autonomy and offers come back as drafts.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { uuidv7 } from '../../src/lib/ids.js';
import { type Stack, setupEngine, setupInfluencer, startStack } from '../helpers/stack.js';

describe('golden template replication', () => {
  let stack: Stack;
  let golden: string;
  const db = () => stack.svc.workerPool;

  before(async () => {
    stack = await startStack();
    ({ influencerId: golden } = await setupInfluencer(stack, 'golden'));
    const owner = stack.ws.owner.client;
    await setupEngine(stack);
    await owner.patch(`/v1/influencers/${golden}/runtime-config`, { free_replies_per_day: 25, premium_replies_per_day: 150, default_conversation_mode: 'ai_auto', redisclosure_every_messages: 30, languages: ['en', 'pt'] });
    assert.equal((await stack.ws.manager.client.put(`/v1/influencers/${golden}/workflow-bindings/feed_photo`, { workflow_key: 'mock.persona_portrait', version_range: '^1.0', default_parameters: { aspect_ratio: '4:5' } })).status, 200);
    await stack.ws.compliance.client.post('/v1/qa-thresholds', { influencer_id: golden, check_key: 'mock.identity_similarity', min_score: 0.82, required: true });
    const pol = await owner.post('/v1/autonomy-policies', { influencer_id: golden, action_type: 'caption.propose', level: 3 });
    await stack.ws.compliance.client.post(`/v1/autonomy-policies/${pol.body.id}/approve`);
    for (const p of [
      { sku: 'chat-plus', kind: 'bot_subscription', name: 'Chat Plus', description: 'More messages', price_stars: 150, grants: [{ kind: 'bot_premium_tier' }] },
      { sku: 'pack-100', kind: 'message_pack', name: '100 messages', description: 'Credits', price_stars: 50, grants: [{ kind: 'message_credits', quantity: 100 }] },
    ]) {
      const r = await stack.ws.manager.client.post(`/v1/influencers/${golden}/products`, p);
      await stack.ws.manager.client.post(`/v1/products/${r.body.id}/submit`);
      await owner.post(`/v1/products/${r.body.id}/approve`);
    }
    // Personal and identity data that must never travel.
    const acc = await owner.post('/v1/integration-accounts', { influencer_id: golden, provider: 'telegram_bot', external_account_id: '555', credential: '555:not-a-real-token-but-secret' });
    await owner.post(`/v1/influencers/${golden}/channels`, { integration_account_id: acc.body.id, kind: 'telegram_bot', external_id: '555' });
    const fan = uuidv7();
    await db().query(`INSERT INTO crm.fans (id, workspace_id, display_name) VALUES ($1, $2, 'Sam')`, [fan, stack.ws.workspaceId]);
    await db().query(`INSERT INTO crm.fan_influencer_profiles (workspace_id, fan_id, influencer_id) VALUES ($1, $2, $3)`, [stack.ws.workspaceId, fan, golden]);
    await db().query(
      `INSERT INTO crm.consents (workspace_id, fan_id, influencer_id, purpose, status, method, evidence, granted_at) VALUES ($1, $2, $3, 'ai_processing', 'granted', 'bot_button', '{}', now())`,
      [stack.ws.workspaceId, fan, golden],
    );
  });
  after(async () => {
    await stack?.close();
  });

  it('copies configuration only; personal data, identity and credentials stay with the template', async () => {
    const r = await stack.ws.owner.client.post(`/v1/influencers/${golden}/clone`, {
      slug: 'nova',
      display_name: 'Nova',
      ai_disclosure_short: 'AI-generated virtual creator',
      ai_disclosure_long: 'Nova is an AI-generated virtual character. Messages are automated.',
      timezone: 'America/New_York',
      primary_language: 'en',
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const nova = r.body.influencer.id;
    assert.deepEqual(r.body.copied, { runtime_config: 1, workflow_bindings: 1, qa_thresholds: 1, content_policies_as_draft: 0, business_objectives_as_draft: 0, autonomy_policies_as_draft: 1, products_as_draft: 2 });
    const rt = (await db().query(`SELECT * FROM identity.persona_runtime_config WHERE influencer_id = $1`, [nova])).rows[0];
    assert.equal(rt.free_replies_per_day, 25);
    assert.equal(rt.default_conversation_mode, 'ai_auto');
    assert.equal(rt.redisclosure_every_messages, 30);
    assert.deepEqual(rt.languages, ['en', 'pt']);
    assert.equal(rt.paused, true, 'a clone starts paused');
    const count = async (sql: string) => (await db().query(sql, [nova])).rows[0].n as number;
    assert.equal(await count(`SELECT count(*)::int AS n FROM identity.persona_versions WHERE influencer_id = $1`), 0);
    assert.equal(await count(`SELECT count(*)::int AS n FROM core.integration_accounts WHERE influencer_id = $1`), 0);
    assert.equal(await count(`SELECT count(*)::int AS n FROM publishing.channels WHERE influencer_id = $1`), 0);
    assert.equal(await count(`SELECT count(*)::int AS n FROM crm.fan_influencer_profiles WHERE influencer_id = $1`), 0);
    assert.equal(await count(`SELECT count(*)::int AS n FROM crm.consents WHERE influencer_id = $1`), 0);
    assert.equal(await count(`SELECT count(*)::int AS n FROM monetization.products WHERE influencer_id = $1 AND status <> 'draft'`), 0, 'offers need approval again');
    assert.equal(await count(`SELECT count(*)::int AS n FROM agents.autonomy_policies WHERE influencer_id = $1 AND status <> 'draft'`), 0, 'autonomy needs approval again');
    const audit = await db().query(`SELECT metadata FROM core.audit_log WHERE action = 'influencer.clone_from_template' AND influencer_id = $1`, [nova]);
    assert.equal(audit.rows[0].metadata.template_id, golden);
    assert.ok(r.body.not_copied.some((x: string) => x.includes('fans')));
  });

  it('needs create and update permissions and stays inside the tenant', async () => {
    const body = { slug: 'x1', display_name: 'X', ai_disclosure_short: 'AI creator', ai_disclosure_long: 'An AI character.', timezone: 'UTC', primary_language: 'en' };
    assert.equal((await stack.ws.reviewer.client.post(`/v1/influencers/${golden}/clone`, body)).status, 403);
    const other = await stack.createWorkspace('rival');
    assert.equal((await other.owner.client.post(`/v1/influencers/${golden}/clone`, body)).status, 404);
  });
});
