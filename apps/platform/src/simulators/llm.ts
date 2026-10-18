/**
 * SIMULATED local LLM server (OpenAI-compatible subset) for automated tests and
 * offline development. It is NOT a language model: replies are scripted or
 * deterministic echoes. Tests that use it are labelled "simulated LLM"; they
 * prove the platform's integration logic, never model quality.
 */
import Fastify, { type FastifyInstance } from 'fastify';

export interface SimChatRequest {
  model: string;
  messages: { role: string; content: string }[];
  max_tokens?: number;
  temperature?: number;
  response_format?: { type: string };
}

export type Responder = (req: SimChatRequest) => string | undefined;

export interface LlmSimulator {
  app: FastifyInstance;
  baseUrl: string; // …/v1
  requests: SimChatRequest[];
  /** Responders are tried newest first; the first that returns a string wins. */
  respond(r: Responder): void;
  /** Reply with `text` when the conversation contains `substring` (newest rule first). */
  whenContains(substring: string, text: string): void;
  failNext(status: number, times?: number): void;
  delayMs: number;
  reset(): void;
  close(): Promise<void>;
}

const lastUser = (req: SimChatRequest) => [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';

export async function startLlmSimulator(opts: { model?: string; port?: number } = {}): Promise<LlmSimulator> {
  const model = opts.model ?? 'simulated-chat-model';
  const app = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024 });
  let responders: Responder[] = [];
  let failures: number[] = [];
  const sim = {
    app,
    baseUrl: '',
    requests: [] as SimChatRequest[],
    delayMs: 0,
    respond(r: Responder) {
      responders.unshift(r);
    },
    whenContains(substring: string, text: string) {
      responders.unshift((req) => (req.messages.some((m) => m.content.includes(substring)) ? text : undefined));
    },
    failNext(status: number, times = 1) {
      for (let i = 0; i < times; i++) failures.push(status);
    },
    reset() {
      responders = [];
      failures = [];
      sim.requests.length = 0;
      sim.delayMs = 0;
    },
    close: () => app.close(),
  };

  app.get('/v1/models', async () => ({ object: 'list', data: [{ id: model, object: 'model', owned_by: 'simulator' }] }));

  app.post('/v1/chat/completions', async (req, reply) => {
    const body = req.body as SimChatRequest;
    sim.requests.push(body);
    if (sim.delayMs) await new Promise((r) => setTimeout(r, sim.delayMs));
    const fail = failures.shift();
    if (fail) return reply.status(fail).send({ error: { message: `simulated failure ${fail}` } });
    let text: string | undefined;
    for (const r of responders) {
      text = r(body);
      if (text !== undefined) break;
    }
    if (text === undefined) {
      text = body.response_format?.type === 'json_object' ? '{}' : `Simulated reply to: ${lastUser(body).slice(0, 120)}`;
    }
    const promptTokens = Math.ceil(body.messages.reduce((n, m) => n + m.content.length, 0) / 4);
    return {
      id: `chatcmpl-sim-${sim.requests.length}`,
      object: 'chat.completion',
      model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: promptTokens, completion_tokens: Math.ceil(text.length / 4), total_tokens: promptTokens + Math.ceil(text.length / 4) },
    };
  });

  // Control plane for scripted integration runs (CLI): POST /__sim__/rules {contains, reply}
  app.post('/__sim__/rules', async (req) => {
    const b = req.body as { contains: string; reply: string };
    sim.whenContains(b.contains, b.reply);
    return { ok: true };
  });

  const address = await app.listen({ host: '127.0.0.1', port: opts.port ?? 0 });
  sim.baseUrl = `${address}/v1`;
  return sim;
}
