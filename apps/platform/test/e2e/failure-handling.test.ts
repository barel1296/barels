/**
 * Failure classification, retries, timeouts, cancellation and scheduling,
 * exercised through the HTTP API and the worker against the contract test
 * adapter with injected faults. Validation scope: CONTRACT-TESTED.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { type Stack, setupEngine, setupInfluencer, startStack } from '../helpers/stack.js';

describe('visual job failure handling (contract mock with fault injection)', () => {
  let stack: Stack;
  let influencerId: string;
  let otherInfluencerId: string;
  let seq = 0;

  before(async () => {
    stack = await startStack();
    await setupEngine(stack);
    ({ influencerId } = await setupInfluencer(stack, 'mira'));
    ({ influencerId: otherInfluencerId } = await setupInfluencer(stack, 'nova'));
  });
  after(async () => {
    await stack?.close();
  });

  const manager = () => stack.ws.manager.client;

  async function createJob(extra: Record<string, unknown> = {}, inf = influencerId): Promise<any> {
    const res = await manager().post(`/v1/influencers/${inf}/visual-jobs`, {
      idempotency_key: `failure-test-${++seq}-${Date.now()}`,
      workflow: { key: 'mock.persona_portrait', version_range: '^1.0' },
      parameters: { scene: 'studio portrait', aspect_ratio: '1:1' },
      ...extra,
    });
    assert.ok([200, 202].includes(res.status), JSON.stringify(res.body));
    return res.body;
  }

  const get = async (id: string) => (await manager().get(`/v1/visual-jobs/${id}`)).body;
  const terminal = (id: string) => async () => ['succeeded', 'failed', 'cancelled'].includes((await get(id)).state);
  const events = (job: any) => job.events.map((e: any) => e.event_type);

  it('retries a retryable engine error with attempt+1 and succeeds', async () => {
    stack.engine.injectFault({ type: 'fail_job', error: { code: 'EXECUTION_FAILED', class: 'transient', message: 'simulated sampler crash', retryable: true } });
    const job = await createJob();
    await stack.drive(terminal(job.id));
    const done = await get(job.id);
    assert.equal(done.state, 'succeeded');
    assert.equal(done.attempt, 2);
    assert.ok(events(done).includes('retry_scheduled'));
  });

  it('fails immediately on a non-retryable engine error and marks the content item for rework', async () => {
    const item = await manager().post(`/v1/influencers/${influencerId}/content-items`, { format: 'ig_image', brief: { scene: 'x' } });
    stack.engine.injectFault({ type: 'fail_job', error: { code: 'MODEL_UNAVAILABLE', class: 'permanent', message: 'weights missing', retryable: false } });
    const job = await createJob({ content_item_id: item.body.id });
    await stack.drive(terminal(job.id));
    const done = await get(job.id);
    assert.equal(done.state, 'failed');
    assert.equal(done.attempt, 1);
    assert.equal(done.error_code, 'MODEL_UNAVAILABLE');
    assert.equal(done.events.at(-1).details.reason, 'terminal_error');
    assert.equal((await manager().get(`/v1/content-items/${item.body.id}`)).body.status, 'needs_rework');
  });

  it('stops after max_attempts retryable failures', async () => {
    for (let i = 0; i < 3; i++) {
      stack.engine.injectFault({ type: 'fail_job', error: { code: 'RESOURCE_EXHAUSTED', class: 'resource', message: 'oom', retryable: true } });
    }
    const job = await createJob();
    await stack.drive(terminal(job.id));
    const done = await get(job.id);
    assert.equal(done.state, 'failed');
    assert.equal(done.attempt, 3);
    assert.equal(done.events.at(-1).details.reason, 'attempts_exhausted');
  });

  it('rejects outputs whose bytes do not match the declared sha256 and retries', async () => {
    stack.engine.injectFault({ type: 'corrupt_output' });
    const job = await createJob();
    await stack.drive(terminal(job.id));
    const done = await get(job.id);
    assert.equal(done.state, 'succeeded');
    assert.equal(done.attempt, 2);
    const rejected = done.events.find((e: any) => e.event_type === 'output_rejected');
    assert.equal(rejected.details.error.code, 'OUTPUT_VERIFICATION_FAILED');
    assert.match(rejected.details.error.message, /sha256 mismatch/);
  });

  it('recovers when the engine loses a job (ENGINE_JOB_LOST → attempt+1)', async () => {
    stack.engine.injectFault({ type: 'lose_job' });
    const job = await createJob();
    await stack.drive(terminal(job.id));
    const done = await get(job.id);
    assert.equal(done.state, 'succeeded');
    assert.equal(done.attempt, 2);
    assert.equal(done.events.find((e: any) => e.event_type === 'retry_scheduled').details.error.code, 'ENGINE_JOB_LOST');
  });

  it('replays an ambiguous submit with the same request_id+attempt (no duplicate engine job)', async () => {
    stack.engine.injectFault({ type: 'drop_submit_response' });
    const job = await createJob();
    await stack.drive(terminal(job.id));
    const done = await get(job.id);
    assert.equal(done.state, 'succeeded');
    assert.equal(done.attempt, 1);
    const failed = done.events.find((e: any) => e.event_type === 'submit_failed');
    assert.equal(failed.details.ambiguous, true);
    const submitted = done.events.find((e: any) => e.event_type === 'submitted');
    assert.equal(submitted.details.replayed, true);
    assert.equal(stack.engine.jobs().filter((j) => j.request_id === done.request_id).length, 1);
  });

  it('backs off on ENGINE_BUSY without consuming an attempt', async () => {
    stack.engine.injectFault({ type: 'reject_submit', status: 429, retry_after_s: 0, error: { code: 'ENGINE_BUSY', class: 'resource', message: 'busy', retryable: true } });
    const job = await createJob();
    await stack.drive(terminal(job.id));
    const done = await get(job.id);
    assert.equal(done.state, 'succeeded');
    assert.equal(done.attempt, 1);
    assert.ok(events(done).includes('submit_retry_scheduled'));
  });

  it('fails permanently on a non-conforming engine response (ENGINE_PROTOCOL_ERROR)', async () => {
    stack.engine.injectFault({ type: 'protocol_error' });
    const job = await createJob();
    await stack.drive(terminal(job.id));
    const done = await get(job.id);
    assert.equal(done.state, 'failed');
    assert.equal(done.error_code, 'ENGINE_PROTOCOL_ERROR');
  });

  it('times out a hung job, cancels it on the engine and retries', async () => {
    const cap = stack.svc.config.worker.jobTimeoutCapSeconds;
    stack.svc.config.worker.jobTimeoutCapSeconds = 1;
    try {
      stack.engine.injectFault({ type: 'hang' });
      const job = await createJob();
      assert.equal(job.timeout_s, 1);
      await stack.drive(terminal(job.id), 600);
      const done = await get(job.id);
      assert.equal(done.state, 'succeeded', JSON.stringify(done.error));
      assert.equal(done.attempt, 2);
      assert.ok(events(done).includes('timed_out'));
      assert.equal(done.events.find((e: any) => e.event_type === 'retry_scheduled').details.error.code, 'PLATFORM_TIMEOUT');
    } finally {
      stack.svc.config.worker.jobTimeoutCapSeconds = cap;
    }
  });

  it('cancels a running job on request', async () => {
    stack.engine.injectFault({ type: 'hang' });
    const job = await createJob();
    await stack.drive(async () => (await get(job.id)).state === 'running');
    const cancel = await manager().post(`/v1/visual-jobs/${job.id}/cancel`, { reason: 'brief changed' });
    assert.equal(cancel.status, 200);
    assert.equal(cancel.body.state, 'cancel_requested');
    await stack.drive(terminal(job.id));
    const done = await get(job.id);
    assert.equal(done.state, 'cancelled');
    const engineJob = stack.engine.jobs().find((j) => j.request_id === done.request_id);
    assert.equal(engineJob?.state, 'cancelled');
    const again = await manager().post(`/v1/visual-jobs/${job.id}/cancel`, {});
    assert.equal(again.status, 409);
  });

  it('applies per-persona QA thresholds: low engine score → asset rejected, item needs rework', async () => {
    const t = await stack.ws.compliance.client.post('/v1/qa-thresholds', { influencer_id: influencerId, check_key: 'mock.identity_similarity', min_score: 0.8, required: true });
    assert.equal(t.status, 201);
    const item = await manager().post(`/v1/influencers/${influencerId}/content-items`, { format: 'ig_image' });
    stack.engine.injectFault({ type: 'qa_scores', scores: { 'mock.identity_similarity': 0.42 } });
    const job = await createJob({ content_item_id: item.body.id });
    await stack.drive(terminal(job.id));
    const done = await get(job.id);
    assert.equal(done.state, 'succeeded');
    const assets = (await manager().get(`/v1/influencers/${influencerId}/media-assets?visual_job_id=${job.id}`)).body;
    assert.equal(assets[0].status, 'rejected');
    assert.match(assets[0].status_reason, /mock\.identity_similarity 0\.42 < 0\.8/);
    assert.equal((await manager().get(`/v1/content-items/${item.body.id}`)).body.status, 'needs_rework');
    const rev = await manager().post(`/v1/content-items/${item.body.id}/revisions`, { assets: [{ media_asset_id: assets[0].id, role: 'primary' }] });
    assert.equal(rev.status, 422);
    assert.equal(rev.body.error.code, 'ASSET_NOT_VALID');
  });

  it('concurrent creations with the same idempotency key yield exactly one job', async () => {
    const body = {
      idempotency_key: `race-${Date.now()}`,
      workflow: { key: 'mock.persona_portrait', version_range: '^1.0' },
      parameters: { scene: 'race', aspect_ratio: '1:1' },
    };
    const results = await Promise.all(Array.from({ length: 5 }, () => manager().post(`/v1/influencers/${influencerId}/visual-jobs`, body)));
    const statuses = results.map((r) => r.status).sort();
    assert.ok(statuses.every((s) => s === 200 || s === 202), JSON.stringify(results.map((r) => r.body)));
    assert.equal(statuses.filter((s) => s === 202).length, 1);
    assert.equal(new Set(results.map((r) => r.body.id)).size, 1);
    await stack.drive(terminal(results[0]!.body.id));
  });

  it('validates parameters against the manifest before contacting the engine', async () => {
    const before = stack.engine.jobs().length;
    const res = await manager().post(`/v1/influencers/${influencerId}/visual-jobs`, {
      idempotency_key: `invalid-params-${Date.now()}`,
      workflow: { key: 'mock.persona_portrait', version_range: '^1.0' },
      parameters: { scene: 42, aspect_ratio: '2:1', node_graph: {} },
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'PARAMETER_VALIDATION_FAILED');
    assert.ok(res.body.error.details.violations.length >= 3);
    assert.equal(stack.engine.jobs().length, before);
  });

  it('only runs approved workflow versions; manifests are immutable', async () => {
    const manifest = {
      contract_version: '1.0',
      workflow_key: 'mock.unapproved',
      version: '1.0.0',
      task: 'generate_image',
      title: 'Registered but not approved',
      input_schema: { type: 'object', additionalProperties: false, properties: {} },
      outputs: { kind: 'image', mime_types: ['image/png'], count: { min: 1, max: 1 } },
      resources: { gpu_required: true, vram_mb_peak: null },
      timeouts: { max_runtime_s: 60 },
    };
    const reg = await stack.ws.owner.client.post('/v1/platform/workflows', manifest);
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    assert.equal(reg.body.status, 'registered');
    const changed = await stack.ws.owner.client.post('/v1/platform/workflows', { ...manifest, title: 'Changed under the same version' });
    assert.equal(changed.status, 409);
    assert.equal(changed.body.error.code, 'MANIFEST_IMMUTABLE');
    const deprecatedOnly = await stack.ws.owner.client.post('/v1/platform/workflows', { ...manifest, deprecated: true });
    assert.equal(deprecatedOnly.status, 201, 'lifecycle fields do not change the manifest hash');
    const job = await manager().post(`/v1/influencers/${influencerId}/visual-jobs`, {
      idempotency_key: `unapproved-${Date.now()}`,
      workflow: { key: 'mock.unapproved', version_range: '1.0.0' },
      parameters: {},
    });
    assert.equal(job.status, 422);
    assert.equal(job.body.error.code, 'NO_APPROVED_VERSION');
  });

  it("keeps persona identity independent: another influencer's asset cannot be used as a reference", async () => {
    const mine = await createJob();
    await stack.drive(terminal(mine.id));
    const [asset] = (await manager().get(`/v1/influencers/${influencerId}/media-assets?visual_job_id=${mine.id}`)).body;
    const res = await manager().post(`/v1/influencers/${otherInfluencerId}/visual-jobs`, {
      idempotency_key: `foreign-ref-${Date.now()}`,
      workflow: { key: 'mock.persona_portrait', version_range: '^1.0' },
      parameters: { scene: 'x', aspect_ratio: '1:1' },
      references: [{ asset_id: asset.id, role: 'outfit' }],
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'REFERENCE_NOT_OWNED');
    // Same request for the other persona renders that persona, not this one (persona-derived colour in the mock).
    const theirs = await createJob({}, otherInfluencerId);
    await stack.drive(terminal(theirs.id));
    const [theirAsset] = (await manager().get(`/v1/influencers/${otherInfluencerId}/media-assets?visual_job_id=${theirs.id}`)).body;
    assert.notEqual(theirAsset.sha256, asset.sha256);
    assert.equal(theirAsset.provenance.persona_version_id !== asset.provenance.persona_version_id, true);
  });

  it('dispatches higher priority classes first (P2 before P5) on a single-slot engine', async () => {
    const low = await createJob({ priority_class: 'maintenance' });
    const high = await createJob({ priority_class: 'time_sensitive' });
    await stack.drive(async () => (await get(low.id)).state === 'succeeded' && (await get(high.id)).state === 'succeeded');
    const lowDispatch = (await get(low.id)).events.find((e: any) => e.event_type === 'dispatching');
    const highDispatch = (await get(high.id)).events.find((e: any) => e.event_type === 'dispatching');
    assert.ok(highDispatch.id < lowDispatch.id, 'P2 job must be dispatched before the earlier P5 job');
  });

  it('holds all media dispatch while the global kill switch is on', async () => {
    await stack.svc.workerPool.query(`INSERT INTO core.feature_flags (key, value) VALUES ('kill_switch.media_generation', 'true')`);
    const job = await createJob();
    for (let i = 0; i < 5; i++) await stack.drive(async () => false, 1).catch(() => undefined);
    assert.equal((await get(job.id)).state, 'queued');
    await stack.svc.workerPool.query(`UPDATE core.feature_flags SET value = 'false' WHERE key = 'kill_switch.media_generation'`);
    await stack.drive(terminal(job.id));
    assert.equal((await get(job.id)).state, 'succeeded');
  });

  it('fails queued jobs whose workflow version was disabled', async () => {
    stack.engine.injectFault({ type: 'reject_submit', status: 503, retry_after_s: 60, error: { code: 'ENGINE_UNAVAILABLE', class: 'transient', message: 'maintenance', retryable: true } });
    const job = await createJob({ workflow: { key: '__conformance__.solid_color', version_range: '1.0.0' }, parameters: { color: '#112233', width: 16, height: 16 } });
    // First dispatch is pushed back by the 503 (Retry-After 60 s); disable the version meanwhile.
    await stack.drive(async () => (await get(job.id)).events.some((e: any) => e.event_type === 'submit_retry_scheduled'));
    const wf = (await stack.ws.owner.client.get('/v1/platform/workflows?key=__conformance__.solid_color')).body[0];
    const disabled = await stack.ws.owner.client.post(`/v1/platform/workflows/${wf.id}/decision`, { decision: 'disable', note: 'emergency stop' });
    assert.equal(disabled.status, 200);
    await stack.drive(terminal(job.id));
    const done = await get(job.id);
    assert.equal(done.state, 'failed');
    assert.equal(done.error_code, 'WORKFLOW_DISABLED');
  });
});
