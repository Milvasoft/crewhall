// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/roman-numeral-converter/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { intToRoman, romanToInt } from './logic';

describe('roman-numeral-converter', () => {
  it('converts integers to roman', () => {
    expect(intToRoman(4)).toBe('IV');
    expect(intToRoman(1994)).toBe('MCMXCIV');
    expect(intToRoman(3999)).toBe('MMMCMXCIX');
  });

  it('converts roman to integers', () => {
    expect(romanToInt('IV')).toBe(4);
    expect(romanToInt('mcmxciv')).toBe(1994);
  });

  it('rejects out-of-range integers', () => {
    expect(() => intToRoman(0)).toThrow();
    expect(() => intToRoman(4000)).toThrow();
  });

  it('rejects malformed numerals', () => {
    expect(() => romanToInt('IIII')).toThrow();
    expect(() => romanToInt('VX')).toThrow();
    expect(() => romanToInt('ABC')).toThrow();
  });

  it('handles the boundary values 1 and 3999', () => {
    expect(intToRoman(1)).toBe('I');
    expect(romanToInt('I')).toBe(1);
    expect(intToRoman(3999)).toBe('MMMCMXCIX');
    expect(romanToInt('MMMCMXCIX')).toBe(3999);
  });

  it('rejects non-integer and negative values', () => {
    expect(() => intToRoman(1.5)).toThrow();
    expect(() => intToRoman(-5)).toThrow();
  });

  it('rejects empty or whitespace-only input', () => {
    expect(() => romanToInt('')).toThrow();
    expect(() => romanToInt('   ')).toThrow();
  });

  it('accepts mixed case', () => {
    expect(romanToInt('McMxCiv')).toBe(1994);
  });

  it('rejects a numeral one below its shortest form (IC for 99 instead of XCIX)', () => {
    expect(() => romanToInt('IC')).toThrow();
  });

  it('rejects a run of four identical thousands (MMMM)', () => {
    expect(() => romanToInt('MMMM')).toThrow();
  });

  it('round-trips every integer in the supported range through Roman and back', () => {
    for (let n = 1; n <= 3999; n++) {
      expect(romanToInt(intToRoman(n))).toBe(n);
    }
  });
});
