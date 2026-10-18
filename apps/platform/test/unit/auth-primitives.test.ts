import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hashPassword, verifyPassword } from '../../src/lib/password.js';
import { base32Decode, base32Encode, hotp, totpAt, verifyTotp } from '../../src/lib/totp.js';

describe('TOTP (RFC 6238 / RFC 4226)', () => {
  const rfcSecret = base32Encode(Buffer.from('12345678901234567890'));
  it('matches the RFC 4226 HOTP test vectors', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expected.forEach((code, counter) => assert.equal(hotp(Buffer.from('12345678901234567890'), counter), code));
  });
  it('matches the RFC 6238 SHA-1 vectors (last 6 digits)', () => {
    assert.equal(totpAt(rfcSecret, 59), '287082');
    assert.equal(totpAt(rfcSecret, 1111111109), '081804');
    assert.equal(totpAt(rfcSecret, 1234567890), '005924');
    assert.equal(totpAt(rfcSecret, 2000000000), '279037');
  });
  it('accepts ±1 step, rejects replays and wrong codes', () => {
    const now = 1_800_000_000;
    const code = totpAt(rfcSecret, now - 30);
    const step = verifyTotp(rfcSecret, code, now, null);
    assert.equal(step, Math.floor((now - 30) / 30));
    assert.equal(verifyTotp(rfcSecret, code, now, step), null, 'replay of a used step');
    assert.equal(verifyTotp(rfcSecret, totpAt(rfcSecret, now - 90), now, null), null, 'outside the window');
    assert.equal(verifyTotp(rfcSecret, '12345', now, null), null);
  });
  it('round-trips base32', () => {
    const b = Buffer.from([0, 1, 2, 250, 255, 7]);
    assert.deepEqual(base32Decode(base32Encode(b)), b);
  });
});

describe('password hashing (scrypt)', () => {
  it('verifies the right password only and salts every hash', async () => {
    const a = await hashPassword('correct horse battery staple');
    const b = await hashPassword('correct horse battery staple');
    assert.notEqual(a, b);
    assert.match(a, /^scrypt\$32768\$8\$1\$/);
    assert.equal(await verifyPassword('correct horse battery staple', a), true);
    assert.equal(await verifyPassword('wrong horse battery staple', a), false);
    assert.equal(await verifyPassword('anything', null), false);
  });
  it('rejects short passwords', async () => {
    await assert.rejects(hashPassword('short'), /at least 12/);
  });
});
