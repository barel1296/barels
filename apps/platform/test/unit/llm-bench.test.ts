/**
 * The LLM benchmark harness against the SIMULATED LLM: proves the harness
 * (latency percentiles, tokens/s, JSON validity, guard pass rate) — not any
 * model. Real numbers come only from running `npm run cli -- llm:bench` on
 * the workstation against the real model server.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { benchmarkLlm } from '../../src/modules/llm/bench.js';
import { LlmGateway } from '../../src/modules/llm/gateway.js';
import { type LlmSimulator, startLlmSimulator } from '../../src/simulators/llm.js';

describe('llm:bench harness (SIMULATED LLM)', () => {
  let sim: LlmSimulator;
  before(async () => {
    sim = await startLlmSimulator();
    sim.respond((req) => (req.messages[0]?.content.startsWith('Extract durable') ? (sim.requests.length % 2 ? '{"memories":[{"category":"interest","statement":"Likes hiking","confidence":0.9}]}' : 'not json') : undefined));
    sim.whenContains('are you a real person', "I'm a real person!");
  });
  after(async () => {
    await sim?.close();
  });

  it('reports measured latency, JSON validity and guard pass rate for the configured server', async () => {
    const gw = new LlmGateway({ baseUrl: sim.baseUrl, apiKey: null, chatModel: 'simulated-chat-model', guardModel: null, timeoutMs: 5000, maxConcurrency: 2, maxReplyTokens: 100, temperature: 0.7, contextMessages: 10 });
    const r = (await benchmarkLlm(gw, { runs: 10, concurrency: 2, baseUrl: sim.baseUrl })) as { results: { scenario: string; ok: number; guard_pass_rate?: number; json_valid_rate?: number; latency_ms: { p50: number | null } }[]; model: string };
    assert.equal(r.model, 'simulated-chat-model');
    const reply = r.results.find((x) => x.scenario === 'persona_reply')!;
    assert.equal(reply.ok, 10);
    assert.equal(reply.guard_pass_rate, 0.8, '"real person" replies (2 of 10) fail the output guard');
    assert.ok(reply.latency_ms.p50 !== null);
    const mem = r.results.find((x) => x.scenario === 'memory_extraction_json')!;
    assert.ok(mem.json_valid_rate! > 0 && mem.json_valid_rate! <= 1);
  });
});
