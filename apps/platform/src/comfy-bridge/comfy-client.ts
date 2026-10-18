/**
 * Client for the ComfyUI HTTP API of an EXISTING ComfyUI installation. The
 * bridge only uses the public HTTP endpoints (no file-system access to the
 * ComfyUI folder): it never installs, modifies or removes models, custom nodes,
 * workflows or settings. Reference images are uploaded through /upload/image
 * into a dedicated input subfolder.
 */
export class ComfyError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly body: unknown = null,
    readonly network = false,
  ) {
    super(message);
    this.name = 'ComfyError';
  }
}

export interface ComfyNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
}
export type ComfyPrompt = Record<string, ComfyNode>;

export interface SystemStats {
  system?: { os?: string; comfyui_version?: string; python_version?: string; pytorch_version?: string; embedded_python?: boolean; ram_total?: number; ram_free?: number };
  devices?: { name: string; type: string; index?: number; vram_total: number; vram_free: number; torch_vram_total?: number; torch_vram_free?: number }[];
}

export interface HistoryEntry {
  prompt?: unknown[];
  outputs?: Record<string, Record<string, { filename: string; subfolder: string; type: string; format?: string }[] | unknown>>;
  status?: { status_str?: 'success' | 'error'; completed?: boolean; messages?: [string, Record<string, unknown>][] };
}

export class ComfyClient {
  constructor(
    readonly baseUrl: string,
    private readonly timeoutMs = 15_000,
  ) {}

  private async req(method: string, path: string, body?: unknown, raw?: FormData): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        method,
        ...(raw ? { body: raw } : body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new ComfyError(`ComfyUI unreachable at ${this.baseUrl}: ${(err as Error).message}`, null, null, true);
    }
  }

  private async json<T>(method: string, path: string, body?: unknown, raw?: FormData): Promise<T> {
    const res = await this.req(method, path, body, raw);
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if (!res.ok) throw new ComfyError(`ComfyUI ${method} ${path} → HTTP ${res.status}`, res.status, parsed);
    return parsed as T;
  }

  systemStats(): Promise<SystemStats> {
    return this.json('GET', '/system_stats');
  }

  /** Node class definitions (read-only); used to check that a package's node types are installed. */
  objectInfo(): Promise<Record<string, unknown>> {
    return this.json('GET', '/object_info');
  }

  queuePrompt(prompt: ComfyPrompt, clientId: string): Promise<{ prompt_id: string; number: number; node_errors?: Record<string, unknown> }> {
    return this.json('POST', '/prompt', { prompt, client_id: clientId });
  }

  queue(): Promise<{ queue_running: unknown[][]; queue_pending: unknown[][] }> {
    return this.json('GET', '/queue');
  }

  async history(promptId: string): Promise<HistoryEntry | null> {
    const h = await this.json<Record<string, HistoryEntry>>('GET', `/history/${encodeURIComponent(promptId)}`);
    return h?.[promptId] ?? null;
  }

  async view(file: { filename: string; subfolder: string; type: string }): Promise<{ bytes: Buffer; contentType: string | null }> {
    const q = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder ?? '', type: file.type ?? 'output' });
    const res = await this.req('GET', `/view?${q}`);
    if (!res.ok) throw new ComfyError(`ComfyUI /view ${file.filename} → HTTP ${res.status}`, res.status);
    return { bytes: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') };
  }

  /** Removes pending prompts (only ours: callers pass their own prompt ids). */
  async deleteFromQueue(promptIds: string[]): Promise<void> {
    await this.json('POST', '/queue', { delete: promptIds });
  }

  /** Interrupts the running prompt; callers check it is theirs first. Newer ComfyUI accepts a targeted prompt_id. */
  async interrupt(promptId: string): Promise<void> {
    await this.json('POST', '/interrupt', { prompt_id: promptId });
  }

  async uploadImage(bytes: Buffer, filename: string, subfolder: string, mime: string): Promise<{ name: string; subfolder: string; type: string }> {
    const form = new FormData();
    form.set('image', new Blob([bytes], { type: mime }), filename);
    form.set('subfolder', subfolder);
    form.set('type', 'input');
    form.set('overwrite', 'false');
    return this.json('POST', '/upload/image', undefined, form);
  }

  /** Unloads models / frees memory (GPU coordination: release before the LLM grows). */
  async free(opts: { unloadModels: boolean; freeMemory: boolean }): Promise<void> {
    await this.json('POST', '/free', { unload_models: opts.unloadModels, free_memory: opts.freeMemory });
  }
}

export function runningPromptIds(q: { queue_running: unknown[][]; queue_pending: unknown[][] }): { running: string[]; pending: string[] } {
  const id = (item: unknown[]) => String(item[1]);
  return { running: (q.queue_running ?? []).map(id), pending: (q.queue_pending ?? []).map(id) };
}
