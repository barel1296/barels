import type { ContractSchemaName, ContractValidator, Violation } from './validator.js';
import type {
  EngineInfo,
  ErrorClass,
  ErrorObject,
  JobStatus,
  JobSubmission,
  ResourceState,
  WorkflowListEntry,
  WorkflowManifest,
} from './types.js';

export type EngineCallKind = 'network' | 'timeout' | 'http' | 'protocol';

/**
 * Any failed call to a visual engine, classified per contract §8 so callers can
 * decide on retries without parsing messages.
 */
export class EngineCallError extends Error {
  readonly error: ErrorObject;

  constructor(
    readonly kind: EngineCallKind,
    error: ErrorObject,
    readonly httpStatus: number | null = null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(`${error.code}: ${error.message}`);
    this.name = 'EngineCallError';
    this.error = error;
  }

  get code(): string {
    return this.error.code;
  }

  get errorClass(): ErrorClass {
    return this.error.class;
  }

  get retryable(): boolean {
    return this.error.retryable;
  }

  /** True when the request may have taken effect on the engine (unknown outcome). */
  get ambiguous(): boolean {
    return this.kind === 'network' || this.kind === 'timeout';
  }
}

function platformError(code: string, cls: ErrorClass, message: string, retryable: boolean, details?: Record<string, unknown>): ErrorObject {
  return { code, class: cls, message, retryable, ...(details ? { details } : {}) };
}

export interface EngineClientOptions {
  baseUrl: string; // …/vec/v1
  token: string;
  validator: ContractValidator;
  timeoutMs: number;
  /** Download size cap (bytes). */
  maxDownloadBytes?: number;
}

export interface DownloadResult {
  bytes: Buffer;
  contentType: string | null;
  headerSha256: string | null;
}

/** HTTP client for the Visual Engine Contract v1. Every response is schema-validated. */
export class EngineClient {
  private readonly base: URL;

  constructor(private readonly opts: EngineClientOptions) {
    this.base = new URL(opts.baseUrl.endsWith('/') ? opts.baseUrl : `${opts.baseUrl}/`);
  }

  getEngine(): Promise<EngineInfo> {
    return this.json('GET', 'engine', undefined, 'engine-info');
  }

  async health(): Promise<boolean> {
    const body = await this.json<{ ok?: unknown }>('GET', 'health', undefined, null);
    return body.ok === true;
  }

  async listWorkflows(): Promise<WorkflowListEntry[]> {
    const body = await this.json<{ workflows: WorkflowListEntry[] }>('GET', 'workflows', undefined, 'workflow-list');
    return body.workflows;
  }

  getManifest(key: string, version: string): Promise<WorkflowManifest> {
    return this.json('GET', `workflows/${encodeURIComponent(key)}/versions/${encodeURIComponent(version)}`, undefined, 'workflow-manifest');
  }

  /** POST /jobs. `replayed` is true when the engine returned an existing job (200). */
  async submitJob(submission: JobSubmission): Promise<{ replayed: boolean; job: JobStatus }> {
    const { status, body } = await this.request('POST', 'jobs', submission, {
      'Idempotency-Key': `${submission.request_id}:${submission.attempt}`,
    });
    const job = this.check<JobStatus>(body, 'job-status');
    if (job.request_id !== submission.request_id || job.attempt !== submission.attempt) {
      throw this.protocolError('engine returned a job for a different request_id/attempt', {
        expected: { request_id: submission.request_id, attempt: submission.attempt },
        received: { request_id: job.request_id, attempt: job.attempt },
      });
    }
    return { replayed: status === 200, job };
  }

  getJob(jobId: string): Promise<JobStatus> {
    return this.json('GET', `jobs/${encodeURIComponent(jobId)}`, undefined, 'job-status');
  }

  cancelJob(jobId: string): Promise<JobStatus> {
    return this.json('POST', `jobs/${encodeURIComponent(jobId)}/cancel`, {}, 'job-status');
  }

  getResources(): Promise<ResourceState> {
    return this.json('GET', 'resources', undefined, 'resource-state');
  }

  releaseResources(scope: 'idle_models' | 'all_models', reason: string): Promise<{ released: boolean; vram_in_use_mb?: number | null }> {
    return this.json('POST', 'resources/release', { scope, reason }, 'release-response');
  }

  /**
   * Downloads an output. Relative URLs resolve against the engine base URL.
   * Absolute URLs must be same-origin: the bearer token is never sent elsewhere.
   */
  async download(downloadUrl: string): Promise<DownloadResult> {
    const url = this.resolve(downloadUrl);
    const res = await this.fetchWithTimeout(url, { method: 'GET', headers: this.headers() }, this.opts.timeoutMs * 6);
    if (!res.ok) throw await this.httpError(res);
    const cap = this.opts.maxDownloadBytes ?? 512 * 1024 * 1024;
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > cap) throw new EngineCallError('protocol', platformError('OUTPUT_VERIFICATION_FAILED', 'transient', `output exceeds ${cap} bytes`, true));
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > cap) throw new EngineCallError('protocol', platformError('OUTPUT_VERIFICATION_FAILED', 'transient', `output exceeds ${cap} bytes`, true));
    return { bytes, contentType: res.headers.get('content-type'), headerSha256: res.headers.get('x-content-sha256') };
  }

  resolve(pathOrUrl: string): URL {
    // Absolute URLs stay as they are; "/x" is origin-relative; "x" is base-relative.
    const url = new URL(pathOrUrl, this.base);
    if (url.origin !== this.base.origin) {
      throw this.protocolError(`refusing cross-origin engine URL ${url.origin}`, { url: url.toString() });
    }
    return url;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.opts.token}`, Accept: 'application/json', ...extra };
  }

  private async json<T>(method: string, path: string, body: unknown, schema: ContractSchemaName | null): Promise<T> {
    const res = await this.request(method, path, body);
    return schema ? this.check<T>(res.body, schema) : (res.body as T);
  }

  private check<T>(body: unknown, schema: ContractSchemaName): T {
    const result = this.opts.validator.validate(schema, body);
    if (!result.ok) throw this.protocolError(`response does not match ${schema} schema`, { violations: result.violations.slice(0, 20) });
    return body as T;
  }

  private protocolError(message: string, details?: Record<string, unknown> | { violations: Violation[] }): EngineCallError {
    return new EngineCallError('protocol', platformError('ENGINE_PROTOCOL_ERROR', 'permanent', message, false, details));
  }

  private async request(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
    const url = new URL(path, this.base);
    const headers = this.headers(extraHeaders);
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await this.fetchWithTimeout(
      url,
      { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) },
      this.opts.timeoutMs,
    );
    if (!res.ok) throw await this.httpError(res);
    const text = await res.text();
    try {
      return { status: res.status, body: text ? JSON.parse(text) : null };
    } catch {
      throw this.protocolError(`non-JSON response from ${method} ${path}`);
    }
  }

  private async fetchWithTimeout(url: URL, init: RequestInit, timeoutMs: number): Promise<Response> {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    } catch (err) {
      const e = err as Error;
      if (e.name === 'TimeoutError' || e.name === 'AbortError') {
        throw new EngineCallError('timeout', platformError('ENGINE_CALL_TIMEOUT', 'transient', `engine call timed out after ${timeoutMs} ms`, true));
      }
      throw new EngineCallError('network', platformError('ENGINE_UNREACHABLE', 'transient', `engine unreachable: ${e.message}`, true));
    }
  }

  private async httpError(res: Response): Promise<EngineCallError> {
    const retryAfterHeader = res.headers.get('retry-after');
    const retryAfterMs = retryAfterHeader && /^\d+$/.test(retryAfterHeader) ? Number(retryAfterHeader) * 1000 : null;
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    if (parsed && this.opts.validator.validate('error-response', parsed).ok) {
      const error = (parsed as { error: ErrorObject }).error;
      return new EngineCallError('http', error, res.status, error.retry_after_ms ?? retryAfterMs);
    }
    // Non-conforming error body: classify by status.
    const transient = res.status >= 500 || res.status === 429;
    return new EngineCallError(
      'http',
      platformError(
        transient ? 'INTERNAL' : 'ENGINE_PROTOCOL_ERROR',
        transient ? 'transient' : 'permanent',
        `engine returned HTTP ${res.status} without a contract error body`,
        transient,
      ),
      res.status,
      retryAfterMs,
    );
  }
}
