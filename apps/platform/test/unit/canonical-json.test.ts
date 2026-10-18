import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalize, manifestSha256, sha256Hex } from '../../src/lib/canonical-json.js';

describe('canonical JSON (RFC 8785 subset)', () => {
  it('sorts keys recursively and drops whitespace', () => {
    assert.equal(canonicalize({ b: 1, a: { d: [3, { z: true, y: null }], c: 'x' } }), '{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}');
  });
  it('sorts by UTF-16 code units and escapes like JSON.stringify', () => {
    assert.equal(canonicalize({ é: 1, z: 2, A: 3, '\u0001': 'a"b' }), '{"\\u0001":"a\\"b","A":3,"z":2,"é":1}');
  });
  it('uses ECMAScript number serialisation', () => {
    assert.equal(canonicalize([1.0, 0.5, 1e21, -0]), '[1,0.5,1e+21,0]');
  });
  it('rejects values that are not JSON', () => {
    assert.throws(() => canonicalize(Number.NaN));
    assert.throws(() => canonicalize(Number.POSITIVE_INFINITY));
    assert.throws(() => canonicalize(10n as unknown));
  });
  it('omits undefined object members, like JSON', () => {
    assert.equal(canonicalize({ a: undefined, b: 1 }), '{"b":1}');
  });
  it('manifest hash ignores the lifecycle fields deprecated and sunset_at only', () => {
    const m = { workflow_key: 'k', version: '1.0.0', title: 't' };
    const h = manifestSha256(m);
    assert.equal(manifestSha256({ ...m, deprecated: true, sunset_at: '2027-01-01T00:00:00Z' }), h);
    assert.notEqual(manifestSha256({ ...m, title: 'u' }), h);
    assert.equal(h, sha256Hex(canonicalize(m)));
  });
});
