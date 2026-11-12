// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/number-base/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { convertBases, isValidBase, parseInBase, toBase } from './logic';

describe('number-base', () => {
  it('parses hex to a BigInt value', () => {
    expect(parseInBase('ff', 16)).toBe(255n);
    expect(parseInBase('0xFF', 16)).toBe(255n);
  });

  it('converts decimal to all common bases', () => {
    const rows = convertBases('255', 10);
    expect(rows.find((r) => r.base === 16)?.value).toBe('ff');
    expect(rows.find((r) => r.base === 2)?.value).toBe('11111111');
    expect(rows.find((r) => r.base === 8)?.value).toBe('377');
  });

  it('handles negatives and separators', () => {
    expect(parseInBase('-1010', 2)).toBe(-10n);
    expect(parseInBase('1111_1111', 2)).toBe(255n);
  });

  it('is exact for very large numbers', () => {
    const big = '123456789012345678901234567890';
    expect(toBase(parseInBase(big, 10), 10)).toBe(big);
  });

  it('rejects invalid digits and bases', () => {
    expect(() => parseInBase('2', 2)).toThrow();
    expect(() => parseInBase('1', 99)).toThrow();
    expect(() => parseInBase('g', 16)).toThrow();
  });

  it('validates the base range (2-36 inclusive)', () => {
    expect(isValidBase(2)).toBe(true);
    expect(isValidBase(36)).toBe(true);
    expect(isValidBase(1)).toBe(false);
    expect(isValidBase(37)).toBe(false);
    expect(isValidBase(2.5)).toBe(false);
  });

  it('rejects empty or whitespace-only input', () => {
    expect(() => parseInBase('', 10)).toThrow();
    expect(() => parseInBase('   ', 2)).toThrow();
  });

  it('tolerates a leading +', () => {
    expect(parseInBase('+42', 10)).toBe(42n);
  });

  it('only strips a base-specific prefix when it matches the chosen base', () => {
    // "0x10" isn't valid in base 10 because 'x' isn't a base-10 digit.
    expect(() => parseInBase('0x10', 10)).toThrow();
    expect(parseInBase('0b101', 2)).toBe(5n);
    expect(parseInBase('0o17', 8)).toBe(15n);
  });

  it('renders base 36 using the full alphanumeric digit set', () => {
    expect(toBase(35n, 36)).toBe('z');
    expect(toBase(0n, 36)).toBe('0');
  });

  it('rejects an invalid base when rendering', () => {
    expect(() => toBase(10n, 37)).toThrow();
    expect(() => toBase(10n, 1)).toThrow();
  });

  it('round-trips large numbers through every common base', () => {
    const big = 123456789012345678901234567890n;
    for (const base of [2, 8, 16, 36]) {
      expect(parseInBase(toBase(big, base), base)).toBe(big);
    }
  });

  it('keeps the negative sign through convertBases', () => {
    const rows = convertBases('-255', 10);
    expect(rows.find((r) => r.base === 16)?.value).toBe('-ff');
    expect(rows.find((r) => r.base === 2)?.value).toBe('-11111111');
  });
});
