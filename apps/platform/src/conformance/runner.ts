/**
 * Visual Engine Contract conformance runner (contracts/visual-engine README §13).
 * Executes scenarios C01–C16 over raw HTTP against an engine in conformance
 * mode. Track A runs it against the ComfyUI-backed engine; CI runs it against
 * the contract mock. A pass against `contract_mock` only proves the fixtures
 * and the runner, never a real engine.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { EngineInfo, JobStatus, JobSubmission, WorkflowManifest } from '../contract/types.js';
import { ContractValidator } from '../contract/validator.js';
import { canonicalize, manifestSha256, sha256Hex } from '../lib/canonical-json.js';
import { readPngSize } from '../lib/png.js';
import { sniffMime } from '../lib/media.js';

export interface ScenarioResult {
  id: string;
  name: string;
  passed: boolean;
  detail: string;
}

export interface ConformanceReport {
  engine_url: string;
  engine: Pick<EngineInfo, 'engine_id' | 'engine_version' | 'engine_kind'> | null;
  started_at: string;
  finished_at: string;
  passed: boolean;
  results: ScenarioResult[];
  note: string;
}

interface Http {
  status: number;
  body: unknown;
  headers: Headers;
  raw?: Buffer;
}

class Assertion extends Error {}

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Assertion(message);
}

export async function runConformance(opts: { engineUrl: string; token: string; contractDir: string; timeoutS?: number }): Promise<ConformanceReport> {
  const base = opts.engineUrl.replace(/\/+$/, '');
  const validator = new ContractValidator(opts.contractDir);
  const fixtures = join(opts.contractDir, 'fixtures');
  const scenarios = JSON.parse(readFileSync(join(fixtures, 'conformance-scenarios.json'), 'utf8')) as {
    workflow: { key: string; version: string };
    scenarios: { id: string; name: string }[];
  };
  const normative = JSON.parse(readFileSync(join(opts.contractDir, 'examples/workflow-manifest.conformance-solid-color.json'), 'utf8')) as WorkflowManifest;
  const loadSubmission = (file: string): JobSubmission => {
    const s = JSON.parse(readFileSync(join(fixtures, 'submissions', file), 'utf8')) as JobSubmission;
    // Fresh request_id per run so the suite is repeatable against a long-lived engine.
    return { ...s, request_id: randomUUID() };
  };
  const timeoutMs = (opts.timeoutS ?? 60) * 1000;

  async function call(method: string, path: string, body?: unknown, extra: { auth?: boolean; headers?: Record<string, string>; binary?: boolean } = {}): Promise<Http> {
    const headers: Record<string, string> = { Accept: 'application/json', ...(extra.headers ?? {}) };
    if (extra.auth !== false) headers.Authorization = `Bearer ${opts.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const url = /^https?:\/\//.test(path) ? path : path.startsWith('/') ? new URL(path, base).toString() : `${base}/${path}`;
    const res = await fetch(url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000) });
    if (extra.binary) {
      const raw = Buffer.from(await res.arrayBuffer());
      return { status: res.status, body: null, headers: res.headers, raw };
    }
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // leave as text
    }
    return { status: res.status, body: parsed, headers: res.headers };
  }

  const statuses: { scenario: string; status: unknown }[] = [];
  const recordStatus = (scenario: string, status: unknown) => statuses.push({ scenario, status });

  async function submit(s: JobSubmission, scenario: string): Promise<Http> {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const res = await call('POST', 'jobs', s, { headers: { 'Idempotency-Key': `${s.request_id}:${s.attempt}` } });
      const code = (res.body as { error?: { code?: string } })?.error?.code;
      if (res.status === 429 && code === 'ENGINE_BUSY' && Date.now() < deadline) {
        await sleep(Number(res.headers.get('retry-after') ?? '1') * 1000);
        continue;
      }
      if (res.status === 200 || res.status === 202) recordStatus(scenario, res.body);
      return res;
    }
  }

  async function pollUntil(jobId: string, scenario: string, done: (s: JobStatus) => boolean, limitMs = timeoutMs): Promise<JobStatus> {
    const deadline = Date.now() + limitMs;
    for (;;) {
      const res = await call('GET', `jobs/${encodeURIComponent(jobId)}`);
      check(res.status === 200, `GET /jobs/${jobId} returned ${res.status}`);
      recordStatus(scenario, res.body);
      const s = res.body as JobStatus;
      if (done(s)) return s;
      check(Date.now() < deadline, `job ${jobId} did not reach the expected state within ${limitMs} ms (last: ${s.state})`);
      await sleep(100);
    }
  }

  const errorCode = (r: Http) => (r.body as { error?: { code?: string } })?.error?.code;
  const isErrorBody = (r: Http) => validator.validate('error-response', r.body).ok;
  const terminal = (s: JobStatus) => ['succeeded', 'failed', 'cancelled'].includes(s.state);

  let engine: EngineInfo | null = null;
  let manifest: WorkflowManifest | null = null;
  let succeededJob: JobStatus | null = null;
  let c06Submission: JobSubmission | null = null;

  const runners: Record<string, () => Promise<string>> = {
    C01: async () => {
      const r = await call('GET', 'engine', undefined, { auth: false });
      check(r.status === 401, `expected 401, got ${r.status}`);
      check(isErrorBody(r) && errorCode(r) === 'UNAUTHORIZED', 'expected error-response with code UNAUTHORIZED');
      return '401 UNAUTHORIZED';
    },
    C02: async () => {
      const r = await call('GET', 'engine');
      check(r.status === 200, `expected 200, got ${r.status}`);
      const v = validator.validate('engine-info', r.body);
      check(v.ok, `engine-info invalid: ${JSON.stringify(v.violations.slice(0, 3))}`);
      engine = r.body as EngineInfo;
      check(engine.contract_versions.includes('1.0'), 'contract_versions must include 1.0');
      check(engine.capabilities.output_transfer.includes('http_download'), 'output_transfer must include http_download');
      check(engine.conformance_mode === true, 'engine must run with conformance_mode=true');
      return `${engine.engine_id} ${engine.engine_version} (${engine.engine_kind})`;
    },
    C03: async () => {
      const r = await call('GET', 'workflows');
      check(r.status === 200 && validator.validate('workflow-list', r.body).ok, 'workflow-list invalid');
      const entry = (r.body as { workflows: { workflow_key: string; version: string; manifest_sha256: string }[] }).workflows.find(
        (w) => w.workflow_key === scenarios.workflow.key && w.version === scenarios.workflow.version,
      );
      check(entry, `${scenarios.workflow.key}@${scenarios.workflow.version} not listed`);
      const m = await call('GET', `workflows/${scenarios.workflow.key}/versions/${scenarios.workflow.version}`);
      check(m.status === 200, `manifest fetch returned ${m.status}`);
      manifest = m.body as WorkflowManifest;
      const sha = manifestSha256(manifest as unknown as Record<string, unknown>);
      check(sha === entry.manifest_sha256, `manifest_sha256 mismatch: listed ${entry.manifest_sha256}, computed ${sha}`);
      return `manifest_sha256 ${sha.slice(0, 12)}… verified`;
    },
    C04: async () => {
      check(manifest, 'C03 must pass first');
      const v = validator.validate('workflow-manifest', manifest);
      check(v.ok, `manifest invalid: ${JSON.stringify(v.violations.slice(0, 3))}`);
      check(canonicalize(manifest.input_schema) === canonicalize(normative.input_schema), 'input_schema differs from the normative example');
      return 'schema-valid; input_schema matches normative example';
    },
    C05: async () => {
      const r = await call('GET', 'workflows/does_not_exist/versions/1.0.0');
      check(r.status === 404 && isErrorBody(r), `expected 404 error-response, got ${r.status}`);
      check(['WORKFLOW_NOT_FOUND', 'WORKFLOW_VERSION_NOT_FOUND'].includes(errorCode(r) ?? ''), `unexpected code ${errorCode(r)}`);
      return `404 ${errorCode(r)}`;
    },
    C06: async () => {
      c06Submission = loadSubmission('valid-solid-color.json');
      const r = await submit(c06Submission, 'C06');
      check(r.status === 202, `expected 202, got ${r.status} ${JSON.stringify(r.body)}`);
      const accepted = r.body as JobStatus;
      check(['queued', 'running'].includes(accepted.state), `accepted job state ${accepted.state}`);
      const done = await pollUntil(accepted.job_id, 'C06', terminal);
      check(done.state === 'succeeded', `job ended ${done.state}: ${JSON.stringify(done.error)}`);
      check(done.outputs?.length === c06Submission.output.count, `expected ${c06Submission.output.count} outputs, got ${done.outputs?.length}`);
      const p = c06Submission.parameters as { width: number; height: number };
      for (const o of done.outputs!) {
        check(o.download_url, `output ${o.output_id} has no download_url`);
        const d = await call('GET', o.download_url!, undefined, { binary: true });
        check(d.status === 200 && d.raw, `download ${o.output_id} returned ${d.status}`);
        check(sha256Hex(d.raw) === o.sha256, `sha256 mismatch for ${o.output_id}`);
        check(d.raw.length === o.bytes, `bytes mismatch for ${o.output_id}`);
        check(sniffMime(d.raw) === 'image/png' && o.mime_type === 'image/png', `${o.output_id} is not image/png`);
        const size = readPngSize(d.raw);
        check(size?.width === p.width && size?.height === p.height, `${o.output_id} is ${size?.width}x${size?.height}, expected ${p.width}x${p.height}`);
      }
      succeededJob = done;
      return `${done.outputs!.length} outputs downloaded and verified`;
    },
    C07: async () => {
      check(c06Submission && succeededJob, 'C06 must pass first');
      const r = await submit(c06Submission, 'C07');
      check([200, 202].includes(r.status), `expected 200/202, got ${r.status}`);
      check((r.body as JobStatus).job_id === succeededJob.job_id, 'replay returned a different job_id');
      return `replay → same job ${succeededJob.job_id}`;
    },
    C08: async () => {
      check(c06Submission, 'C06 must pass first');
      const changed = { ...c06Submission, parameters: { ...c06Submission.parameters, color: '#000000' } };
      const r = await call('POST', 'jobs', changed, { headers: { 'Idempotency-Key': `${changed.request_id}:${changed.attempt}` } });
      check(r.status === 409 && errorCode(r) === 'IDEMPOTENCY_CONFLICT', `expected 409 IDEMPOTENCY_CONFLICT, got ${r.status} ${errorCode(r)}`);
      return '409 IDEMPOTENCY_CONFLICT';
    },
    C09: async () => {
      check(c06Submission && succeededJob, 'C06 must pass first');
      const next = { ...c06Submission, attempt: c06Submission.attempt + 1 };
      const r = await submit(next, 'C09');
      check(r.status === 202, `expected 202, got ${r.status}`);
      const job = r.body as JobStatus;
      check(job.job_id !== succeededJob.job_id, 'attempt+1 must create a new job');
      await pollUntil(job.job_id, 'C09', terminal);
      return `new job ${job.job_id}`;
    },
    C10: async () => {
      const r = await submit(loadSubmission('invalid-parameters.json'), 'C10');
      const e = (r.body as { error?: { class?: string; retryable?: boolean } }).error;
      check(r.status === 422 && errorCode(r) === 'PARAMETER_VALIDATION_FAILED', `expected 422 PARAMETER_VALIDATION_FAILED, got ${r.status} ${errorCode(r)}`);
      check(e?.class === 'invalid_input' && e.retryable === false, 'expected class invalid_input, retryable false');
      return '422 PARAMETER_VALIDATION_FAILED';
    },
    C11: async () => {
      const r = await submit(loadSubmission('invalid-contract-version.json'), 'C11');
      check(r.status === 400 && ['UNSUPPORTED_CONTRACT_VERSION', 'INVALID_REQUEST'].includes(errorCode(r) ?? ''), `expected 400, got ${r.status} ${errorCode(r)}`);
      return `400 ${errorCode(r)}`;
    },
    C12: async () => {
      const r = await submit(loadSubmission('slow-solid-color.json'), 'C12');
      check(r.status === 202, `expected 202, got ${r.status}`);
      const job = r.body as JobStatus;
      await pollUntil(job.job_id, 'C12', (s) => s.state === 'running' || terminal(s), 15_000);
      const c = await call('POST', `jobs/${job.job_id}/cancel`, {});
      check(c.status === 200, `cancel returned ${c.status}`);
      recordStatus('C12', c.body);
      check(['cancelling', 'cancelled'].includes((c.body as JobStatus).state), `cancel returned state ${(c.body as JobStatus).state}`);
      const done = await pollUntil(job.job_id, 'C12', terminal, 30_000);
      check(done.state === 'cancelled', `job ended ${done.state}`);
      check(!done.outputs || done.outputs.length === 0, 'cancelled job must have no outputs');
      check(done.error?.code === 'CANCELLED', `expected error.code CANCELLED, got ${done.error?.code}`);
      return 'cancelled while running';
    },
    C13: async () => {
      check(succeededJob, 'C06 must pass first');
      const c = await call('POST', `jobs/${succeededJob.job_id}/cancel`, {});
      check(c.status === 200 && (c.body as JobStatus).state === 'succeeded', `expected 200 succeeded, got ${c.status} ${(c.body as JobStatus)?.state}`);
      recordStatus('C13', c.body);
      return 'terminal job unchanged';
    },
    C14: async () => {
      const r = await call('GET', 'jobs/does-not-exist');
      check(r.status === 404 && errorCode(r) === 'JOB_NOT_FOUND', `expected 404 JOB_NOT_FOUND, got ${r.status} ${errorCode(r)}`);
      return '404 JOB_NOT_FOUND';
    },
    C15: async () => {
      const r = await call('GET', 'resources');
      const v = validator.validate('resource-state', r.body);
      check(r.status === 200 && v.ok, `resource state invalid: ${r.status} ${JSON.stringify(v.violations.slice(0, 3))}`);
      return `status ${(r.body as { status: string }).status}`;
    },
    C16: async () => {
      check(statuses.length > 0, 'no job statuses were collected');
      const bad = statuses.filter((s) => !validator.validate('job-status', s.status).ok);
      check(bad.length === 0, `${bad.length} status payloads invalid (first from ${bad[0]?.scenario}): ${JSON.stringify(validator.validate('job-status', bad[0]?.status).violations.slice(0, 3))}`);
      return `${statuses.length} status payloads valid`;
    },
  };

  const started = new Date();
  const results: ScenarioResult[] = [];
  for (const s of scenarios.scenarios) {
    const fn = runners[s.id];
    if (!fn) {
      results.push({ id: s.id, name: s.name, passed: false, detail: 'no runner implemented' });
      continue;
    }
    try {
      results.push({ id: s.id, name: s.name, passed: true, detail: await fn() });
    } catch (e) {
      results.push({ id: s.id, name: s.name, passed: false, detail: (e as Error).message });
    }
  }
  const info = engine as EngineInfo | null;
  return {
    engine_url: base,
    engine: info ? { engine_id: info.engine_id, engine_version: info.engine_version, engine_kind: info.engine_kind } : null,
    started_at: started.toISOString(),
    finished_at: new Date().toISOString(),
    passed: results.every((r) => r.passed),
    results,
    note:
      info?.engine_kind === 'contract_mock'
        ? 'Engine is the contract test adapter: this run validates the contract fixtures and runner only, NOT a real visual engine.'
        : 'Conformance is necessary but not sufficient for production; real workflows still need end-to-end validation on the workstation.',
  };
}
