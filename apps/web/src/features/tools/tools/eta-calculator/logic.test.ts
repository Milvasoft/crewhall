// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/eta-calculator/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { computeEta, formatDuration } from './logic';

describe('eta-calculator', () => {
  it('matches the plates example (500 items, 5 per 3 min → 5 hours)', () => {
    const start = 0;
    const { durationSeconds, endMs } = computeEta(500, 5, 3, 60, start);
    expect(durationSeconds).toBe(18000); // 5 hours
    expect(endMs).toBe(18000 * 1000);
  });

  it('formats durations', () => {
    expect(formatDuration(18000)).toBe('5 hours');
    expect(formatDuration(18600)).toBe('5 hours 10 minutes');
    expect(formatDuration(90)).toBe('1 minute 30 seconds');
    expect(formatDuration(0)).toBe('0 seconds');
  });

  it('rejects a zero rate', () => {
    expect(() => computeEta(100, 0, 5, 60, 0)).toThrow();
  });

  it('rejects a negative rate', () => {
    expect(() => computeEta(100, -5, 5, 60, 0)).toThrow();
  });

  it('returns zero duration when there is nothing left to do', () => {
    const { durationSeconds, endMs } = computeEta(0, 5, 3, 60, 1000);
    expect(durationSeconds).toBe(0);
    expect(endMs).toBe(1000);
  });

  it('formats a singular day and drops units past the top two', () => {
    // 1 day, 1 hour, 1 minute, 1 second -> only the two largest are kept.
    expect(formatDuration(86400 + 3600 + 60 + 1)).toBe('1 day 1 hour');
  });

  it('rounds fractional seconds before formatting', () => {
    expect(formatDuration(59.6)).toBe('1 minute');
  });
});
