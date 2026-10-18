import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { decryptSecret, encryptSecret, generateToken, hashToken, parseMasterKey, signAssetUrl, verifyAssetSignature } from '../../src/lib/crypto.js';

const master = parseMasterKey('k1', randomBytes(32).toString('base64'));
const keys = new Map([[master.id, master]]);

describe('envelope encryption', () => {
  it('round-trips and never stores plaintext', () => {
    const env = encryptSecret(master, 'IGQ-secret-token', 'row:1');
    assert.equal(env.ciphertext.includes(Buffer.from('IGQ-secret-token')), false);
    assert.equal(env.wrappingKeyId, 'k1');
    assert.equal(decryptSecret(keys, env, 'row:1'), 'IGQ-secret-token');
  });
  it('binds the ciphertext to its row (AAD) and detects tampering', () => {
    const env = encryptSecret(master, 'secret', 'row:1');
    assert.throws(() => decryptSecret(keys, env, 'row:2'));
    const tampered = { ...env, ciphertext: Buffer.from(env.ciphertext) };
    tampered.ciphertext[0] = tampered.ciphertext[0]! ^ 1;
    assert.throws(() => decryptSecret(keys, tampered, 'row:1'));
  });
  it('fails clearly when the wrapping key is not loaded', () => {
    const env = encryptSecret(master, 'secret', 'row:1');
    assert.throws(() => decryptSecret(new Map(), env, 'row:1'), /master key k1 not loaded/);
  });
  it('rejects master keys that are not 32 bytes', () => {
    assert.throws(() => parseMasterKey('x', randomBytes(16).toString('base64')));
  });
});

describe('tokens and signed URLs', () => {
  it('generates prefixed tokens and stores only their hash', () => {
    const t = generateToken('gi');
    assert.match(t, /^gi_[A-Za-z0-9_-]{43}$/);
    assert.equal(hashToken(t).length, 32);
  });
  it('verifies asset URL signatures and expiry', () => {
    const secret = randomBytes(32);
    const exp = 2_000_000_000;
    const sig = signAssetUrl(secret, 'asset-1', exp);
    assert.equal(verifyAssetSignature(secret, 'asset-1', exp, sig, exp - 10), true);
    assert.equal(verifyAssetSignature(secret, 'asset-2', exp, sig, exp - 10), false);
    assert.equal(verifyAssetSignature(secret, 'asset-1', exp + 1, sig, exp - 10), false);
    assert.equal(verifyAssetSignature(secret, 'asset-1', exp, sig, exp + 1), false);
  });
});
