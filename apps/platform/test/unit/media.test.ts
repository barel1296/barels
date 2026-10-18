import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sniffMime } from '../../src/lib/media.js';
import { encodeSolidPng, hexToRgb, readPngSize } from '../../src/lib/png.js';
import { uuidv7, isUuid } from '../../src/lib/ids.js';

describe('media helpers', () => {
  it('encodes valid PNGs whose IHDR reports the requested size', () => {
    const png = encodeSolidPng(64, 80, hexToRgb('#3366cc'));
    assert.deepEqual(readPngSize(png), { width: 64, height: 80 });
    assert.equal(sniffMime(png), 'image/png');
  });
  it('identifies media by magic bytes, not by declared type', () => {
    assert.equal(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
    assert.equal(sniffMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])), 'image/webp');
    assert.equal(sniffMime(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom')])), 'video/mp4');
    assert.equal(sniffMime(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])), 'video/webm');
    assert.equal(sniffMime(Buffer.from('<html>')), null);
  });
  it('generates time-ordered UUIDv7 identifiers', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    assert.ok(isUuid(a) && isUuid(b));
    assert.equal(a[14], '7');
    assert.ok(a < b);
  });
});
