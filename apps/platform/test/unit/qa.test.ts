import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Threshold, effectiveThresholds, evaluateQa } from '../../src/modules/visual/qa.js';

const t = (o: Partial<Threshold>): Threshold => ({ id: 'x', influencer_id: null, check_key: 'identity', min_score: null, max_score: null, required: false, on_fail: 'reject', ...o });

describe('platform QA decisions', () => {
  it('influencer thresholds override workspace defaults for the same check', () => {
    const eff = effectiveThresholds([t({ id: 'ws', min_score: 0.7 }), t({ id: 'inf', influencer_id: 'i1', min_score: 0.9 }), t({ id: 'other', influencer_id: 'i2', min_score: 0.1 })], 'i1');
    assert.deepEqual(eff.map((x) => x.id), ['inf']);
  });
  it('rejects below min_score and above max_score', () => {
    assert.equal(evaluateQa([{ check: 'identity', score: 0.6 }], [t({ min_score: 0.8 })]).status, 'rejected');
    assert.equal(evaluateQa([{ check: 'nsfw', score: 0.4 }], [t({ check_key: 'nsfw', max_score: 0.2 })]).status, 'rejected');
    assert.equal(evaluateQa([{ check: 'identity', score: 0.85 }], [t({ min_score: 0.8 })]).status, 'valid');
  });
  it('a required check that the engine did not report fails; an optional one does not', () => {
    assert.equal(evaluateQa([], [t({ min_score: 0.8, required: true })]).status, 'rejected');
    assert.equal(evaluateQa([], [t({ min_score: 0.8 })]).status, 'valid');
  });
  it('flag thresholds keep the asset valid but flagged', () => {
    const d = evaluateQa([{ check: 'identity', score: 0.5 }], [t({ min_score: 0.8, on_fail: 'flag' })]);
    assert.equal(d.status, 'valid');
    assert.equal(d.flagged, true);
    assert.equal(d.reasons.length, 1);
  });
  it('engine pass/fail flags are advisory and ignored by the decision', () => {
    assert.equal(evaluateQa([{ check: 'identity', score: 0.95, passed: false }], [t({ min_score: 0.8 })]).status, 'valid');
  });
});
