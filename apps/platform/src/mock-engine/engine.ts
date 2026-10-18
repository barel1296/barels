/**
 * CONTRACT TEST ADAPTER — not a visual engine.
 *
 * Implements the Visual Engine Contract v1 HTTP API in memory so the platform
 * (Track B) can be built and tested before Track A's ComfyUI-backed engine is
 * available. It identifies itself as engine_kind "contract_mock"; the platform
 * labels everything it produces as contract-mock output, which can never be
 * published and never counts as real end-to-end validation.
 *
 * It uses no GPU and no models. "Generation" renders solid-colour PNGs.
 * Failure injection (faults) lets tests exercise every error path.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { AssetRef, ErrorObject, JobStatus, JobSubmission, Output, QaResult, WorkflowManifest } from '../contract/types.js';
import { ContractValidator } from '../contract/validator.js';
import { canonicalSha256Hex, manifestSha256, sha256Hex } from '../lib/canonical-json.js';
import { safeEqual } from '../lib/crypto.js';
import { encodeSolidPng, hexToRgb } from '../lib/png.js';

export const MOCK_ENGINE_VERSION = '1.0.0-mock';
export const MOCK_PERSONA_WORKFLOW = 'mock.persona_portrait';

export type Fault =
  /** Next matching job fails with this error once it is running. */
  | { type: 'fail_job'; error: ErrorObject; workflow_key?: string }
  /** Next POST /jobs is rejected synchronously with this HTTP status and error (job not created). */
  | { type: 'reject_submit'; status: number; error: ErrorObject; retry_after_s?: number }
  /** Next POST /jobs is processed (job created!) but the connection is dropped before the response. */
  | { type: 'drop_submit_response' }
  /** Next matching job declares a sha256 that does not match the bytes it serves. */
  | { type: 'corrupt_output'; workflow_key?: string }
  /** Next matching job disappears once running (GET → 404 JOB_NOT_FOUND). */
  | { type: 'lose_job'; workflow_key?: string }
  /** Next matching job never finishes until cancelled. */
  | { type: 'hang'; workflow_key?: string }
  /** Next GET /jobs/{id} for the next matching job returns a non-conforming body. */
  | { type: 'protocol_error'; workflow_key?: string }
  /** Engine QA scores reported on the next matching job's outputs. */
  | { type: 'qa_scores'; scores: Record<string, number>; workflow_key?: string };

interface MockJob {
  status: JobStatus;
  submission: JobSubmission;
  bodyHash: string;
  delayMs: number;
  hang: boolean;
  fail: ErrorObject | null;
  lose: boolean;
  protocolError: boolean;
  corrupt: boolean;
  qaScores: Record<string, number> | null;
  files: Map<string, { bytes: Buffer; mime: string }>;
  cancelRequested: boolean;
  startedAtMs: number | null;
  timer: NodeJS.Timeout | null;
}

export interface MockEngineOptions {
  token: string;
  contractDir: string;
  engineId?: string;
  maxConcurrentJobs?: number;
  conformanceMode?: boolean;
  /** Default render delay for workflows without delay_ms. */
  defaultDelayMs?: number;
}

export interface MockEngine {
  app: FastifyInstance;
  /** Base URL including /vec/v1 (after listen). */
  url: string;
  injectFault(f: Fault): void;
  clearFaults(): void;
  jobs(): JobStatus[];
  close(): Promise<void>;
}

function personaPortraitManifest(): WorkflowManifest {
  return {
    contract_version: '1.0',
    workflow_key: MOCK_PERSONA_WORKFLOW,
    version: '1.0.0',
    task: 'generate_image',
    title: 'Contract mock: persona portrait (solid colour placeholder)',
    description:
      'CONTRACT TEST ADAPTER ONLY. Exercises persona identity, reference assets, adapters and engine QA through the contract. Renders a solid-colour PNG derived from the persona; no model, no GPU.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['scene', 'aspect_ratio'],
      properties: {
        scene: { type: 'string', minLength: 1, maxLength: 500 },
        aspect_ratio: { type: 'string', enum: ['1:1', '4:5', '9:16'] },
        seed: { type: 'integer', minimum: 0, maximum: 4294967295 },
        delay_ms: { type: 'integer', minimum: 0, maximum: 60000 },
      },
    },
    references: {
      persona_identity: { required: true },
      assets: { roles: ['outfit', 'pose', 'environment', 'source'], min: 0, max: 2 },
      adapters: { kinds: ['lora'], max: 1 },
    },
    outputs: { kind: 'image', mime_types: ['image/png'], count: { min: 1, max: 4, default: 1 } },
    resources: {
      gpu_required: false,
      vram_mb_peak: 0,
      est_seconds_p50: null,
      est_seconds_p95: null,
      measured_on: null,
      preemptible: true,
      default_priority: 'scheduled_image',
    },
    timeouts: { max_runtime_s: 120 },
    quality: { qa_checks: ['mock.identity_similarity'] },
    provenance: { c2pa: 'none' },
    deprecated: false,
    sunset_at: null,
    engine_metadata: { contract_mock: true },
  };
}

const ASPECT: Record<string, [number, number]> = { '1:1': [64, 64], '4:5': [64, 80], '9:16': [54, 96] };

function err(code: string, cls: ErrorObject['class'], message: string, retryable: boolean, details?: Record<string, unknown>): ErrorObject {
  return { code, class: cls, message, retryable, ...(details ? { details } : {}) };
}

export async function startMockEngine(opts: MockEngineOptions & { host?: string; port?: number }): Promise<MockEngine> {
  const validator = new ContractValidator(opts.contractDir);
  const engineId = opts.engineId ?? 'contract-mock';
  const maxConcurrent = opts.maxConcurrentJobs ?? 1;
  const conformance = opts.conformanceMode ?? true;
  const defaultDelay = opts.defaultDelayMs ?? 30;

  const manifests = new Map<string, WorkflowManifest>();
  const add = (m: WorkflowManifest) => manifests.set(`${m.workflow_key}@${m.version}`, m);
  add(personaPortraitManifest());
  if (conformance) {
    add(JSON.parse(readFileSync(join(opts.contractDir, 'examples/workflow-manifest.conformance-solid-color.json'), 'utf8')) as WorkflowManifest);
  }

  const jobs = new Map<string, MockJob>();
  const idempotency = new Map<string, { hash: string; jobId: string }>();
  let faults: Fault[] = [];
  let seq = 0;

  const takeFault = <T extends Fault['type']>(type: T, workflowKey?: string): Extract<Fault, { type: T }> | null => {
    const i = faults.findIndex((f) => f.type === type && (!('workflow_key' in f) || !f.workflow_key || f.workflow_key === workflowKey));
    if (i < 0) return null;
    const [f] = faults.splice(i, 1);
    return f as Extract<Fault, { type: T }>;
  };

  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  const engineRef = { engine_id: engineId, engine_version: MOCK_ENGINE_VERSION };

  const sendError = (reply: FastifyReply, status: number, e: ErrorObject, retryAfterS?: number) => {
    if (retryAfterS !== undefined) reply.header('retry-after', String(retryAfterS));
    return reply.status(status).send({ error: e });
  };

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = req.headers.authorization ?? '';
    const ok = auth.startsWith('Bearer ') && safeEqual(auth.slice(7), opts.token);
    if (!ok) return sendError(reply, 401, err('UNAUTHORIZED', 'auth', 'missing or invalid token', false));
  });

  const activeCount = () => [...jobs.values()].filter((j) => ['queued', 'running', 'cancelling'].includes(j.status.state)).length;

  const finish = (job: MockJob, state: 'succeeded' | 'failed' | 'cancelled', extra: Partial<JobStatus> = {}) => {
    if (job.timer) clearTimeout(job.timer);
    job.timer = null;
    const now = new Date();
    const wall = job.startedAtMs ? (now.getTime() - job.startedAtMs) / 1000 : 0;
    job.status = {
      ...job.status,
      state,
      finished_at: now.toISOString(),
      // No GPU is used by the contract mock: gpu_seconds is honestly 0.
      resource_usage: { gpu_seconds: 0, wall_seconds: Math.round(wall * 1000) / 1000, vram_peak_mb: null },
      ...extra,
    };
  };

  const render = (job: MockJob): Output[] => {
    const s = job.submission;
    const p = s.parameters as Record<string, unknown>;
    let width: number;
    let height: number;
    let color: string;
    if (s.workflow.key === '__conformance__.solid_color') {
      width = p.width as number;
      height = p.height as number;
      color = p.color as string;
    } else {
      [width, height] = ASPECT[p.aspect_ratio as string] ?? [64, 64];
      // Per-persona colour: identical persona → identical colour; different persona → different colour.
      color = `#${sha256Hex(`${s.persona.influencer_id}:${s.persona.persona_version_id}:${p.seed ?? 0}`).slice(0, 6)}`;
    }
    const outputs: Output[] = [];
    for (let i = 0; i < s.output.count; i++) {
      const outputId = `o${i + 1}`;
      const bytes = encodeSolidPng(width, height, hexToRgb(color));
      const declaredSha = sha256Hex(bytes);
      // Corruption keeps the length but flips one byte (inside the IDAT CRC), so only the hash reveals it.
      const served = job.corrupt ? Buffer.from(bytes) : bytes;
      if (job.corrupt) served[served.length - 13] = served[served.length - 13]! ^ 0xff;
      job.files.set(outputId, { bytes: served, mime: 'image/png' });
      const qa: QaResult[] = [];
      if (s.workflow.key === MOCK_PERSONA_WORKFLOW) {
        const score = job.qaScores?.['mock.identity_similarity'] ?? 0.9;
        qa.push({ check: 'mock.identity_similarity', score, passed: null, threshold: null, details: { note: 'contract mock: synthetic score' } });
      }
      for (const [check, score] of Object.entries(job.qaScores ?? {})) {
        if (!qa.some((q) => q.check === check)) qa.push({ check, score, passed: null, threshold: null, details: {} });
      }
      outputs.push({
        output_id: outputId,
        kind: 'image',
        mime_type: 'image/png',
        width,
        height,
        duration_ms: null,
        bytes: bytes.length,
        sha256: declaredSha,
        download_url: `/vec/v1/jobs/${job.status.job_id}/outputs/${outputId}`,
        provenance: {
          engine_id: engineId,
          engine_version: MOCK_ENGINE_VERSION,
          workflow_key: s.workflow.key,
          workflow_version: s.workflow.version,
          models: [],
          seed: (p.seed as number | undefined) ?? null,
          c2pa: { signed: false, manifest_ref: null },
          engine_metadata: { contract_mock: true, color, adapters: (s.persona.adapters ?? []).map((a) => a.engine_ref) },
        },
        qa,
        metadata: { contract_mock: true },
      });
    }
    return outputs;
  };

  const step = (job: MockJob) => {
    job.timer = null;
    if (job.status.state === 'cancelling' || (job.cancelRequested && job.status.state === 'running')) {
      finish(job, 'cancelled', { error: err('CANCELLED', 'cancelled', 'cancelled by request', false), outputs: [] });
      return;
    }
    if (job.status.state === 'queued') {
      job.startedAtMs = Date.now();
      job.status = { ...job.status, state: 'running', started_at: new Date().toISOString(), progress: { fraction: 0, stage: 'render', message: null } };
      if (job.lose) {
        jobs.delete(job.status.job_id);
        return;
      }
    }
    if (job.hang) {
      job.timer = setTimeout(() => step(job), 20);
      return;
    }
    const elapsed = Date.now() - (job.startedAtMs ?? Date.now());
    if (elapsed < job.delayMs) {
      job.status = { ...job.status, progress: { fraction: Math.min(0.99, elapsed / Math.max(1, job.delayMs)), stage: 'render', message: null } };
      job.timer = setTimeout(() => step(job), Math.min(50, job.delayMs - elapsed));
      return;
    }
    if (job.fail) {
      finish(job, 'failed', { error: job.fail, outputs: [] });
      return;
    }
    finish(job, 'succeeded', { outputs: render(job), progress: { fraction: 1, stage: 'done', message: null }, error: null });
  };

  async function verifyReferences(refs: AssetRef[]): Promise<ErrorObject | null> {
    for (const ref of refs) {
      try {
        const res = await fetch(ref.uri, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return err('REFERENCE_UNAVAILABLE', 'invalid_input', `reference ${ref.asset_id} returned HTTP ${res.status}`, false);
        const bytes = Buffer.from(await res.arrayBuffer());
        if (sha256Hex(bytes) !== ref.sha256) return err('REFERENCE_UNAVAILABLE', 'invalid_input', `reference ${ref.asset_id} sha256 mismatch`, false);
      } catch (e) {
        return err('REFERENCE_UNAVAILABLE', 'invalid_input', `reference ${ref.asset_id} unreachable: ${(e as Error).message}`, false);
      }
    }
    return null;
  }

  app.get('/vec/v1/health', async () => ({ ok: true }));

  app.get('/vec/v1/engine', async () => ({
    engine_id: engineId,
    engine_version: MOCK_ENGINE_VERSION,
    engine_kind: 'contract_mock',
    contract_versions: ['1.0'],
    status: activeCount() >= maxConcurrent ? 'busy' : 'ready',
    capabilities: {
      max_concurrent_jobs: maxConcurrent,
      cancellation: true,
      progress: true,
      callbacks: false,
      resource_release: true,
      output_transfer: ['http_download'],
    },
    gpu: null,
    conformance_mode: conformance,
  }));

  app.get('/vec/v1/workflows', async () => ({
    workflows: [...manifests.values()].map((m) => ({
      workflow_key: m.workflow_key,
      version: m.version,
      task: m.task,
      title: m.title,
      deprecated: m.deprecated === true,
      manifest_sha256: manifestSha256(m as unknown as Record<string, unknown>),
    })),
  }));

  app.get<{ Params: { key: string; version: string } }>('/vec/v1/workflows/:key/versions/:version', async (req, reply) => {
    const m = manifests.get(`${req.params.key}@${req.params.version}`);
    if (m) return m;
    const known = [...manifests.values()].some((x) => x.workflow_key === req.params.key);
    return sendError(reply, 404, known ? err('WORKFLOW_VERSION_NOT_FOUND', 'not_found', 'unknown version', false) : err('WORKFLOW_NOT_FOUND', 'not_found', 'unknown workflow', false));
  });

  app.post('/vec/v1/jobs', async (req, reply) => {
    const body = req.body as JobSubmission | undefined;
    if (!body || typeof body !== 'object') return sendError(reply, 400, err('INVALID_REQUEST', 'invalid_input', 'JSON body required', false));
    if (typeof body.contract_version === 'string' && body.contract_version !== '1.0') {
      return sendError(reply, 400, err('UNSUPPORTED_CONTRACT_VERSION', 'invalid_input', `contract_version ${body.contract_version} not supported`, false));
    }
    const schema = validator.validate('job-submission', body);
    if (!schema.ok) return sendError(reply, 400, err('INVALID_REQUEST', 'invalid_input', 'body does not match job-submission schema', false, { violations: schema.violations }));
    const key = `${body.request_id}:${body.attempt}`;
    if (req.headers['idempotency-key'] !== key) {
      return sendError(reply, 400, err('INVALID_REQUEST', 'invalid_input', 'Idempotency-Key header must equal <request_id>:<attempt>', false));
    }
    const hash = canonicalSha256Hex(body);
    const seen = idempotency.get(key);
    if (seen) {
      if (seen.hash !== hash) return sendError(reply, 409, err('IDEMPOTENCY_CONFLICT', 'conflict', 'same request_id and attempt with a different body', false));
      const existing = jobs.get(seen.jobId);
      if (existing) return reply.status(200).send(existing.status);
    }
    const rejection = takeFault('reject_submit');
    if (rejection) return sendError(reply, rejection.status, rejection.error, rejection.retry_after_s);
    const manifest = manifests.get(`${body.workflow.key}@${body.workflow.version}`);
    if (!manifest) {
      const known = [...manifests.values()].some((m) => m.workflow_key === body.workflow.key);
      return sendError(reply, 404, known ? err('WORKFLOW_VERSION_NOT_FOUND', 'not_found', 'unknown version', false) : err('WORKFLOW_NOT_FOUND', 'not_found', 'unknown workflow', false));
    }
    const params = validator.validateParameters(manifestSha256(manifest as unknown as Record<string, unknown>), manifest.input_schema, body.parameters);
    if (!params.ok) {
      return sendError(reply, 422, err('PARAMETER_VALIDATION_FAILED', 'invalid_input', 'parameters violate input_schema', false, { violations: params.violations }));
    }
    if (body.output.count < manifest.outputs.count.min || body.output.count > manifest.outputs.count.max) {
      return sendError(reply, 422, err('PARAMETER_VALIDATION_FAILED', 'invalid_input', 'output.count outside manifest limits', false, { violations: [{ path: '/output/count', message: 'out of range' }] }));
    }
    for (const a of [...(body.persona.adapters ?? []), ...(body.adapters ?? [])]) {
      if (!a.engine_ref.startsWith('mock:')) return sendError(reply, 422, err('ADAPTER_UNAVAILABLE', 'invalid_input', `unknown adapter ${a.engine_ref}`, false));
    }
    if (activeCount() >= maxConcurrent) {
      return sendError(reply, 429, err('ENGINE_BUSY', 'resource', 'max_concurrent_jobs reached', true, undefined), 1);
    }
    const refError = await verifyReferences([...(body.persona.reference_assets ?? []), ...(body.references ?? [])]);
    if (refError) return sendError(reply, 422, refError);

    const jobId = `mock_${Date.now().toString(36)}_${(++seq).toString(36)}`;
    const p = body.parameters as Record<string, unknown>;
    const wk = body.workflow.key;
    const job: MockJob = {
      status: {
        job_id: jobId,
        request_id: body.request_id,
        attempt: body.attempt,
        workflow: body.workflow,
        state: 'queued',
        progress: null,
        created_at: new Date().toISOString(),
        started_at: null,
        finished_at: null,
        outputs: [],
        error: null,
        resource_usage: null,
        engine: engineRef,
      },
      submission: body,
      bodyHash: hash,
      delayMs: typeof p.delay_ms === 'number' ? p.delay_ms : defaultDelay,
      hang: takeFault('hang', wk) !== null,
      fail: takeFault('fail_job', wk)?.error ?? null,
      lose: takeFault('lose_job', wk) !== null,
      protocolError: takeFault('protocol_error', wk) !== null,
      corrupt: takeFault('corrupt_output', wk) !== null,
      qaScores: takeFault('qa_scores', wk)?.scores ?? null,
      files: new Map(),
      cancelRequested: false,
      startedAtMs: null,
      timer: null,
    };
    jobs.set(jobId, job);
    idempotency.set(key, { hash, jobId });
    job.timer = setTimeout(() => step(job), 10);
    if (takeFault('drop_submit_response')) {
      // Simulates an ambiguous submit: the job exists but the client never sees the response.
      reply.hijack();
      req.raw.socket.destroy();
      return;
    }
    return reply.status(202).send(job.status);
  });

  app.get<{ Params: { id: string } }>('/vec/v1/jobs/:id', async (req, reply) => {
    const job = jobs.get(req.params.id);
    if (!job) return sendError(reply, 404, err('JOB_NOT_FOUND', 'not_found', 'unknown job', false));
    if (job.protocolError) return { job_id: job.status.job_id, state: 'exploded' };
    return job.status;
  });

  app.post<{ Params: { id: string } }>('/vec/v1/jobs/:id/cancel', async (req, reply) => {
    const job = jobs.get(req.params.id);
    if (!job) return sendError(reply, 404, err('JOB_NOT_FOUND', 'not_found', 'unknown job', false));
    if (job.status.state === 'queued') {
      finish(job, 'cancelled', { error: err('CANCELLED', 'cancelled', 'cancelled by request', false), outputs: [] });
    } else if (job.status.state === 'running') {
      job.cancelRequested = true;
      job.status = { ...job.status, state: 'cancelling' };
      if (job.timer) clearTimeout(job.timer);
      job.timer = setTimeout(() => step(job), 20);
    }
    return job.status;
  });

  app.get<{ Params: { id: string; oid: string } }>('/vec/v1/jobs/:id/outputs/:oid', async (req, reply) => {
    const file = jobs.get(req.params.id)?.files.get(req.params.oid);
    if (!file) return sendError(reply, 404, err('JOB_NOT_FOUND', 'not_found', 'unknown job or output', false));
    const declared = jobs.get(req.params.id)!.status.outputs?.find((o) => o.output_id === req.params.oid)?.sha256;
    return reply.header('content-type', file.mime).header('x-content-sha256', declared ?? sha256Hex(file.bytes)).send(file.bytes);
  });

  app.get('/vec/v1/resources', async () => {
    const all = [...jobs.values()];
    return {
      status: activeCount() >= maxConcurrent ? 'busy' : 'ready',
      vram_total_mb: null,
      vram_in_use_mb: null,
      loaded: [],
      running_job_ids: all.filter((j) => j.status.state === 'running' || j.status.state === 'cancelling').map((j) => j.status.job_id),
      queue_depth: all.filter((j) => j.status.state === 'queued').length,
    };
  });

  app.post('/vec/v1/resources/release', async (req, reply) => {
    const body = req.body as { scope?: string } | undefined;
    const check = validator.validate('release-request', body);
    if (!check.ok) return sendError(reply, 400, err('INVALID_REQUEST', 'invalid_input', 'invalid release request', false, { violations: check.violations }));
    if (body!.scope === 'all_models' && activeCount() > 0) {
      return sendError(reply, 409, err('RESOURCES_IN_USE', 'conflict', 'all_models release requires an idle engine', false));
    }
    return { released: true, vram_in_use_mb: null };
  });

  // Test-only control plane (outside /vec/v1, same bearer token).
  app.post('/__mock__/faults', async (req) => {
    const f = req.body as Fault | { clear: true };
    if ('clear' in f) faults = [];
    else faults.push(f);
    return { faults };
  });
  app.get('/__mock__/jobs', async () => [...jobs.values()].map((j) => j.status));

  const address = await app.listen({ host: opts.host ?? '127.0.0.1', port: opts.port ?? 0 });
  return {
    app,
    url: `${address}/vec/v1`,
    injectFault: (f) => faults.push(f),
    clearFaults: () => {
      faults = [];
    },
    jobs: () => [...jobs.values()].map((j) => j.status),
    close: async () => {
      for (const j of jobs.values()) if (j.timer) clearTimeout(j.timer);
      await app.close();
    },
  };
}
