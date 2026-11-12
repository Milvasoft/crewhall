// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/percentage-calculator/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { percentChange, percentOf, whatPercent } from './logic';

describe('percentage-calculator', () => {
  it('computes percent of a value', () => {
    expect(percentOf(20, 150)).toBe(30);
    expect(percentOf(12.5, 80)).toBe(10);
  });

  it('handles zero and negative percentages/values', () => {
    expect(percentOf(0, 100)).toBe(0);
    expect(percentOf(-20, 150)).toBe(-30);
    expect(percentOf(20, -150)).toBe(-30);
  });

  it('computes what percent one number is of another', () => {
    expect(whatPercent(30, 150)).toBe(20);
    expect(() => whatPercent(1, 0)).toThrow();
  });

  it('handles zero part and a negative part in whatPercent', () => {
    expect(whatPercent(0, 100)).toBe(0);
    expect(whatPercent(-30, 150)).toBe(-20);
  });

  it('computes percentage change', () => {
    expect(percentChange(100, 125)).toBe(25);
    expect(percentChange(200, 150)).toBe(-25);
    expect(() => percentChange(0, 10)).toThrow();
  });

  it('uses the absolute starting value so a sign flip is not miscomputed', () => {
    expect(percentChange(-100, 100)).toBe(200);
    expect(percentChange(100, -100)).toBe(-200);
  });
});
