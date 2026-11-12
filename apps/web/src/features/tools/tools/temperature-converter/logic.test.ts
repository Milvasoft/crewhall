// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/temperature-converter/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { convertAllTemps, convertTemp } from './logic';

describe('temperature-converter', () => {
  it('converts C to F', () => {
    expect(convertTemp(100, 'c', 'f')).toBeCloseTo(212);
    expect(convertTemp(0, 'c', 'f')).toBeCloseTo(32);
    expect(convertTemp(-40, 'c', 'f')).toBeCloseTo(-40);
  });

  it('converts C to K', () => {
    expect(convertTemp(0, 'c', 'k')).toBeCloseTo(273.15);
  });

  it('converts F to C', () => {
    expect(convertTemp(98.6, 'f', 'c')).toBeCloseTo(37);
  });

  it('handles Rankine', () => {
    expect(convertTemp(0, 'c', 'r')).toBeCloseTo(491.67);
    expect(convertTemp(491.67, 'r', 'c')).toBeCloseTo(0);
  });

  it('is identity for same unit', () => {
    expect(convertTemp(25, 'c', 'c')).toBe(25);
  });

  it('handles absolute zero', () => {
    expect(convertTemp(-273.15, 'c', 'k')).toBeCloseTo(0);
    expect(convertTemp(0, 'k', 'c')).toBeCloseTo(-273.15);
    expect(convertTemp(0, 'k', 'r')).toBeCloseTo(0);
  });

  it('does not clamp or throw below absolute zero (pure math, no validation)', () => {
    expect(convertTemp(-300, 'c', 'k')).toBeCloseTo(-26.85);
    expect(convertTemp(-10, 'k', 'c')).toBeCloseTo(-283.15);
  });

  it('round-trips through every unit pair', () => {
    const units = ['c', 'f', 'k', 'r'] as const;
    for (const from of units) {
      for (const to of units) {
        const original = 36.6;
        const roundTripped = convertTemp(convertTemp(original, from, to), to, from);
        expect(roundTripped).toBeCloseTo(original, 9);
      }
    }
  });

  it('convertAllTemps returns every unit, rounded to 2 decimals', () => {
    const rows = convertAllTemps(0, 'c');
    expect(rows).toHaveLength(4);
    const byUnit = Object.fromEntries(rows.map((r) => [r.unit, r.value]));
    expect(byUnit.c).toBe(0);
    expect(byUnit.f).toBe(32);
    expect(byUnit.k).toBe(273.15);
    expect(byUnit.r).toBe(491.67);
  });
});
