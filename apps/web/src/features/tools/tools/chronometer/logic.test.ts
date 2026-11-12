// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/chronometer/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { formatStopwatch } from './logic';

describe('chronometer', () => {
  it('formats durations', () => {
    expect(formatStopwatch(0)).toBe('00:00:00.00');
    expect(formatStopwatch(1234)).toBe('00:00:01.23');
    expect(formatStopwatch(65_432)).toBe('00:01:05.43');
    expect(formatStopwatch(3_661_000)).toBe('01:01:01.00');
  });

  it('clamps negatives', () => {
    expect(formatStopwatch(-50)).toBe('00:00:00.00');
  });

  it('handles the centisecond boundary just under a second', () => {
    expect(formatStopwatch(999)).toBe('00:00:00.99');
  });

  it('floors fractional milliseconds', () => {
    expect(formatStopwatch(1234.9)).toBe('00:00:01.23');
  });

  it('does not wrap hours past two digits', () => {
    expect(formatStopwatch(360_000_000)).toBe('100:00:00.00'); // 100h
  });
});
