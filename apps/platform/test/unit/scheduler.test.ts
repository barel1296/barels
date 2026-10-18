import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Candidate, canAdmit, effectivePriority, rankCandidates, selectForDispatch } from '../../src/modules/visual/scheduler.js';

const now = new Date('2026-10-18T12:00:00Z');
const policy = { agingStepSeconds: 600, deadlineUrgencySeconds: 900 };
const ago = (s: number) => new Date(now.getTime() - s * 1000);
function c(id: string, over: Partial<Candidate> = {}): Candidate {
  return {
    id,
    influencerId: 'inf-a',
    priority: 3,
    createdAt: ago(10),
    queuedSince: ago(10),
    deadlineAt: null,
    gpuRequired: true,
    vramMbPeak: 8000,
    usedGpuSecondsToday: 0,
    quotaGpuSecondsPerDay: 1800,
    ...over,
  };
}

describe('GPU scheduler policy', () => {
  it('orders by priority class, then FIFO', () => {
    const ranked = rankCandidates([c('p5', { priority: 5, createdAt: ago(60) }), c('p3b', { createdAt: ago(5) }), c('p2', { priority: 2 }), c('p3a', { createdAt: ago(50) })], now, policy);
    assert.deepEqual(ranked.map((x) => x.id), ['p2', 'p3a', 'p3b', 'p5']);
  });
  it('ages a waiting job by at most one class and never above P2', () => {
    assert.equal(effectivePriority(c('a', { priority: 5, queuedSince: ago(10_000) }), now, policy), 4);
    assert.equal(effectivePriority(c('b', { priority: 2, queuedSince: ago(10_000) }), now, policy), 2);
    assert.equal(effectivePriority(c('c', { priority: 4, queuedSince: ago(599) }), now, policy), 4);
  });
  it('treats jobs with an imminent deadline as P2', () => {
    assert.equal(effectivePriority(c('d', { priority: 4, deadlineAt: new Date(now.getTime() + 300_000) }), now, policy), 2);
  });
  it('fair share: influencers over their daily GPU quota go after everyone within quota', () => {
    const ranked = rankCandidates(
      [c('greedy', { priority: 2, influencerId: 'inf-g', usedGpuSecondsToday: 5000 }), c('fair', { priority: 5, influencerId: 'inf-f', usedGpuSecondsToday: 10 })],
      now,
      policy,
    );
    assert.deepEqual(ranked.map((x) => x.id), ['fair', 'greedy']);
  });
  it('admits GPU jobs concurrently only with measured figures that fit the measured lane budget', () => {
    assert.equal(canAdmit(c('x'), [], null), true);
    assert.equal(canAdmit(c('x'), [{ gpuRequired: true, vramMbPeak: 8000 }], null), false);
    assert.equal(canAdmit(c('x'), [{ gpuRequired: true, vramMbPeak: 8000 }], 20000), true);
    assert.equal(canAdmit(c('x'), [{ gpuRequired: true, vramMbPeak: 14000 }], 20000), false);
    assert.equal(canAdmit(c('x', { vramMbPeak: null }), [{ gpuRequired: true, vramMbPeak: 1000 }], 20000), false);
    assert.equal(canAdmit(c('x', { gpuRequired: false }), [{ gpuRequired: true, vramMbPeak: null }], null), true);
  });
  it('strict head-of-line for GPU jobs; non-GPU jobs may use free slots', () => {
    const ranked = [c('big', { vramMbPeak: 16000 }), c('small', { vramMbPeak: 2000 }), c('cpu', { gpuRequired: false })];
    const chosen = selectForDispatch(ranked, [{ gpuRequired: true, vramMbPeak: 8000 }], 3, 20000);
    assert.deepEqual(chosen.map((x) => x.id), ['cpu']);
  });
  it('never exceeds free slots', () => {
    const ranked = [c('a', { gpuRequired: false }), c('b', { gpuRequired: false }), c('c', { gpuRequired: false })];
    assert.equal(selectForDispatch(ranked, [], 2, null).length, 2);
    assert.equal(selectForDispatch(ranked, [], 0, null).length, 0);
  });
});
