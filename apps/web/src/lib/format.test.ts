import { describe, expect, it } from 'vitest';
import { fmtNum, fmtPct, fmtUsd } from './format';

describe('formatters', () => {
  it('formats USD with K abbreviation', () => {
    expect(fmtUsd(1234.5)).toBe('$1.2K');
    expect(fmtUsd(42)).toBe('$42');
  });
  it('formats percents from ratios', () => {
    expect(fmtPct(0.315)).toBe('31.5%');
  });
  it('handles garbage without throwing', () => {
    expect(fmtNum('not-a-number')).toBe('—');
    expect(fmtUsd(undefined)).toBe('$0');
  });
});
