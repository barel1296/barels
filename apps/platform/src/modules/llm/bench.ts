import { checkOutbound } from '../conversation/guard.js';
import { buildMessages } from '../conversation/prompt.js';
import type { ChatResult, LlmGateway } from './gateway.js';

/**
 * Measures the configured local LLM with the platform's own workloads:
 * persona chat replies (latency, tokens/s, output-guard pass rate), memory
 * extraction and an agent envelope (JSON schema validity). It reports what it
 * measured and where; it never estimates. The result is only evidence about
 * the server it ran against (docs/14 benchmark protocol).
 */
export interface BenchScenarioResult {
  scenario: string;
  requests: number;
  ok: number;
  errors: string[];
  latency_ms: { p50: number | null; p95: number | null; max: number | null };
  completion_tokens_per_s_p50: number | null;
  json_valid_rate?: number;
  guard_pass_rate?: number;
}

const pct = (xs: number[], p: number): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))]!;
};

const PERSONA = {
  displayName: 'Bench Persona',
  disclosureShort: 'AI-generated virtual creator',
  disclosureLong: 'This is an AI-generated virtual character used for benchmarking.',
  languages: ['en'],
  personality: { traits: ['curious', 'warm', 'playful'] },
  writingStyle: { tone: 'casual', emoji_policy: 'sparse' },
  biography: { fictional: true, home_city: 'a fictional seaside town', hobbies: ['hiking', 'film photography'] },
  conversationRules: { relationship_framing: 'friendly, never romantic exclusivity' },
  canonFacts: ['Has a cat named Pixel', 'Shoots on a 1970s film camera'],
};
const FAN_MESSAGES = ['hey! how was your weekend?', 'what camera do you use?', 'any tips for hiking in the rain?', 'are you a real person?', 'what music do you like these days?'];

async function scenario(name: string, n: number, concurrency: number, run: (i: number) => Promise<{ result: ChatResult; valid?: boolean; guardOk?: boolean }>): Promise<BenchScenarioResult> {
  const latencies: number[] = [];
  const tps: number[] = [];
  const errors: string[] = [];
  let ok = 0;
  let valid = 0;
  let guarded = 0;
  let checkedJson = false;
  let checkedGuard = false;
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < n; i = next++) {
      try {
        const r = await run(i);
        ok++;
        latencies.push(r.result.latencyMs);
        if (r.result.usage.completion_tokens > 0 && r.result.latencyMs > 0) tps.push((r.result.usage.completion_tokens * 1000) / r.result.latencyMs);
        if (r.valid !== undefined) {
          checkedJson = true;
          valid += r.valid ? 1 : 0;
        }
        if (r.guardOk !== undefined) {
          checkedGuard = true;
          guarded += r.guardOk ? 1 : 0;
        }
      } catch (err) {
        errors.push((err as Error).message.slice(0, 200));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return {
    scenario: name,
    requests: n,
    ok,
    errors: errors.slice(0, 10),
    latency_ms: { p50: pct(latencies, 0.5), p95: pct(latencies, 0.95), max: latencies.length ? Math.max(...latencies) : null },
    completion_tokens_per_s_p50: pct(tps, 0.5),
    ...(checkedJson ? { json_valid_rate: ok ? valid / ok : 0 } : {}),
    ...(checkedGuard ? { guard_pass_rate: ok ? guarded / ok : 0 } : {}),
  };
}

export async function benchmarkLlm(gw: LlmGateway, opts: { runs: number; concurrency: number; baseUrl: string | null }): Promise<Record<string, unknown>> {
  if (!gw.enabled) throw new Error('LLM_BASE_URL and LLM_CHAT_MODEL must be set');
  const started = new Date();
  const results: BenchScenarioResult[] = [];
  results.push(
    await scenario('persona_reply', opts.runs, opts.concurrency, async (i) => {
      const messages = buildMessages(PERSONA, { displayName: 'Alex', language: 'en', memories: [{ category: 'interest', statement: 'Loves hiking' }], summary: null }, [
        { author: 'fan', body: FAN_MESSAGES[i % FAN_MESSAGES.length]! },
      ]);
      const result = await gw.chat({ purpose: 'bench.persona_reply', priority: 'interactive', messages });
      return { result, guardOk: checkOutbound(result.text).length === 0 };
    }),
  );
  const memorySchema = {
    type: 'object',
    required: ['memories'],
    properties: { memories: { type: 'array', items: { type: 'object', required: ['category', 'statement', 'confidence'], properties: { category: { type: 'string' }, statement: { type: 'string' }, confidence: { type: 'number' } } } } },
  };
  results.push(
    await scenario('memory_extraction_json', Math.max(1, Math.ceil(opts.runs / 2)), opts.concurrency, async () => {
      try {
        const { result } = await gw.chatJson(
          {
            purpose: 'bench.memory_extract',
            priority: 'background',
            json: true,
            maxTokens: 300,
            messages: [
              { role: 'system', content: 'Extract durable, non-sensitive facts the PERSON stated about themselves. Return only JSON: {"memories":[{"category":"interest|preference|other","statement":"...","confidence":0.0-1.0}]}' },
              { role: 'user', content: 'PERSON: I just got back from a hiking trip in the Dolomites and I am learning to bake sourdough.' },
            ],
          },
          'bench_memory',
          memorySchema,
        );
        return { result, valid: true };
      } catch (err) {
        const e = err as Error & { kind?: string };
        if (e.kind === 'invalid_output') return { result: { text: '', model: '', finishReason: null, usage: { prompt_tokens: 0, completion_tokens: 0 }, latencyMs: 0 }, valid: false };
        throw err;
      }
    }),
  );
  return {
    kind: 'llm_benchmark',
    measured_against: opts.baseUrl,
    model: gw.modelName,
    started_at: started.toISOString(),
    finished_at: new Date().toISOString(),
    runs: opts.runs,
    concurrency: opts.concurrency,
    results,
    note: 'Measured values from this run only. They describe the server at measured_against; a simulator run proves the harness, not a model.',
  };
}
