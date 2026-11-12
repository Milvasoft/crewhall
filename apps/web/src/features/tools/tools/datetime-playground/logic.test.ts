// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/datetime-playground/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { applyOffset, dayOfYear, daysInMonth, diff, isLeapYear, isoWeek, quarter } from './logic';

describe('datetime-playground', () => {
  it('detects leap years', () => {
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(2100)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
    expect(isLeapYear(1900)).toBe(false); // divisible by 100, not 400
    expect(isLeapYear(2023)).toBe(false);
  });

  it('computes days in month, including February in leap and non-leap years', () => {
    expect(daysInMonth(2024, 1)).toBe(29); // Feb, leap year
    expect(daysInMonth(2023, 1)).toBe(28); // Feb, non-leap year
    expect(daysInMonth(2024, 0)).toBe(31); // Jan
    expect(daysInMonth(2024, 11)).toBe(31); // Dec
    expect(daysInMonth(2024, 3)).toBe(30); // Apr
  });

  it('computes day of year', () => {
    expect(dayOfYear(new Date('2024-01-01T00:00:00Z'))).toBe(1);
    expect(dayOfYear(new Date('2024-12-31T00:00:00Z'))).toBe(366); // leap year
    expect(dayOfYear(new Date('2023-12-31T00:00:00Z'))).toBe(365); // non-leap year
  });

  it('computes ISO week', () => {
    expect(isoWeek(new Date('2024-01-01T00:00:00Z'))).toBe(1);
    expect(isoWeek(new Date('2026-01-01T00:00:00Z'))).toBe(1);
  });

  it('assigns ISO week across a year boundary to the year owning the Thursday', () => {
    // 2023-01-01 is a Sunday; its week's Thursday (2022-12-29) is in 2022, so
    // it belongs to week 52 of 2022, not week 1 of 2023.
    expect(isoWeek(new Date('2023-01-01T00:00:00Z'))).toBe(52);
    // 2024-12-31 is a Tuesday; its week's Thursday (2025-01-02) is in 2025,
    // so it belongs to week 1 of 2025 even though the date is still in 2024.
    expect(isoWeek(new Date('2024-12-31T00:00:00Z'))).toBe(1);
  });

  it('computes quarter, including the boundary months', () => {
    expect(quarter(new Date(2024, 0, 1))).toBe(1);
    expect(quarter(new Date(2024, 2, 31))).toBe(1); // last day of Q1
    expect(quarter(new Date(2024, 3, 1))).toBe(2); // first day of Q2
    expect(quarter(new Date(2024, 5, 30))).toBe(2); // last day of Q2
    expect(quarter(new Date(2024, 6, 1))).toBe(3); // first day of Q3
    expect(quarter(new Date(2024, 11, 1))).toBe(4);
  });

  it('adds an offset', () => {
    const r = applyOffset(new Date('2024-01-31T00:00:00Z'), {
      years: 1,
      months: 0,
      days: 1,
      hours: 0,
      minutes: 0,
      seconds: 0,
    });
    expect(r.getFullYear()).toBe(2025);
  });

  it('subtracts with a negative offset', () => {
    const r = applyOffset(new Date(2024, 5, 15, 12, 0, 0), {
      years: 0,
      months: -1,
      days: -1,
      hours: 0,
      minutes: 0,
      seconds: 0,
    });
    expect(r.getMonth()).toBe(4); // May
    expect(r.getDate()).toBe(14);
  });

  it('computes diffs, including zero and negative (b before a)', () => {
    const d = diff(new Date('2024-01-01T00:00:00Z'), new Date('2024-01-02T00:00:00Z'));
    expect(d.days).toBe(1);
    expect(d.hours).toBe(24);

    const zero = diff(new Date('2024-01-01T00:00:00Z'), new Date('2024-01-01T00:00:00Z'));
    expect(zero.ms).toBe(0);

    const negative = diff(new Date('2024-01-02T00:00:00Z'), new Date('2024-01-01T00:00:00Z'));
    expect(negative.days).toBe(-1);
  });
});
