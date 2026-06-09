import { describe, expect, it } from 'vitest';
import { bindClaim, hasUnboundTokens } from './evidence-binding';
import { canonicalJson } from './actions';

const EV_ID = '2f1e9c1a-1111-4222-8333-444455556666';

describe('evidence binding', () => {
  const digests = new Map<string, Record<string, unknown>>([
    [EV_ID, { value: -0.31, rows: [{ roas_d7: 1.42 }], country: 'DE' }],
  ]);

  it('substitutes values from evidence digests', () => {
    const segs = bindClaim(
      `ROAS dropped {ev:${EV_ID}:value} in {ev:${EV_ID}:country}`,
      digests,
    );
    expect(segs.map((s) => s.kind)).toEqual(['text', 'value', 'text', 'value']);
    expect(segs[1]!.text).toBe('-0.31');
    expect(segs[3]!.text).toBe('DE');
  });

  it('resolves nested digest paths', () => {
    const segs = bindClaim(`d7 was {ev:${EV_ID}:rows[0].roas_d7}`, digests);
    expect(segs[1]!.kind).toBe('value');
    expect(segs[1]!.text).toBe('1.42');
  });

  it('renders an explicit error for unknown evidence — never a raw number', () => {
    const segs = bindClaim(
      'spend was {ev:99999999-9999-4999-8999-999999999999:value}',
      digests,
    );
    expect(segs[1]!.kind).toBe('error');
    expect(segs[1]!.text).toBe('[unverified value]');
    expect(hasUnboundTokens('x {ev:99999999-9999-4999-8999-999999999999:v}', digests)).toBe(true);
  });

  it('renders an explicit error for an unknown digest path', () => {
    const segs = bindClaim(`x {ev:${EV_ID}:not.a.path}`, digests);
    expect(segs[1]!.kind).toBe('error');
  });

  it('passes through claims with no tokens', () => {
    const segs = bindClaim('no numbers asserted here', digests);
    expect(segs).toEqual([{ kind: 'text', text: 'no numbers asserted here' }]);
  });
});

describe('canonicalJson', () => {
  it('is stable under key order', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: 'x' } })).toBe(
      canonicalJson({ a: { c: 'x', d: [2, 1] }, b: 1 }),
    );
  });
  it('drops undefined values and keeps nulls', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });
});
