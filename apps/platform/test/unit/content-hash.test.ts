import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { revisionContentHash } from '../../src/modules/content.js';

const base = {
  caption: 'Hello',
  hashtags: ['#a'],
  alt_text: null,
  cta: null,
  disclosure_text: 'AI-generated virtual creator',
  assets: [
    { position: 0, role: 'primary', sha256: 'a'.repeat(64) },
    { position: 1, role: 'carousel', sha256: 'b'.repeat(64) },
  ],
};

describe('revision content hash (what reviewers approve)', () => {
  it('is stable regardless of input ordering of assets by position', () => {
    assert.deepEqual(revisionContentHash(base), revisionContentHash({ ...base, assets: [...base.assets].reverse() }));
  });
  it('changes when anything that would be published changes', () => {
    const h = revisionContentHash(base).toString('hex');
    for (const variant of [
      { ...base, caption: 'Hello!' },
      { ...base, hashtags: ['#b'] },
      { ...base, disclosure_text: 'AI' },
      { ...base, assets: [base.assets[1]!, base.assets[0]!].map((a, i) => ({ ...a, position: i })) },
      { ...base, assets: [{ ...base.assets[0]!, sha256: 'c'.repeat(64) }, base.assets[1]!] },
    ]) {
      assert.notEqual(revisionContentHash(variant).toString('hex'), h);
    }
  });
});
