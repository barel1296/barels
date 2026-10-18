import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractJson } from '../../src/modules/llm/gateway.js';
import { parseNvidiaSmiCsv } from '../../src/modules/monitoring.js';
import { matches } from '../../src/modules/outbox.js';
import { chainHash } from '../../src/modules/audit-seal.js';
import { backoffMs } from '../../src/modules/jobs-queue.js';

describe('nvidia-smi parsing', () => {
  it('parses CSV rows and tolerates N/A fields', () => {
    const out = '0, NVIDIA GeForce RTX 5090 Laptop GPU, 37, 10240, 24463, 61, 95.12\n1, Other GPU, [N/A], 100, 8192, 40, [Not Supported]\n';
    const s = parseNvidiaSmiCsv(out);
    assert.equal(s.length, 2);
    assert.deepEqual(s[0], { gpu_index: 0, gpu_name: 'NVIDIA GeForce RTX 5090 Laptop GPU', util_pct: 37, vram_used_mb: 10240, vram_total_mb: 24463, temp_c: 61, power_w: 95.12 });
    assert.equal(s[1]!.util_pct, null);
    assert.equal(s[1]!.power_w, null);
  });
});

describe('LLM output handling', () => {
  it('extracts JSON from plain, fenced and prose-wrapped replies', () => {
    assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
    assert.deepEqual(extractJson('Sure!\n```json\n{"a":2}\n```'), { a: 2 });
    assert.deepEqual(extractJson('Here you go: {"a":3} hope it helps'), { a: 3 });
    assert.equal(extractJson('no json here'), undefined);
  });
});

describe('outbox and jobs', () => {
  it('matches exact and prefix subscriptions', () => {
    assert.ok(matches('monetization.payment_succeeded', 'monetization.payment_succeeded'));
    assert.ok(matches('monetization.*', 'monetization.entitlement_granted'));
    assert.ok(!matches('monetization.*', 'identity.persona_activated'));
  });
  it('backs off exponentially with a 10 minute ceiling', () => {
    for (let a = 1; a <= 20; a++) {
      const d = backoffMs(a);
      assert.ok(d >= Math.min(600_000, 2000 * 2 ** (a - 1)) / 2 && d <= 600_000);
    }
  });
  it('chains audit seals', () => {
    const r = Buffer.alloc(32, 1);
    assert.notDeepEqual(chainHash(null, r), chainHash(Buffer.alloc(32, 2), r));
  });
});
