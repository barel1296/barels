/**
 * ComfyUI bridge: a Visual Engine Contract v1 server in front of an EXISTING
 * ComfyUI installation. It contains no image or video workflows and selects
 * no models; it runs the workflow packages Track A supplies (see packages.ts)
 * through ComfyUI's HTTP API and adds what the contract requires on top:
 * authentication, idempotent submissions, the normative job state machine,
 * persisted job state, hashed outputs, cancellation, timeouts, resource
 * reporting and GPU release. The reserved __conformance__.solid_color
 * workflow is rendered natively (no model, no GPU), as the contract requires.
 */
import { randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import type { AssetRef, ErrorObject, JobStatus, JobSubmission, Output, WorkflowManifest } from '../contract/types.js';
import { ContractValidator } from '../contract/validator.js';
import { canonicalSha256Hex, manifestSha256, sha256Hex } from '../lib/canonical-json.js';
import { safeEqual } from '../lib/crypto.js';
import { EXTENSION_BY_MIME, kindOfMime, readDimensions, sniffMime } from '../lib/media.js';
import { encodeSolidPng, hexToRgb } from '../lib/png.js';
import { ComfyClient, ComfyError, type HistoryEntry, runningPromptIds } from './comfy-client.js';
import { type PlacedReferences, type WorkflowPackage, boundReferences, buildPrompt, loadPackages } from './packages.js';

export const BRIDGE_VERSION = '1.0.0';
const CONFORMANCE_KEY = '__conformance__.solid_color';
const MB = 1024 * 1024;

export interface BridgeOptions {
  token: string;
  comfyUrl: string;
  packagesDir: string;
  dataDir: string;
  contractDir: string;
  engineId?: string;
  maxConcurrentJobs?: number;
  conformanceMode?: boolean;
  /** Subfolder of ComfyUI's input directory used for reference uploads. */
  inputSubfolder?: string;
  pollIntervalMs?: number;
  host?: string;
  port?: number;
}

interface BridgeJob {
  status: JobStatus;
  bodyHash: string;
  key: string;
  promptId: string | null;
  native: boolean;
  delayMs: number;
  startedAtMs: number | null;
  cancelRequested: boolean;
  timeoutS: number;
  outputCount: number;
  parameters: Record<string, unknown>;
  seed: number | null;
}

export interface Bridge {
  app: FastifyInstance;
  url: string;
  packages: Map<string, WorkflowPackage>;
  packageErrors: { dir: string; error: string }[];
  tick(): Promise<void>;
  close(): Promise<void>;
}

const err = (code: string, cls: ErrorObject['class'], message: string, retryable: boolean, details?: Record<string, unknown>): ErrorObject => ({
  code,
  class: cls,
  message,
  retryable,
  ...(details ? { details } : {}),
});

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

/** Classifies a ComfyUI execution error honestly (contract §8.1). */
export function classifyComfyError(text: string): ErrorObject {
  if (/out of memory|OutOfMemoryError|CUDA error: out of memory|allocation on device/i.test(text)) {
    return err('RESOURCE_EXHAUSTED', 'resource', 'GPU out of memory', true, { comfyui: text.slice(0, 500) });
  }
  if (/value not in list|ckpt_name|lora_name|unet_name|vae_name|clip_name|No such file|FileNotFoundError|not found in/i.test(text)) {
    return err('MODEL_UNAVAILABLE', 'permanent', 'a model or file required by the workflow is missing on this ComfyUI installation', false, { comfyui: text.slice(0, 500) });
  }
  return err('EXECUTION_FAILED', 'permanent', 'ComfyUI could not execute the workflow', false, { comfyui: text.slice(0, 500) });
}

export async function startBridge(opts: BridgeOptions): Promise<Bridge> {
  const validator = new ContractValidator(opts.contractDir);
  const comfy = new ComfyClient(opts.comfyUrl.replace(/\/+$/, ''));
  const engineId = opts.engineId ?? 'comfyui-bridge';
  const maxConcurrent = opts.maxConcurrentJobs ?? 1;
  const conformance = opts.conformanceMode ?? true;
  const subfolder = opts.inputSubfolder ?? 'golden-refs';
  const jobsDir = join(opts.dataDir, 'jobs');
  const outDir = join(opts.dataDir, 'outputs');
  mkdirSync(jobsDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const loaded = loadPackages(opts.packagesDir, validator);
  for (const e of loaded.errors) console.error(`[comfy-bridge] package rejected: ${e.dir}: ${e.error}`);
  const packages = loaded.packages;
  const conformanceManifest = JSON.parse(readFileSync(join(opts.contractDir, 'examples/workflow-manifest.conformance-solid-color.json'), 'utf8')) as WorkflowManifest;
  const manifestOf = (key: string, version: string): WorkflowManifest | null =>
    conformance && key === CONFORMANCE_KEY && version === conformanceManifest.version ? conformanceManifest : (packages.get(`${key}@${version}`)?.manifest ?? null);
  const allManifests = () => [...(conformance ? [conformanceManifest] : []), ...[...packages.values()].map((p) => p.manifest)];

  // --- persisted job store -------------------------------------------------------
  const jobs = new Map<string, BridgeJob>();
  const byKey = new Map<string, string>();
  const persist = (j: BridgeJob) => {
    const tmp = join(jobsDir, `${j.status.job_id}.json.tmp`);
    writeFileSync(tmp, JSON.stringify(j));
    renameSync(tmp, join(jobsDir, `${j.status.job_id}.json`));
  };
  for (const f of readdirSync(jobsDir).filter((x) => x.endsWith('.json'))) {
    try {
      const j = JSON.parse(readFileSync(join(jobsDir, f), 'utf8')) as BridgeJob;
      jobs.set(j.status.job_id, j);
      byKey.set(j.key, j.status.job_id);
    } catch (e) {
      console.error(`[comfy-bridge] unreadable job file ${f}: ${(e as Error).message}`);
    }
  }
  // Native (conformance) jobs cannot survive a restart: they are failed honestly.
  for (const j of jobs.values()) {
    if (j.native && !TERMINAL.has(j.status.state)) finish(j, 'failed', { error: err('INTERNAL', 'transient', 'engine restarted during the job', true), outputs: [] });
  }

  const active = () => [...jobs.values()].filter((j) => !TERMINAL.has(j.status.state));
  const engineRef = { engine_id: engineId, engine_version: BRIDGE_VERSION };
  let comfyVersion: string | null = null;

  function finish(j: BridgeJob, state: 'succeeded' | 'failed' | 'cancelled', extra: Partial<JobStatus> & { gpuSeconds?: number } = {}): void {
    const now = new Date();
    const wall = j.startedAtMs ? (now.getTime() - j.startedAtMs) / 1000 : 0;
    const { gpuSeconds, ...rest } = extra;
    j.status = {
      ...j.status,
      state,
      finished_at: now.toISOString(),
      resource_usage: { gpu_seconds: j.native ? 0 : Math.round((gpuSeconds ?? 0) * 1000) / 1000, wall_seconds: Math.round(wall * 1000) / 1000, vram_peak_mb: null },
      ...rest,
    };
    if (state !== 'succeeded') j.status.outputs = [];
    persist(j);
  }

  function setRunning(j: BridgeJob): void {
    if (j.status.state !== 'queued') return;
    j.startedAtMs = Date.now();
    j.status = { ...j.status, state: j.cancelRequested ? 'cancelling' : 'running', started_at: new Date().toISOString(), progress: { fraction: null, stage: 'executing', message: null } };
    persist(j);
  }

  function storeOutput(j: BridgeJob, outputId: string, bytes: Buffer, mime: NonNullable<ReturnType<typeof sniffMime>>): string {
    const dir = join(outDir, j.status.job_id);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${outputId}.${EXTENSION_BY_MIME[mime]}`);
    writeFileSync(path, bytes);
    return path;
  }

  // --- native conformance workflow -------------------------------------------------
  function nativeStep(j: BridgeJob): void {
    if (TERMINAL.has(j.status.state)) return;
    if (j.cancelRequested) {
      finish(j, 'cancelled', { error: err('CANCELLED', 'cancelled', 'cancelled by request', false) });
      return;
    }
    if (j.status.state === 'queued') setRunning(j);
    const elapsed = Date.now() - (j.startedAtMs ?? Date.now());
    if (elapsed < j.delayMs) {
      j.status = { ...j.status, progress: { fraction: Math.min(0.99, elapsed / Math.max(1, j.delayMs)), stage: 'render', message: null } };
      setTimeout(() => nativeStep(j), Math.min(50, j.delayMs - elapsed));
      return;
    }
    const p = j.parameters as { color: string; width: number; height: number };
    const outputs: Output[] = [];
    for (let i = 0; i < j.outputCount; i++) {
      const id = `o${i + 1}`;
      const bytes = encodeSolidPng(p.width, p.height, hexToRgb(p.color));
      storeOutput(j, id, bytes, 'image/png');
      outputs.push({
        output_id: id,
        kind: 'image',
        mime_type: 'image/png',
        width: p.width,
        height: p.height,
        duration_ms: null,
        bytes: bytes.length,
        sha256: sha256Hex(bytes),
        download_url: `/vec/v1/jobs/${j.status.job_id}/outputs/${id}`,
        provenance: { engine_id: engineId, engine_version: BRIDGE_VERSION, workflow_key: CONFORMANCE_KEY, workflow_version: j.status.workflow.version, models: [], seed: null, c2pa: { signed: false, manifest_ref: null }, engine_metadata: { native_conformance: true } },
        qa: [],
      });
    }
    finish(j, 'succeeded', { outputs, progress: { fraction: 1, stage: 'done', message: null }, error: null });
  }

  // --- ComfyUI jobs -------------------------------------------------------------------
  async function placeReferences(j: BridgeJob, refs: AssetRef[]): Promise<PlacedReferences | ErrorObject> {
    const placed: PlacedReferences = new Map();
    for (const [i, ref] of refs.entries()) {
      let bytes: Buffer;
      try {
        const res = await fetch(ref.uri, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) return err('REFERENCE_UNAVAILABLE', 'invalid_input', `reference ${ref.asset_id} returned HTTP ${res.status}`, false);
        bytes = Buffer.from(await res.arrayBuffer());
      } catch (e) {
        return err('REFERENCE_UNAVAILABLE', 'invalid_input', `reference ${ref.asset_id} unreachable: ${(e as Error).message}`, false);
      }
      if (sha256Hex(bytes) !== ref.sha256) return err('REFERENCE_UNAVAILABLE', 'invalid_input', `reference ${ref.asset_id} sha256 mismatch`, false);
      const mime = sniffMime(bytes);
      if (!mime || kindOfMime(mime) !== 'image') return err('REFERENCE_UNAVAILABLE', 'invalid_input', `reference ${ref.asset_id} is not an image`, false);
      const up = await comfy.uploadImage(bytes, `${j.status.job_id}_${i}_${ref.sha256.slice(0, 12)}.${EXTENSION_BY_MIME[mime]}`, subfolder, mime);
      const name = up.subfolder ? `${up.subfolder}/${up.name}` : up.name;
      placed.set(ref.role, [...(placed.get(ref.role) ?? []), name]);
    }
    return placed;
  }

  async function startComfyJob(j: BridgeJob, pkg: WorkflowPackage, body: JobSubmission): Promise<ErrorObject | null> {
    const refs = boundReferences(pkg, [...(body.persona.reference_assets ?? []), ...(body.references ?? [])]);
    const placed = await placeReferences(j, refs);
    if (!(placed instanceof Map)) return placed;
    const adapters = [...(body.persona.adapters ?? []), ...(body.adapters ?? [])];
    const prompt = buildPrompt(pkg, { parameters: j.parameters, seed: j.seed!, outputCount: j.outputCount, adapters, references: placed });
    try {
      const q = await comfy.queuePrompt(prompt, `${engineId}:${j.status.job_id}`);
      if (q.node_errors && Object.keys(q.node_errors).length) throw new ComfyError('node errors', 400, q);
      j.promptId = q.prompt_id;
      persist(j);
      return null;
    } catch (e) {
      if (e instanceof ComfyError && e.status === 400) {
        finish(j, 'failed', { error: classifyComfyError(JSON.stringify(e.body ?? e.message)) });
        return null;
      }
      throw e;
    }
  }

  function executionSeconds(h: HistoryEntry): number {
    const msgs = h.status?.messages ?? [];
    const start = msgs.find((m) => m[0] === 'execution_start')?.[1]?.timestamp as number | undefined;
    const end = [...msgs].reverse().find((m) => ['execution_success', 'execution_error', 'execution_interrupted'].includes(m[0]))?.[1]?.timestamp as number | undefined;
    return start && end ? Math.max(0, (end - start) / 1000) : 0;
  }

  async function collectOutputs(j: BridgeJob, pkg: WorkflowPackage, h: HistoryEntry): Promise<Output[]> {
    const outputs: Output[] = [];
    for (const o of pkg.bindings.outputs) {
      const node = (h.outputs?.[o.node] ?? {}) as Record<string, unknown>;
      const files = (['images', 'gifs', 'videos'] as const).flatMap((k) => (Array.isArray(node[k]) ? (node[k] as { filename: string; subfolder: string; type: string }[]) : []));
      for (const f of files.filter((x) => x.type === 'output')) {
        const { bytes } = await comfy.view(f);
        const mime = sniffMime(bytes);
        if (!mime) throw new Error(`unrecognised output format for ${f.filename}`);
        const id = `o${outputs.length + 1}`;
        storeOutput(j, id, bytes, mime);
        const dims = readDimensions(bytes, mime);
        const models = (pkg.manifest.engine_metadata as { provenance_models?: Output['provenance']['models'] } | undefined)?.provenance_models ?? [];
        outputs.push({
          output_id: id,
          kind: kindOfMime(mime),
          mime_type: mime,
          ...(dims ? { width: dims.width, height: dims.height } : {}),
          duration_ms: null,
          bytes: bytes.length,
          sha256: sha256Hex(bytes),
          download_url: `/vec/v1/jobs/${j.status.job_id}/outputs/${id}`,
          provenance: {
            engine_id: engineId,
            engine_version: BRIDGE_VERSION,
            workflow_key: pkg.manifest.workflow_key,
            workflow_version: pkg.manifest.version,
            models,
            seed: j.seed,
            c2pa: { signed: false, manifest_ref: null },
            engine_metadata: { comfyui_prompt_id: j.promptId, comfyui_version: comfyVersion, output_node: o.node },
          },
          qa: [],
        });
      }
    }
    return outputs;
  }

  async function pollComfyJobs(): Promise<void> {
    const mine = active().filter((j) => !j.native && j.promptId);
    if (!mine.length) return;
    let queue: { running: string[]; pending: string[] };
    try {
      queue = runningPromptIds(await comfy.queue());
    } catch {
      return; // ComfyUI unreachable: try again next tick (jobs time out on their own deadline)
    }
    for (const j of mine) {
      const pkg = packages.get(`${j.status.workflow.key}@${j.status.workflow.version}`);
      const pid = j.promptId!;
      try {
        const h = await comfy.history(pid);
        if (h?.status?.completed || h?.status?.status_str) {
          if (!j.startedAtMs) setRunning(j);
          const secs = executionSeconds(h);
          const interrupted = (h.status?.messages ?? []).some((m) => m[0] === 'execution_interrupted');
          if (j.cancelRequested || interrupted) finish(j, 'cancelled', { error: err('CANCELLED', 'cancelled', 'cancelled by request', false), gpuSeconds: secs });
          else if (h.status?.status_str === 'error') {
            const e = (h.status.messages ?? []).find((m) => m[0] === 'execution_error')?.[1] ?? {};
            finish(j, 'failed', { error: classifyComfyError(`${String(e.exception_type ?? '')}: ${String(e.exception_message ?? '')} (${String(e.node_type ?? '')})`), gpuSeconds: secs });
          } else if (pkg) {
            try {
              const outputs = await collectOutputs(j, pkg, h);
              if (outputs.length === 0) finish(j, 'failed', { error: err('EXECUTION_FAILED', 'permanent', 'the workflow produced no outputs on the bound output nodes', false), gpuSeconds: secs });
              else finish(j, 'succeeded', { outputs, error: null, progress: { fraction: 1, stage: 'done', message: null }, gpuSeconds: secs });
            } catch (e) {
              finish(j, 'failed', { error: err('OUTPUT_TRANSFER_FAILED', 'transient', (e as Error).message, true), gpuSeconds: secs });
            }
          }
          continue;
        }
        if (queue.running.includes(pid)) setRunning(j);
        else if (!queue.pending.includes(pid)) {
          // Neither queued, running nor in history: ComfyUI restarted or the prompt was removed outside the bridge.
          finish(j, 'failed', { error: err('EXECUTION_FAILED', 'transient', 'the prompt disappeared from ComfyUI (restart or manual removal)', true) });
          continue;
        }
        const started = j.startedAtMs ?? Date.parse(j.status.created_at);
        if (Date.now() - started > j.timeoutS * 1000) {
          if (queue.running.includes(pid)) await comfy.interrupt(pid).catch(() => undefined);
          else await comfy.deleteFromQueue([pid]).catch(() => undefined);
          finish(j, 'failed', { error: err('TIMEOUT', 'timeout', `exceeded ${j.timeoutS}s`, true) });
        } else if (j.cancelRequested && queue.pending.includes(pid)) {
          await comfy.deleteFromQueue([pid]);
          finish(j, 'cancelled', { error: err('CANCELLED', 'cancelled', 'cancelled by request', false) });
        }
      } catch (e) {
        console.error(`[comfy-bridge] poll ${j.status.job_id}: ${(e as Error).message}`);
      }
    }
  }

  // --- HTTP ------------------------------------------------------------------------
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  const sendError = (reply: FastifyReply, status: number, e: ErrorObject, retryAfterS?: number) => {
    if (retryAfterS !== undefined) reply.header('retry-after', String(retryAfterS));
    return reply.status(status).send({ error: e });
  };
  app.addHook('onRequest', async (req, reply) => {
    const auth = req.headers.authorization ?? '';
    if (!(auth.startsWith('Bearer ') && safeEqual(auth.slice(7), opts.token))) return sendError(reply, 401, err('UNAUTHORIZED', 'auth', 'missing or invalid token', false));
  });

  async function comfyStats() {
    try {
      const s = await comfy.systemStats();
      comfyVersion = s.system?.comfyui_version ?? comfyVersion;
      return s;
    } catch {
      return null;
    }
  }

  app.get('/vec/v1/health', async (_req, reply) => {
    const s = await comfyStats();
    if (!s) return sendError(reply, 503, err('ENGINE_UNAVAILABLE', 'transient', 'ComfyUI is not reachable', true), 5);
    return { ok: true, comfyui_version: comfyVersion };
  });

  app.get('/vec/v1/engine', async () => {
    const s = await comfyStats();
    const dev = s?.devices?.[0];
    return {
      engine_id: engineId,
      engine_version: BRIDGE_VERSION,
      engine_kind: 'comfyui',
      contract_versions: ['1.0'],
      status: !s ? 'degraded' : active().length >= maxConcurrent ? 'busy' : 'ready',
      capabilities: { max_concurrent_jobs: maxConcurrent, cancellation: true, progress: false, callbacks: false, resource_release: true, output_transfer: ['http_download'] },
      gpu: dev ? { name: dev.name, vram_total_mb: Math.round(dev.vram_total / MB) } : null,
      conformance_mode: conformance,
    };
  });

  app.get('/vec/v1/workflows', async () => ({
    workflows: allManifests().map((m) => ({ workflow_key: m.workflow_key, version: m.version, task: m.task, title: m.title, deprecated: m.deprecated === true, manifest_sha256: manifestSha256(m as unknown as Record<string, unknown>) })),
  }));

  app.get<{ Params: { key: string; version: string } }>('/vec/v1/workflows/:key/versions/:version', async (req, reply) => {
    const m = manifestOf(req.params.key, req.params.version);
    if (m) return m;
    const known = allManifests().some((x) => x.workflow_key === req.params.key);
    return sendError(reply, 404, known ? err('WORKFLOW_VERSION_NOT_FOUND', 'not_found', 'unknown version', false) : err('WORKFLOW_NOT_FOUND', 'not_found', 'unknown workflow', false));
  });

  const submitting = new Map<string, Promise<unknown>>();

  app.post('/vec/v1/jobs', async (req, reply) => {
    const body = req.body as JobSubmission | undefined;
    if (!body || typeof body !== 'object') return sendError(reply, 400, err('INVALID_REQUEST', 'invalid_input', 'JSON body required', false));
    if (typeof body.contract_version === 'string' && body.contract_version !== '1.0') {
      return sendError(reply, 400, err('UNSUPPORTED_CONTRACT_VERSION', 'invalid_input', `contract_version ${body.contract_version} not supported`, false));
    }
    const schema = validator.validate('job-submission', body);
    if (!schema.ok) return sendError(reply, 400, err('INVALID_REQUEST', 'invalid_input', 'body does not match job-submission schema', false, { violations: schema.violations }));
    const key = `${body.request_id}:${body.attempt}`;
    if (req.headers['idempotency-key'] !== key) return sendError(reply, 400, err('INVALID_REQUEST', 'invalid_input', 'Idempotency-Key header must equal <request_id>:<attempt>', false));
    await submitting.get(key);
    const hash = canonicalSha256Hex(body);
    const seenId = byKey.get(key);
    if (seenId) {
      const seen = jobs.get(seenId)!;
      if (seen.bodyHash !== hash) return sendError(reply, 409, err('IDEMPOTENCY_CONFLICT', 'conflict', 'same request_id and attempt with a different body', false));
      return reply.status(200).send(seen.status);
    }
    const manifest = manifestOf(body.workflow.key, body.workflow.version);
    if (!manifest) {
      const known = allManifests().some((m) => m.workflow_key === body.workflow.key);
      return sendError(reply, 404, known ? err('WORKFLOW_VERSION_NOT_FOUND', 'not_found', 'unknown version', false) : err('WORKFLOW_NOT_FOUND', 'not_found', 'unknown workflow', false));
    }
    if (manifest.deprecated && manifest.sunset_at && Date.parse(manifest.sunset_at) < Date.now()) return sendError(reply, 409, err('WORKFLOW_DISABLED', 'conflict', 'workflow version is past its sunset date', false));
    const params = validator.validateParameters(manifestSha256(manifest as unknown as Record<string, unknown>), manifest.input_schema, body.parameters);
    if (!params.ok) return sendError(reply, 422, err('PARAMETER_VALIDATION_FAILED', 'invalid_input', 'parameters violate input_schema', false, { violations: params.violations }));
    if (body.output.count < manifest.outputs.count.min || body.output.count > manifest.outputs.count.max) {
      return sendError(reply, 422, err('PARAMETER_VALIDATION_FAILED', 'invalid_input', 'output.count outside manifest limits', false, { violations: [{ path: '/output/count', message: 'out of range' }] }));
    }
    const adapters = [...(body.persona.adapters ?? []), ...(body.adapters ?? [])];
    if (adapters.length > (manifest.references?.adapters?.max ?? 0)) return sendError(reply, 422, err('ADAPTER_UNAVAILABLE', 'invalid_input', 'more adapters than the workflow accepts', false));
    if (active().length >= maxConcurrent) return sendError(reply, 429, err('ENGINE_BUSY', 'resource', 'max_concurrent_jobs reached', true), 2);
    const native = body.workflow.key === CONFORMANCE_KEY;
    if (!native && !(await comfyStats())) return sendError(reply, 503, err('ENGINE_UNAVAILABLE', 'transient', 'ComfyUI is not reachable', true), 5);

    const p = body.parameters as Record<string, unknown>;
    const job: BridgeJob = {
      status: {
        job_id: `cb_${Date.now().toString(36)}_${randomInt(1e9).toString(36)}`,
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
      bodyHash: hash,
      key,
      promptId: null,
      native,
      delayMs: typeof p.delay_ms === 'number' ? p.delay_ms : 0,
      startedAtMs: null,
      cancelRequested: false,
      timeoutS: Math.min(body.timeout_s, manifest.timeouts.max_runtime_s),
      outputCount: body.output.count,
      parameters: p,
      seed: native ? null : typeof p.seed === 'number' ? p.seed : randomInt(0, 2 ** 32 - 1),
    };
    jobs.set(job.status.job_id, job);
    byKey.set(key, job.status.job_id);
    persist(job);
    if (native) {
      setTimeout(() => nativeStep(job), 5);
      return reply.status(202).send(job.status);
    }
    const work = (async () => {
      try {
        const refError = await startComfyJob(job, packages.get(`${body.workflow.key}@${body.workflow.version}`)!, body);
        if (refError) finish(job, 'failed', { error: refError });
        return refError;
      } catch (e) {
        finish(job, 'failed', { error: err('ENGINE_UNAVAILABLE', 'transient', `ComfyUI rejected or did not answer: ${(e as Error).message}`, true) });
        return null;
      }
    })();
    submitting.set(key, work);
    const refError = await work.finally(() => submitting.delete(key));
    if (refError) return sendError(reply, 422, refError as ErrorObject);
    return reply.status(202).send(job.status);
  });

  app.get<{ Params: { id: string } }>('/vec/v1/jobs/:id', async (req, reply) => {
    const j = jobs.get(req.params.id);
    if (!j) return sendError(reply, 404, err('JOB_NOT_FOUND', 'not_found', 'unknown job', false));
    return j.status;
  });

  app.post<{ Params: { id: string } }>('/vec/v1/jobs/:id/cancel', async (req, reply) => {
    const j = jobs.get(req.params.id);
    if (!j) return sendError(reply, 404, err('JOB_NOT_FOUND', 'not_found', 'unknown job', false));
    if (TERMINAL.has(j.status.state)) return j.status;
    j.cancelRequested = true;
    if (j.native) {
      if (j.status.state === 'queued') finish(j, 'cancelled', { error: err('CANCELLED', 'cancelled', 'cancelled by request', false) });
      else j.status = { ...j.status, state: 'cancelling' };
      persist(j);
      return j.status;
    }
    if (!j.promptId) {
      finish(j, 'cancelled', { error: err('CANCELLED', 'cancelled', 'cancelled by request', false) });
      return j.status;
    }
    try {
      const q = runningPromptIds(await comfy.queue());
      if (q.pending.includes(j.promptId)) {
        await comfy.deleteFromQueue([j.promptId]);
        finish(j, 'cancelled', { error: err('CANCELLED', 'cancelled', 'cancelled by request', false) });
      } else if (q.running.includes(j.promptId)) {
        // Only our own running prompt is interrupted, never someone else's work in the same ComfyUI.
        await comfy.interrupt(j.promptId);
        j.status = { ...j.status, state: 'cancelling' };
        persist(j);
      } else {
        j.status = { ...j.status, state: 'cancelling' };
        persist(j);
      }
    } catch {
      j.status = { ...j.status, state: 'cancelling' };
      persist(j);
    }
    return j.status;
  });

  app.get<{ Params: { id: string; oid: string } }>('/vec/v1/jobs/:id/outputs/:oid', async (req, reply) => {
    const j = jobs.get(req.params.id);
    const o = j?.status.outputs?.find((x) => x.output_id === req.params.oid);
    if (!j || !o) return sendError(reply, 404, err('JOB_NOT_FOUND', 'not_found', 'unknown job or output', false));
    const path = join(outDir, j.status.job_id, `${o.output_id}.${EXTENSION_BY_MIME[o.mime_type]}`);
    if (!existsSync(path)) return sendError(reply, 404, err('JOB_NOT_FOUND', 'not_found', 'output no longer retained', false));
    return reply.header('content-type', o.mime_type).header('x-content-sha256', o.sha256).send(readFileSync(path));
  });

  app.get('/vec/v1/resources', async () => {
    const s = await comfyStats();
    const dev = s?.devices?.[0];
    return {
      status: !s ? 'degraded' : active().length >= maxConcurrent ? 'busy' : 'ready',
      vram_total_mb: dev ? Math.round(dev.vram_total / MB) : null,
      // Device-level figure (includes other processes on the GPU, e.g. the local LLM).
      vram_in_use_mb: dev ? Math.round((dev.vram_total - dev.vram_free) / MB) : null,
      loaded: [],
      running_job_ids: active().filter((j) => j.status.state === 'running' || j.status.state === 'cancelling').map((j) => j.status.job_id),
      queue_depth: active().filter((j) => j.status.state === 'queued').length,
    };
  });

  app.post('/vec/v1/resources/release', async (req, reply) => {
    const body = req.body as { scope?: string } | undefined;
    const check = validator.validate('release-request', body);
    if (!check.ok) return sendError(reply, 400, err('INVALID_REQUEST', 'invalid_input', 'invalid release request', false, { violations: check.violations }));
    const busy = active().some((j) => !j.native && (j.status.state === 'running' || j.status.state === 'cancelling'));
    let comfyBusy = false;
    try {
      comfyBusy = runningPromptIds(await comfy.queue()).running.length > 0;
    } catch {
      return sendError(reply, 503, err('ENGINE_UNAVAILABLE', 'transient', 'ComfyUI is not reachable', true), 5);
    }
    if (busy || comfyBusy) {
      if (body!.scope === 'all_models') return sendError(reply, 409, err('RESOURCES_IN_USE', 'conflict', 'all_models release requires an idle engine', false));
      return { released: false, vram_in_use_mb: null };
    }
    await comfy.free({ unloadModels: true, freeMemory: body!.scope === 'all_models' });
    const dev = (await comfyStats())?.devices?.[0];
    return { released: true, vram_in_use_mb: dev ? Math.round((dev.vram_total - dev.vram_free) / MB) : null };
  });

  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const loop = async () => {
    if (stopped) return;
    await pollComfyJobs().catch((e) => console.error(`[comfy-bridge] poll failed: ${(e as Error).message}`));
    if (!stopped) timer = setTimeout(() => void loop(), opts.pollIntervalMs ?? 1000);
  };
  const address = await app.listen({ host: opts.host ?? '127.0.0.1', port: opts.port ?? 0 });
  void loop();
  return {
    app,
    url: `${address}/vec/v1`,
    packages,
    packageErrors: loaded.errors,
    tick: pollComfyJobs,
    close: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await app.close();
    },
  };
}
