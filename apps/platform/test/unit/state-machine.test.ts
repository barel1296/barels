import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { paths } from '../../src/config.js';
import { type JobState, TERMINAL_STATES, TRANSITIONS, canTransition, retryDelayMs } from '../../src/modules/visual/state-machine.js';

describe('platform visual job state machine', () => {
  it('terminal states have no exits', () => {
    for (const s of TERMINAL_STATES) assert.deepEqual(TRANSITIONS[s], []);
  });
  it('every state is reachable from queued', () => {
    const seen = new Set<JobState>(['queued']);
    const stack: JobState[] = ['queued'];
    while (stack.length) for (const n of TRANSITIONS[stack.pop()!]) if (!seen.has(n)) (seen.add(n), stack.push(n));
    assert.deepEqual([...seen].sort(), Object.keys(TRANSITIONS).sort());
  });
  it('matches the normative diagram in contracts/visual-engine/README.md §6.2 exactly', () => {
    const readme = readFileSync(resolve(paths.contractDir, 'README.md'), 'utf8');
    const section = readme.slice(readme.indexOf('### 6.2'), readme.indexOf('## 7.'));
    const edges = new Set<string>();
    for (const m of section.matchAll(/^\s*([a-z_]+) --> ([a-z_]+)/gm)) edges.add(`${m[1]}->${m[2]}`);
    const code = new Set(Object.entries(TRANSITIONS).flatMap(([from, tos]) => tos.map((to) => `${from}->${to}`)));
    assert.deepEqual([...edges].sort(), [...code].sort());
  });
  it('rejects illegal transitions', () => {
    assert.equal(canTransition('succeeded', 'queued'), false);
    assert.equal(canTransition('cancel_requested', 'running'), false);
    assert.equal(canTransition('running', 'timed_out'), true);
  });
  it('retry delay: exponential backoff with full jitter, honouring retry_after_ms', () => {
    const policy = { baseMs: 10_000, maxMs: 300_000 };
    assert.equal(retryDelayMs(1, policy, null, () => 0.999), 9990);
    assert.equal(retryDelayMs(3, policy, null, () => 0.5), 20_000);
    assert.equal(retryDelayMs(20, policy, null, () => 0.999999), 299_999);
    assert.equal(retryDelayMs(1, policy, 45_000, () => 0), 45_000);
  });
});
