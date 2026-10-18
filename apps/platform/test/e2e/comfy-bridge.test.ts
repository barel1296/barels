/**
 * ComfyUI bridge — SIMULATED ComfyUI (src/simulators/comfyui.ts), no GPU, no
 * models. Proves the bridge speaks VEC v1 (the conformance runner passes),
 * runs Track A-style workflow packages through the ComfyUI HTTP API with only
 * the bound inputs replaced, classifies ComfyUI failures, never touches other
 * people's prompts, survives restarts, and works end to end with the
 * platform. Nothing here proves behaviour of a real ComfyUI installation or
 * any image model; that is the workstation acceptance test.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, describe, it } from 'node:test';
import { type Bridge, startBridge } from '../../src/comfy-bridge/bridge.js';
import { checkPackagesAgainstComfy, discoverComfy } from '../../src/comfy-bridge/discover.js';
import { paths } from '../../src/config.js';
import { runConformance } from '../../src/conformance/runner.js';
import { ContractValidator } from '../../src/contract/validator.js';
import { sha256Hex } from '../../src/lib/canonical-json.js';
import { encodeSolidPng } from '../../src/lib/png.js';
import { type ComfySimulator, startComfySimulator } from '../../src/simulators/comfyui.js';
import { type Stack, setupInfluencer, startStack } from '../helpers/stack.js';

const PACKAGES = join(paths.repoRoot, 'apps/platform/test/fixtures/comfy-packages');
const BAD_PACKAGES = join(paths.repoRoot, 'apps/platform/test/fixtures/comfy-packages-bad');

describe('ComfyUI bridge (SIMULATED ComfyUI)', () => {
  let comfy: ComfySimulator;
  let bridge: Bridge;
  let dataDir: string;
  let refServer: Server;
  let refUrl: string;
  const token = randomBytes(32).toString('base64url');
  const refPng = encodeSolidPng(24, 24, [200, 100, 50]);

  const start = () => startBridge({ token, comfyUrl: comfy.baseUrl, packagesDir: PACKAGES, dataDir, contractDir: paths.contractDir, engineId: 'ws-comfy-bridge', pollIntervalMs: 20 });
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${bridge.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const submission = (over: { adapters?: { adapter_id: string; kind: 'lora'; engine_ref: string; weight?: number }[]; count?: number; parameters?: Record<string, unknown> } = {}) => {
    const request_id = randomUUID();
    return {
      contract_version: '1.0',
      request_id,
      attempt: 1,
      workflow: { key: 'sim.portrait', version: '1.0.0' },
      influencer_id: randomUUID(),
      persona: {
        influencer_id: randomUUID(),
        persona_version_id: randomUUID(),
        persona_version: 1,
        reference_assets: [{ asset_id: randomUUID(), role: 'face', sha256: sha256Hex(refPng), mime_type: 'image/png', uri: refUrl }],
        adapters: over.adapters ?? [{ adapter_id: randomUUID(), kind: 'lora' as const, engine_ref: 'sim-lora-a.safetensors', weight: 0.8 }],
      },
      parameters: over.parameters ?? { scene: 'reading in a sunny café', mood: 'calm', aspect_ratio: '4:5', seed: 1234 },
      output: { count: over.count ?? 2, transfer: 'http_download' },
      priority: 'scheduled_image',
      timeout_s: 60,
    };
  };
  const submit = (s: ReturnType<typeof submission>) => call('POST', '/jobs', s, { 'idempotency-key': `${s.request_id}:${s.attempt}` });
  const until = async (jobId: string, states: string[], ms = 5000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const r = await call('GET', `/jobs/${jobId}`);
      if (states.includes(r.body.state) || Date.now() > deadline) return r.body;
      await sleep(15);
    }
  };

  before(async () => {
    comfy = await startComfySimulator();
    dataDir = await mkdtemp(join(tmpdir(), 'gi-bridge-'));
    refServer = createServer((_req, res) => res.writeHead(200, { 'content-type': 'image/png' }).end(refPng));
    await new Promise<void>((r) => refServer.listen(0, '127.0.0.1', r));
    refUrl = `http://127.0.0.1:${(refServer.address() as { port: number }).port}/ref.png`;
    bridge = await start();
  });
  after(async () => {
    await bridge?.close();
    await comfy?.close();
    refServer?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('passes the VEC conformance runner (C01–C16) as engine_kind comfyui', async () => {
    const report = await runConformance({ engineUrl: bridge.url, token, contractDir: paths.contractDir });
    assert.deepEqual(report.results.filter((r) => !r.passed), []);
    assert.equal(report.engine?.engine_kind, 'comfyui');
    const info = await call('GET', '/engine');
    assert.equal(info.body.gpu.name, 'SIMULATED GPU (no hardware)');
    assert.equal(info.body.gpu.vram_total_mb, 24576);
  });

  it('exposes valid packages and rejects broken ones with a reason', async () => {
    const wf = await call('GET', '/workflows');
    assert.ok(wf.body.workflows.some((w: any) => w.workflow_key === 'sim.portrait' && /^[a-f0-9]{64}$/.test(w.manifest_sha256)));
    const bad = await startBridge({ token, comfyUrl: comfy.baseUrl, packagesDir: BAD_PACKAGES, dataDir: await mkdtemp(join(tmpdir(), 'gi-bridge-bad-')), contractDir: paths.contractDir, pollIntervalMs: 50 });
    try {
      assert.equal(bad.packages.size, 0);
      assert.match(bad.packageErrors[0]!.error, /node 99 is not in workflow_api.json/);
    } finally {
      await bad.close();
    }
  });

  it('runs a package through the ComfyUI API: only bound inputs change, references are uploaded, outputs are hashed', async () => {
    const s = submission();
    const r = await submit(s);
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const done = await until(r.body.job_id, ['succeeded', 'failed']);
    assert.equal(done.state, 'succeeded', JSON.stringify(done.error));
    assert.equal(done.outputs.length, 2);
    const p = comfy.prompts.at(-1)!.prompt;
    assert.equal(p['6']!.inputs.text, 'photo of the persona, reading in a sunny café, calm');
    assert.equal(p['5']!.inputs.width, 896);
    assert.equal(p['5']!.inputs.height, 1120);
    assert.equal(p['5']!.inputs.batch_size, 2);
    assert.equal(p['3']!.inputs.seed, 1234);
    assert.equal(p['10']!.inputs.lora_name, 'sim-lora-a.safetensors');
    assert.equal(p['10']!.inputs.strength_model, 0.8);
    assert.equal(p['4']!.inputs.ckpt_name, 'sim-base.safetensors', "Track A's model choice is untouched");
    assert.equal(p['3']!.inputs.steps, 20);
    const refName = String(p['11']!.inputs.image);
    assert.match(refName, /^golden-refs\//, 'references go to a dedicated input subfolder');
    assert.equal(sha256Hex(comfy.uploads.get(refName)!), sha256Hex(refPng));
    for (const o of done.outputs) {
      const res = await fetch(`${bridge.url.replace('/vec/v1', '')}${o.download_url}`, { headers: { authorization: `Bearer ${token}` } });
      const bytes = Buffer.from(await res.arrayBuffer());
      assert.equal(sha256Hex(bytes), o.sha256);
      assert.equal(o.provenance.seed, 1234);
      assert.equal(o.provenance.engine_metadata.comfyui_version, '0.0.0-simulated');
    }
    assert.ok(done.resource_usage.gpu_seconds >= 0);
    // The graph delivered by Track A is reused; a different scene yields a different image.
    const s2 = submission({ parameters: { scene: 'walking on the beach', aspect_ratio: '4:5', seed: 1234 }, count: 1 });
    const d2 = await until((await submit(s2)).body.job_id, ['succeeded', 'failed']);
    assert.notEqual(d2.outputs[0].sha256, done.outputs[0].sha256);
  });

  it('classifies ComfyUI failures: out of memory is retryable, a missing model is permanent', async () => {
    comfy.failNext('torch.OutOfMemoryError', 'CUDA out of memory. Tried to allocate 2.00 GiB');
    const oom = await until((await submit(submission({ count: 1 }))).body.job_id, ['succeeded', 'failed']);
    assert.equal(oom.error.code, 'RESOURCE_EXHAUSTED');
    assert.equal(oom.error.retryable, true);
    const missing = await submit(submission({ count: 1, adapters: [{ adapter_id: randomUUID(), kind: 'lora', engine_ref: 'not-installed.safetensors' }] }));
    const m = await until(missing.body.job_id, ['succeeded', 'failed']);
    assert.equal(m.error.code, 'MODEL_UNAVAILABLE');
    assert.equal(m.error.retryable, false);
  });

  it('cancels its own running prompt with a targeted interrupt and never touches other prompts', async () => {
    comfy.hangNext();
    const r = await submit(submission({ count: 1 }));
    await until(r.body.job_id, ['running']);
    const pid = comfy.prompts.at(-1)!.id;
    await call('POST', `/jobs/${r.body.job_id}/cancel`);
    const c = await until(r.body.job_id, ['cancelled']);
    assert.equal(c.state, 'cancelled');
    assert.equal(comfy.interrupts.at(-1), pid);

    const foreign = comfy.foreignPrompt();
    await sleep(40);
    const interruptsBefore = comfy.interrupts.length;
    const queued = await submit(submission({ count: 1 }));
    await call('POST', `/jobs/${queued.body.job_id}/cancel`);
    assert.equal((await until(queued.body.job_id, ['cancelled'])).state, 'cancelled');
    assert.equal(comfy.interrupts.length, interruptsBefore, 'the foreign running prompt was not interrupted');
    const q = (await (await fetch(`${comfy.baseUrl}/queue`)).json()) as { queue_running: string[][] };
    assert.equal(q.queue_running[0]?.[1], foreign);
    await fetch(`${comfy.baseUrl}/interrupt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt_id: foreign }) });
  });

  it('keeps job state across a bridge restart', async () => {
    comfy.execMs = 300;
    try {
      const r = await submit(submission({ count: 1 }));
      await bridge.close();
      bridge = await start();
      const done = await until(r.body.job_id, ['succeeded', 'failed'], 5000);
      assert.equal(done.state, 'succeeded');
    } finally {
      comfy.execMs = 30;
    }
  });

  it('releases GPU memory only when idle, through ComfyUI /free', async () => {
    const r = await call('POST', '/resources/release', { scope: 'idle_models', reason: 'chat model needs more VRAM' });
    assert.equal(r.status, 200);
    assert.equal(r.body.released, true);
    assert.deepEqual(comfy.frees.at(-1), { unload_models: true, free_memory: false });
    const res = await call('GET', '/resources');
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.vram_in_use_mb, 'number');
  });

  it('discovers an existing ComfyUI read-only and checks packages against its node catalogue', async () => {
    const found = await discoverComfy([comfy.baseUrl, 'http://127.0.0.1:9']);
    assert.equal(found[0]!.reachable, true);
    assert.equal(found[0]!.comfyui_version, '0.0.0-simulated');
    assert.equal(found[0]!.devices![0]!.vram_total_mb, 24576);
    assert.ok(found[0]!.node_types! > 5);
    assert.equal(found[1]!.reachable, false);
    const validator = new ContractValidator(paths.contractDir);
    const ok = await checkPackagesAgainstComfy(comfy.baseUrl, PACKAGES, validator);
    assert.equal(ok.packages[0]!.ok, true);
    const saved = comfy.models.checkpoints;
    comfy.models.checkpoints = ['other.safetensors'];
    try {
      const missing = await checkPackagesAgainstComfy(comfy.baseUrl, PACKAGES, validator);
      assert.equal(missing.packages[0]!.ok, false);
      assert.deepEqual(missing.packages[0]!.values_not_available, [{ node: '4', input: 'ckpt_name', value: 'sim-base.safetensors' }]);
    } finally {
      comfy.models.checkpoints = saved;
    }
    // No prompt was queued by discovery or checks.
    const before = comfy.prompts.length;
    await discoverComfy([comfy.baseUrl]);
    assert.equal(comfy.prompts.length, before);
  });
});

describe('platform ↔ ComfyUI bridge end to end (SIMULATED ComfyUI)', () => {
  let stack: Stack;
  let comfy: ComfySimulator;
  let bridge: Bridge;
  let dataDir: string;
  const token = randomBytes(32).toString('base64url');

  before(async () => {
    comfy = await startComfySimulator();
    dataDir = await mkdtemp(join(tmpdir(), 'gi-bridge-e2e-'));
    bridge = await startBridge({ token, comfyUrl: comfy.baseUrl, packagesDir: PACKAGES, dataDir, contractDir: paths.contractDir, engineId: 'ws-comfy-bridge', pollIntervalMs: 20 });
    stack = await startStack();
  });
  after(async () => {
    await stack?.close();
    await bridge?.close();
    await comfy?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('registers the bridge, generates with the persona identity, and produces publishable (non-mock) assets', async () => {
    const owner = stack.ws.owner.client;
    const reg = await owner.post('/v1/platform/engines', { engine_key: 'ws-comfy', base_url: bridge.url, token });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    assert.equal((await owner.post(`/v1/platform/engines/${reg.body.id}/sync`)).status, 200);
    const wf = (await owner.get('/v1/platform/workflows')).body.find((w: any) => w.workflow_key === 'sim.portrait');
    assert.equal((await owner.post(`/v1/platform/workflows/${wf.id}/decision`, { decision: 'approve', note: 'simulated ComfyUI test only' })).status, 200);

    const { influencerId } = await setupInfluencer(stack, 'golden');
    const m = stack.ws.manager.client;
    const ref = await m.upload(`/v1/influencers/${influencerId}/reference-assets?kind=face_canonical`, encodeSolidPng(32, 32, [10, 200, 30]), 'image/png');
    assert.equal(ref.status, 201, JSON.stringify(ref.body));
    await stack.ws.compliance.client.post(`/v1/reference-assets/${ref.body.id}/approve`);
    const ad = await m.post(`/v1/influencers/${influencerId}/adapters`, { kind: 'lora', engine_ref: 'sim-lora-a.safetensors', workflow_keys: ['sim.portrait'] });
    await stack.ws.compliance.client.post(`/v1/adapters/${ad.body.id}/approve`);
    await owner.post(`/v1/influencers/${influencerId}/status`, { status: 'active' });
    const b = await m.put(`/v1/influencers/${influencerId}/workflow-bindings/feed_photo`, { workflow_key: 'sim.portrait', version_range: '^1.0', default_parameters: { aspect_ratio: '4:5' }, priority_class: 'scheduled_image' });
    assert.equal(b.status, 200, JSON.stringify(b.body));

    comfy.failNext('torch.OutOfMemoryError', 'CUDA out of memory');
    const job = await m.post(`/v1/influencers/${influencerId}/visual-jobs`, { purpose: 'feed_photo', parameters: { scene: 'golden hour rooftop', seed: 99 }, output_count: 2 }, { 'Idempotency-Key': 'bridge-e2e-0001' });
    assert.equal(job.status, 202, JSON.stringify(job.body));
    await stack.drive(async () => ['succeeded', 'failed'].includes((await m.get(`/v1/visual-jobs/${job.body.id}`)).body.state), 600);
    const j = (await m.get(`/v1/visual-jobs/${job.body.id}`)).body;
    assert.equal(j.state, 'succeeded', JSON.stringify(j));
    assert.equal(j.attempt, 2, 'the out-of-memory attempt was retried');
    const prompt = comfy.prompts.at(-1)!.prompt;
    assert.equal(prompt['10']!.inputs.lora_name, 'sim-lora-a.safetensors', 'the approved adapter reached the graph');
    assert.equal(sha256Hex(comfy.uploads.get(String(prompt['11']!.inputs.image))!), ref.body.sha256, 'the approved reference reached the graph');
    const assets = (await m.get(`/v1/influencers/${influencerId}/media-assets?visual_job_id=${job.body.id}`)).body;
    assert.equal(assets.length, 2);
    assert.ok(assets.every((a: any) => a.engine_kind === 'comfyui'));
    const item = await m.post(`/v1/influencers/${influencerId}/content-items`, { format: 'ig_image' });
    const rev = await m.post(`/v1/content-items/${item.body.id}/revisions`, { caption: 'Rooftop', assets: [{ media_asset_id: assets[0].id, role: 'primary' }] });
    assert.equal(rev.status, 201, JSON.stringify(rev.body));
    assert.equal(rev.body.contains_contract_mock_assets, false, 'engine output is real content, unlike the contract mock');
  });
});
