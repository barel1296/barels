import type { LlmConfig } from '../../config.js';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';

/**
 * Gateway to the ONE shared local language model, served by any
 * OpenAI-compatible server (llama.cpp `llama-server`, vLLM, Ollama, LM Studio).
 * Every influencer uses the same model; personality, rules, memory and history
 * are supplied per request. The model name comes only from configuration.
 *
 * The gateway is the P1 chat lane of the GPU plan: a bounded number of
 * concurrent requests, interactive requests (fan replies) ahead of background
 * ones (agents, memory extraction).
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type LlmPriority = 'interactive' | 'background';

export interface ChatRequest {
  messages: ChatMessage[];
  purpose: string; // for usage accounting, e.g. 'conversation.reply'
  priority?: LlmPriority;
  maxTokens?: number;
  temperature?: number;
  /** Ask the server for JSON output (servers that ignore it still get validated output via chatJson). */
  json?: boolean;
  model?: 'chat' | 'guard';
}

export interface ChatResult {
  text: string;
  model: string;
  finishReason: string | null;
  usage: { prompt_tokens: number; completion_tokens: number };
  latencyMs: number;
}

export class LlmError extends Error {
  constructor(
    readonly kind: 'disabled' | 'timeout' | 'network' | 'http' | 'invalid_response' | 'invalid_output',
    message: string,
    readonly retryable: boolean,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

class Lane {
  private active = 0;
  private readonly waiting: { priority: LlmPriority; resolve: () => void }[] = [];

  constructor(private readonly limit: number) {}

  get inFlight(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiting.length;
  }

  async acquire(priority: LlmPriority): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++;
      return () => this.release();
    }
    await new Promise<void>((resolve) => {
      // Interactive requests jump ahead of background ones, FIFO within a class.
      const entry = { priority, resolve };
      if (priority === 'interactive') {
        const firstBackground = this.waiting.findIndex((w) => w.priority === 'background');
        if (firstBackground < 0) this.waiting.push(entry);
        else this.waiting.splice(firstBackground, 0, entry);
      } else {
        this.waiting.push(entry);
      }
    });
    this.active++;
    return () => this.release();
  }

  private release(): void {
    this.active--;
    const next = this.waiting.shift();
    if (next) next.resolve();
  }
}

export class LlmGateway {
  private readonly lane: Lane;
  private readonly latencies: number[] = [];
  private total = 0;
  private errors = 0;
  private readonly ajv = new Ajv2020({ allErrors: true, strict: false });
  private readonly validators = new Map<string, ValidateFunction>();

  constructor(private readonly cfg: LlmConfig) {
    this.lane = new Lane(cfg.maxConcurrency);
  }

  get enabled(): boolean {
    return Boolean(this.cfg.baseUrl && this.cfg.chatModel);
  }

  get modelName(): string | null {
    return this.cfg.chatModel;
  }

  stats(): { inFlight: number; queued: number; total: number; errors: number; p95Ms: number | null } {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]! : null;
    return { inFlight: this.lane.inFlight, queued: this.lane.queued, total: this.total, errors: this.errors, p95Ms: p95 };
  }

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', ...(this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {}) };
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    if (!this.enabled) throw new LlmError('disabled', 'local LLM is not configured (LLM_BASE_URL / LLM_CHAT_MODEL)', false);
    const model = req.model === 'guard' && this.cfg.guardModel ? this.cfg.guardModel : this.cfg.chatModel!;
    const release = await this.lane.acquire(req.priority ?? 'background');
    const started = Date.now();
    this.total++;
    try {
      let res: Response;
      try {
        res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({
            model,
            messages: req.messages,
            max_tokens: req.maxTokens ?? this.cfg.maxReplyTokens,
            temperature: req.temperature ?? this.cfg.temperature,
            stream: false,
            ...(req.json ? { response_format: { type: 'json_object' } } : {}),
          }),
          signal: AbortSignal.timeout(this.cfg.timeoutMs),
        });
      } catch (err) {
        const e = err as Error;
        throw e.name === 'TimeoutError' || e.name === 'AbortError'
          ? new LlmError('timeout', `LLM request timed out after ${this.cfg.timeoutMs} ms`, true)
          : new LlmError('network', `LLM server unreachable: ${e.message}`, true);
      }
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, 500);
        throw new LlmError('http', `LLM server returned HTTP ${res.status}: ${body}`, res.status >= 500 || res.status === 429, res.status);
      }
      const body = (await res.json().catch(() => null)) as {
        model?: string;
        choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      } | null;
      const text = body?.choices?.[0]?.message?.content;
      if (typeof text !== 'string') throw new LlmError('invalid_response', 'LLM response has no choices[0].message.content', true);
      const latencyMs = Date.now() - started;
      this.latencies.push(latencyMs);
      if (this.latencies.length > 200) this.latencies.shift();
      return {
        text,
        model: body?.model ?? model,
        finishReason: body?.choices?.[0]?.finish_reason ?? null,
        usage: { prompt_tokens: body?.usage?.prompt_tokens ?? 0, completion_tokens: body?.usage?.completion_tokens ?? 0 },
        latencyMs,
      };
    } catch (err) {
      this.errors++;
      throw err;
    } finally {
      release();
    }
  }

  /**
   * Structured output: asks for JSON, extracts it (tolerating code fences),
   * validates against `schema`, and retries once with the validation errors.
   */
  async chatJson<T>(req: ChatRequest, schemaName: string, schema: Record<string, unknown>): Promise<{ value: T; result: ChatResult }> {
    let validate = this.validators.get(schemaName);
    if (!validate) {
      validate = this.ajv.compile(schema);
      this.validators.set(schemaName, validate);
    }
    let messages = req.messages;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const result = await this.chat({ ...req, messages, json: true, temperature: req.temperature ?? 0.2 });
      const parsed = extractJson(result.text);
      if (parsed !== undefined && validate(parsed)) return { value: parsed as T, result };
      const problem = parsed === undefined ? 'The reply was not valid JSON.' : `The JSON did not match the schema: ${this.ajv.errorsText(validate.errors)}`;
      if (attempt === 2) throw new LlmError('invalid_output', `${schemaName}: ${problem}`, false);
      messages = [...req.messages, { role: 'assistant', content: result.text }, { role: 'user', content: `${problem} Reply again with only the corrected JSON object.` }];
    }
    throw new LlmError('invalid_output', schemaName, false);
  }

  async health(): Promise<{ status: 'ok' | 'degraded' | 'down' | 'disabled'; detail: Record<string, unknown> | string }> {
    if (!this.enabled) return { status: 'disabled', detail: 'LLM_BASE_URL / LLM_CHAT_MODEL not set' };
    try {
      const res = await fetch(`${this.cfg.baseUrl}/models`, { headers: this.headers(), signal: AbortSignal.timeout(5000) });
      if (!res.ok) return { status: 'down', detail: { http_status: res.status } };
      const body = (await res.json().catch(() => ({}))) as { data?: { id?: string }[] };
      const ids = (body.data ?? []).map((m) => m.id).filter(Boolean) as string[];
      const loaded = ids.length === 0 || ids.includes(this.cfg.chatModel!);
      return { status: loaded ? 'ok' : 'degraded', detail: { configured_model: this.cfg.chatModel, served_models: ids, ...this.stats() } };
    } catch (err) {
      return { status: 'down', detail: (err as Error).message };
    }
  }
}

/** Extracts a JSON object from model output (plain, fenced, or with surrounding prose). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [text.trim(), fenced?.[1]?.trim()];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const c of candidates) {
    if (!c) continue;
    try {
      return JSON.parse(c);
    } catch {
      // try next
    }
  }
  return undefined;
}
