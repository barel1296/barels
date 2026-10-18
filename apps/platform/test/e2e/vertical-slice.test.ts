/**
 * FIRST DELIVERABLE — vertical slice, exercised end to end through the HTTP API
 * against a real PostgreSQL 16 database and the Visual Engine Contract TEST
 * ADAPTER (engine_kind=contract_mock).
 *
 * Validation scope: CONTRACT-TESTED. This proves the platform workflow and the
 * contract integration. It does NOT validate real ComfyUI generation, image
 * quality or identity consistency (Track A), and contract-mock output can never
 * be published.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { sha256Hex } from '../../src/lib/canonical-json.js';
import { encodeSolidPng } from '../../src/lib/png.js';
import { type Stack, setupEngine, startStack } from '../helpers/stack.js';
import { PERSONA } from '../helpers/stack.js';

describe('vertical slice: one influencer from configuration to scheduled publication (contract mock)', () => {
  let stack: Stack;
  const s: Record<string, any> = {};

  before(async () => {
    stack = await startStack();
  });
  after(async () => {
    await stack?.close();
  });

  it('1. creates and configures one influencer', async () => {
    const owner = stack.ws.owner.client;
    const res = await owner.post('/v1/influencers', {
      slug: 'luna',
      display_name: 'Luna Vale',
      ai_disclosure_short: 'AI-generated virtual creator',
      ai_disclosure_long: 'Luna is an AI-generated virtual character. Her images are AI-generated and her messages are automated.',
      timezone: 'Europe/Lisbon',
      primary_language: 'en',
      runtime: { content_tier: 'standard', gpu_quota_seconds_day: 3600, languages: ['en', 'pt'] },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.status, 'draft');
    s.influencerId = res.body.id;

    const patched = await stack.ws.manager.client.patch(`/v1/influencers/${s.influencerId}/runtime-config`, { quiet_hours: { start: '23:00', end: '07:00' } });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.gpu_quota_seconds_day, 3600);
    assert.deepEqual(patched.body.quiet_hours, { start: '23:00', end: '07:00' });

    // AI disclosure is mandatory.
    const noDisclosure = await owner.post('/v1/influencers', {
      slug: 'nodisc',
      display_name: 'X',
      ai_disclosure_short: 'virtual creator',
      ai_disclosure_long: 'virtual character',
      timezone: 'UTC',
      primary_language: 'en',
    });
    assert.equal(noDisclosure.status, 422);
    assert.equal(noDisclosure.body.error.code, 'DISCLOSURE_REQUIRED');
  });

  it('2. assigns an independent persona identity (persona version, reference asset, adapter)', async () => {
    const manager = stack.ws.manager.client;
    const compliance = stack.ws.compliance.client;
    const pv = await manager.post(`/v1/influencers/${s.influencerId}/persona-versions`, PERSONA);
    assert.equal(pv.status, 201, JSON.stringify(pv.body));
    s.personaVersionId = pv.body.id;
    assert.equal((await manager.post(`/v1/persona-versions/${s.personaVersionId}/submit`)).status, 200);
    // The author cannot approve their own persona.
    const ownerApproval = await manager.post(`/v1/persona-versions/${s.personaVersionId}/approve`);
    assert.equal(ownerApproval.status, 403);
    assert.equal((await compliance.post(`/v1/persona-versions/${s.personaVersionId}/approve`)).status, 200);
    const activated = await stack.ws.owner.client.post(`/v1/persona-versions/${s.personaVersionId}/activate`);
    assert.equal(activated.status, 200);
    assert.equal(activated.body.status, 'active');

    // Approved reference image (identity material) — fetched by the engine via a signed URL.
    const refPng = encodeSolidPng(32, 32, [200, 120, 90]);
    const ref = await manager.upload(`/v1/influencers/${s.influencerId}/reference-assets?kind=face_canonical`, refPng, 'image/png');
    assert.equal(ref.status, 201, JSON.stringify(ref.body));
    assert.equal(ref.body.sha256, sha256Hex(refPng));
    s.referenceId = ref.body.id;
    assert.equal((await compliance.post(`/v1/reference-assets/${s.referenceId}/approve`)).status, 200);

    // Character adapter registered by the visual track (opaque engine_ref), approved by a different person.
    const adapter = await manager.post(`/v1/influencers/${s.influencerId}/adapters`, { kind: 'lora', engine_ref: 'mock:lora/luna-v1', workflow_keys: ['mock.persona_portrait'] });
    assert.equal(adapter.status, 201, JSON.stringify(adapter.body));
    s.adapterId = adapter.body.id;
    assert.equal((await compliance.post(`/v1/adapters/${s.adapterId}/approve`)).status, 200);

    const status = await stack.ws.owner.client.post(`/v1/influencers/${s.influencerId}/status`, { status: 'active' });
    assert.equal(status.status, 200);
    const detail = await manager.get(`/v1/influencers/${s.influencerId}`);
    assert.equal(detail.body.active_persona_version_id, s.personaVersionId);
    assert.equal(detail.body.reference_assets.length, 1);
    assert.equal(detail.body.adapters.length, 1);
  });

  it('3. registers the visual workflow contract (engine discovery, platform approval, binding)', async () => {
    const { engineId, workflowId } = await setupEngine(stack);
    s.engineId = engineId;
    s.workflowId = workflowId;
    const wf = await stack.ws.manager.client.get(`/v1/platform/workflows/${workflowId}`);
    assert.equal(wf.status, 200);
    assert.equal(wf.body.status, 'approved');
    assert.match(wf.body.manifest_sha256, /^[a-f0-9]{64}$/);
    // Business logic sees a typed contract, never a node graph.
    assert.equal(wf.body.manifest.input_schema.type, 'object');
    assert.equal(JSON.stringify(wf.body).includes('class_type'), false);

    // Only platform admins may register engines or approve workflows.
    const denied = await stack.ws.manager.client.post(`/v1/platform/workflows/${workflowId}/decision`, { decision: 'disable', note: 'x' });
    assert.equal(denied.status, 403);

    const binding = await stack.ws.manager.client.put(`/v1/influencers/${s.influencerId}/workflow-bindings/feed_photo`, {
      workflow_key: 'mock.persona_portrait',
      version_range: '^1.0',
      default_parameters: { aspect_ratio: '4:5' },
      priority_class: 'scheduled_image',
    });
    assert.equal(binding.status, 200, JSON.stringify(binding.body));
    assert.equal(binding.body.resolves_to, '1.0.0');

    const threshold = await stack.ws.compliance.client.post('/v1/qa-thresholds', {
      influencer_id: s.influencerId,
      check_key: 'mock.identity_similarity',
      min_score: 0.8,
      required: true,
    });
    assert.equal(threshold.status, 201, JSON.stringify(threshold.body));
  });

  it('4. submits a generation job through the contract', async () => {
    const manager = stack.ws.manager.client;
    const item = await manager.post(`/v1/influencers/${s.influencerId}/content-items`, {
      format: 'ig_image',
      target_rating: 'general',
      brief: { scene: 'morning coffee on a sunny balcony', mood: 'calm' },
    });
    assert.equal(item.status, 201);
    s.itemId = item.body.id;

    // First attempt hits a retryable engine failure (out of memory) to prove retry handling.
    stack.engine.injectFault({
      type: 'fail_job',
      workflow_key: 'mock.persona_portrait',
      error: { code: 'RESOURCE_EXHAUSTED', class: 'resource', message: 'simulated GPU out of memory', retryable: true },
    });
    const body = {
      purpose: 'feed_photo',
      parameters: { scene: 'morning coffee on a sunny balcony', seed: 42 },
      output_count: 2,
      content_item_id: s.itemId,
    };
    const job = await manager.post(`/v1/influencers/${s.influencerId}/visual-jobs`, body, { 'Idempotency-Key': 'slice-feed-photo-0001' });
    assert.equal(job.status, 202, JSON.stringify(job.body));
    assert.equal(job.body.state, 'queued');
    assert.equal(job.body.workflow_version, '1.0.0');
    assert.equal(job.body.priority, 3);
    assert.deepEqual(job.body.persona_reference_ids, [s.referenceId]);
    assert.deepEqual(job.body.adapter_ids, [s.adapterId]);
    s.jobId = job.body.id;

    // Idempotent creation.
    const replay = await manager.post(`/v1/influencers/${s.influencerId}/visual-jobs`, body, { 'Idempotency-Key': 'slice-feed-photo-0001' });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.id, s.jobId);
  });

  it('5. tracks job status and handles the failure (retry with attempt+1)', async () => {
    const token = stack.ws.manager.token;
    await stack.drive(async () => ['succeeded', 'failed'].includes((await stack.client(token).get(`/v1/visual-jobs/${s.jobId}`)).body.state));
    const job = (await stack.client(token).get(`/v1/visual-jobs/${s.jobId}`)).body;
    assert.equal(job.state, 'succeeded', JSON.stringify(job.error));
    assert.equal(job.attempt, 2);
    assert.equal(job.engine_kind, 'contract_mock');
    assert.equal(job.validation_scope, 'contract_mock');
    const types = job.events.map((e: any) => e.event_type);
    for (const t of ['created', 'dispatching', 'submitted', 'retry_scheduled', 'engine_succeeded', 'output_verified', 'succeeded']) {
      assert.ok(types.includes(t), `missing event ${t} in ${types.join(',')}`);
    }
    const retry = job.events.find((e: any) => e.event_type === 'retry_scheduled');
    assert.equal(retry.details.error.code, 'RESOURCE_EXHAUSTED');
    assert.equal(retry.details.next_attempt, 2);
    s.job = job;
  });

  it('6. receives and stores the generated asset metadata', async () => {
    const assets = await stack.ws.manager.client.get(`/v1/influencers/${s.influencerId}/media-assets?visual_job_id=${s.jobId}`);
    assert.equal(assets.status, 200);
    assert.equal(assets.body.length, 2);
    for (const a of assets.body) {
      assert.equal(a.status, 'valid');
      assert.equal(a.origin, 'generated');
      assert.equal(a.engine_kind, 'contract_mock');
      assert.equal(a.mime_type, 'image/png');
      assert.equal(a.width, 64);
      assert.equal(a.height, 80);
      assert.equal(a.qa_summary.decision, 'valid');
      assert.equal(a.qa_summary.validation_scope, 'contract_mock');
      assert.equal(a.provenance.persona_version_id, s.personaVersionId);
      assert.deepEqual(a.provenance.persona_reference_ids, [s.referenceId]);
      assert.deepEqual(a.provenance.adapter_ids, [s.adapterId]);
      assert.equal(a.provenance.workflow.key, 'mock.persona_portrait');
      assert.equal(a.provenance.contract_mock, true);
      assert.deepEqual(a.provenance.contract.engine_metadata.adapters, ['mock:lora/luna-v1']);
      assert.equal(a.provenance.iptc_digital_source_type, 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia');
    }
    // Stored in the platform's content store, byte-exact.
    const row = await stack.svc.workerPool.query<{ storage_key: string; sha256: Buffer }>(
      'SELECT storage_key, sha256 FROM content.media_assets WHERE id = $1',
      [assets.body[0].id],
    );
    const bytes = readFileSync(join(stack.mediaRoot, row.rows[0]!.storage_key));
    assert.equal(sha256Hex(bytes), row.rows[0]!.sha256.toString('hex'));
    s.assetIds = assets.body.map((a: any) => a.id);
    const item = await stack.ws.manager.client.get(`/v1/content-items/${s.itemId}`);
    assert.equal(item.body.status, 'ready_for_review');
  });

  it('7. reviews the asset: rejection with a reason, then approval bound to the payload hash', async () => {
    const manager = stack.ws.manager.client;
    const reviewer = stack.ws.reviewer.client;
    const rev1 = await manager.post(`/v1/content-items/${s.itemId}/revisions`, {
      caption: 'Slow mornings ☕',
      hashtags: ['#morning', '#coffee'],
      alt_text: 'AI-generated image of a woman with an auburn bob drinking coffee on a balcony',
      assets: [{ media_asset_id: s.assetIds[0], role: 'primary' }],
    });
    assert.equal(rev1.status, 201, JSON.stringify(rev1.body));
    assert.equal(rev1.body.disclosure_text, 'AI-generated virtual creator');
    assert.equal(rev1.body.contains_contract_mock_assets, true);
    const req1 = await manager.post(`/v1/revisions/${rev1.body.id}/approval-requests`);
    assert.equal(req1.status, 201, JSON.stringify(req1.body));

    const noReason = await reviewer.post(`/v1/approvals/${req1.body.id}/decisions`, { decision: 'reject', payload_hash: req1.body.payload_hash });
    assert.equal(noReason.status, 400);
    const rejected = await reviewer.post(`/v1/approvals/${req1.body.id}/decisions`, {
      decision: 'reject',
      payload_hash: req1.body.payload_hash,
      comment: 'Pose looks unnatural; use the second render.',
    });
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
    assert.equal(rejected.body.status, 'rejected');
    assert.equal((await manager.get(`/v1/content-items/${s.itemId}`)).body.status, 'rejected');

    const rev2 = await manager.post(`/v1/content-items/${s.itemId}/revisions`, {
      caption: 'Slow mornings ☕',
      hashtags: ['#morning', '#coffee'],
      alt_text: 'AI-generated image of a woman with an auburn bob drinking coffee on a balcony',
      assets: [{ media_asset_id: s.assetIds[1], role: 'primary' }],
    });
    assert.equal(rev2.status, 201);
    const req2 = await manager.post(`/v1/revisions/${rev2.body.id}/approval-requests`);
    assert.equal(req2.status, 201);
    // A decision must carry the hash of exactly the payload under review.
    const stale = await reviewer.post(`/v1/approvals/${req2.body.id}/decisions`, { decision: 'approve', payload_hash: req1.body.payload_hash });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'PAYLOAD_HASH_MISMATCH');
    // The content manager prepared it and has no approval permission.
    assert.equal((await manager.post(`/v1/approvals/${req2.body.id}/decisions`, { decision: 'approve', payload_hash: req2.body.payload_hash })).status, 403);
    s.revisionId = rev2.body.id;
    s.approvalId = req2.body.id;
  });

  it('8. schedules the approved content for publication', async () => {
    const manager = stack.ws.manager.client;
    const owner = stack.ws.owner.client;
    // Not yet approved → cannot be scheduled.
    const account = await owner.post('/v1/integration-accounts', {
      influencer_id: s.influencerId,
      provider: 'instagram',
      external_account_id: '17841400000000001',
      display_name: '@luna.vale (test)',
      credential: 'IGQ-test-token-not-real-000000',
      scopes: ['instagram_business_basic', 'instagram_business_content_publish'],
    });
    assert.equal(account.status, 201, JSON.stringify(account.body));
    assert.equal('credential' in account.body || 'credential_ciphertext' in account.body, false);
    const channel = await owner.post(`/v1/influencers/${s.influencerId}/channels`, {
      integration_account_id: account.body.id,
      kind: 'instagram_account',
      external_id: '17841400000000001',
      username: 'luna.vale',
      max_rating: 'suggestive',
    });
    assert.equal(channel.status, 201, JSON.stringify(channel.body));
    s.channelId = channel.body.id;
    const when = new Date(Date.now() + 3600_000).toISOString();
    const early = await manager.post(`/v1/content-items/${s.itemId}/publications`, { channel_id: s.channelId, scheduled_for: when });
    assert.equal(early.status, 409);
    assert.equal(early.body.error.code, 'NOT_APPROVED');

    const approval = await stack.ws.reviewer.client.get(`/v1/approvals/${s.approvalId}`);
    const approved = await stack.ws.reviewer.client.post(`/v1/approvals/${s.approvalId}/decisions`, {
      decision: 'approve',
      payload_hash: approval.body.payload_hash,
      comment: 'On-brand, disclosure present.',
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.status, 'approved');

    const pub = await manager.post(`/v1/content-items/${s.itemId}/publications`, { channel_id: s.channelId, scheduled_for: when });
    assert.equal(pub.status, 201, JSON.stringify(pub.body));
    assert.equal(pub.body.status, 'scheduled');
    assert.equal(pub.body.authorization_kind, 'human_approval');
    assert.equal(pub.body.approval_request_id, s.approvalId);
    assert.deepEqual(pub.body.platform_flags, { is_ai_generated: true });
    // Contract-mock output is scheduled to prove the workflow but will never be executed.
    assert.equal(pub.body.execution.will_execute, false);
    assert.equal(pub.body.execution.blocked_reason, 'MOCK_ASSET_NOT_PUBLISHABLE');
    s.publicationId = pub.body.id;
    assert.equal((await manager.get(`/v1/content-items/${s.itemId}`)).body.status, 'scheduled');
  });

  it('9. records the entire action history (lineage + audit)', async () => {
    const lineage = await stack.ws.reviewer.client.get(`/v1/content-items/${s.itemId}/lineage`);
    assert.equal(lineage.status, 200, JSON.stringify(lineage.body));
    const l = lineage.body;
    assert.equal(l.validation_scope, 'contract_mock');
    assert.equal(l.persona_versions[0].id, s.personaVersionId);
    assert.equal(l.workflows[0].workflow_key, 'mock.persona_portrait');
    assert.equal(l.engines[0].engine_kind, 'contract_mock');
    assert.equal(l.visual_jobs.length, 1);
    assert.equal(l.visual_jobs[0].attempt, 2);
    assert.ok(l.visual_jobs[0].events.length >= 8);
    assert.equal(l.media_assets.length, 2);
    for (const a of l.media_assets) {
      const kinds = a.validation_results.map((v: any) => v.check_type).sort();
      assert.deepEqual(kinds, ['engine_qa', 'qa_threshold', 'technical']);
    }
    assert.equal(l.revisions.length, 2);
    assert.deepEqual(l.approvals.map((a: any) => a.status), ['rejected', 'approved']);
    assert.equal(l.approvals[0].decisions[0].comment, 'Pose looks unnatural; use the second render.');
    assert.equal(l.approvals[1].decisions[0].approver_user_id, stack.ws.reviewer.id);
    assert.equal(l.publications[0].account.provider, 'instagram');
    assert.equal(l.publications[0].channel.kind, 'instagram_account');
    assert.equal(l.publications[0].status, 'scheduled');
    const actions = new Set(l.audit.map((a: any) => a.action));
    for (const action of [
      'content.item_create',
      'visual_job.create',
      'visual_job.succeeded',
      'media_asset.ingest',
      'content.revision_create',
      'approval.request',
      'approval.reject',
      'approval.approve',
      'publication.schedule',
    ]) {
      assert.ok(actions.has(action), `audit missing ${action}`);
    }
    const infAudit = await stack.ws.reviewer.client.get(`/v1/influencers/${s.influencerId}/audit`);
    const infActions = new Set(infAudit.body.map((a: any) => a.action));
    for (const action of ['influencer.create', 'persona.version_approve', 'persona.version_activate', 'reference_asset.approve', 'adapter.approve', 'workflow_binding.set', 'integration_account.create', 'channel.create']) {
      assert.ok(infActions.has(action), `influencer audit missing ${action}`);
    }
    if (process.env.TEST_EVIDENCE_DIR) {
      mkdirSync(process.env.TEST_EVIDENCE_DIR, { recursive: true });
      writeFileSync(join(process.env.TEST_EVIDENCE_DIR, 'vertical-slice-lineage.json'), `${JSON.stringify(l, null, 2)}\n`);
    }
  });
});
