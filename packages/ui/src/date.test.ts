import { afterEach, describe, expect, it } from 'vitest';
import {
  addMonths,
  formatDay,
  formatTimeOfDay,
  monthGrid,
  parseIsoDate,
  parseIsoTime,
  presetRange,
  toIsoDate,
  todayIso,
  weekdayNames,
  weekStartOf,
} from './date';

const d = (iso: string) => parseIsoDate(iso)!;

describe('iso dates', () => {
  it('round-trips and rejects impossible dates', () => {
    expect(toIsoDate(d('2026-10-18'))).toBe('2026-10-18');
    expect(parseIsoDate('2026-02-30')).toBeNull();
    expect(parseIsoDate('18.10.2026')).toBeNull();
    expect(parseIsoDate(null)).toBeNull();
  });

  it('clamps month arithmetic to the last day', () => {
    expect(toIsoDate(addMonths(d('2026-01-31'), 1))).toBe('2026-02-28');
    expect(toIsoDate(addMonths(d('2024-03-31'), -1))).toBe('2024-02-29');
    expect(toIsoDate(addMonths(d('2026-12-15'), 1))).toBe('2027-01-15');
  });

  it('formats in the locale order', () => {
    expect(formatDay(d('2026-10-18'), 'tr-TR')).toBe('18.10.2026');
    expect(formatDay(d('2026-10-18'), 'en-US')).toBe('10/18/2026');
  });
});

describe('time zones', () => {
  const original = process.env.TZ;
  afterEach(() => {
    process.env.TZ = original;
  });

  it.each(['Pacific/Kiritimati', 'America/Los_Angeles', 'Europe/Istanbul', 'UTC'])(
    'never shifts the day in %s',
    (tz) => {
      process.env.TZ = tz;
      const day = d('2026-03-29');
      expect(toIsoDate(day)).toBe('2026-03-29');
      expect(formatDay(day, 'tr-TR')).toBe('29.03.2026');
      // Local midnight and late evening stay on the local calendar day.
      expect(todayIso(new Date(2026, 2, 29, 0, 5))).toBe('2026-03-29');
      expect(todayIso(new Date(2026, 2, 29, 23, 55))).toBe('2026-03-29');
    },
  );
});

describe('weeks', () => {
  it('starts on Monday in Turkish and Sunday in US English', () => {
    expect(weekStartOf('tr-TR')).toBe(1);
    expect(weekStartOf('en-US')).toBe(7);
    expect(weekStartOf('de-DE')).toBe(1);
    expect(weekdayNames('tr-TR', 1)[0]).toMatch(/^Pzt/);
    expect(weekdayNames('en-US', 7)[0]).toBe('Sun');
  });

  it('builds a six-week grid from the first weekday', () => {
    const grid = monthGrid(d('2026-10-18'), 1);
    expect(grid).toHaveLength(6);
    // 1 Oct 2026 is a Thursday: the Monday-first grid starts on 28 Sep.
    expect(toIsoDate(grid[0]![0]!)).toBe('2026-09-28');
    expect(toIsoDate(monthGrid(d('2026-10-18'), 7)[0]![0]!)).toBe('2026-09-27');
  });
});

describe('presets', () => {
  const today = d('2026-10-18');
  it.each([
    ['today', '2026-10-18', '2026-10-18'],
    ['yesterday', '2026-10-17', '2026-10-17'],
    ['last7', '2026-10-12', '2026-10-18'],
    ['last30', '2026-09-19', '2026-10-18'],
    ['thisMonth', '2026-10-01', '2026-10-18'],
    ['lastMonth', '2026-09-01', '2026-09-30'],
  ] as const)('%s', (preset, from, to) => {
    const [a, b] = presetRange(preset, today);
    expect([toIsoDate(a), toIsoDate(b)]).toEqual([from, to]);
  });
});

describe('times', () => {
  it('parses and formats HH:mm', () => {
    expect(parseIsoTime('16:30')).toBe(990);
    expect(parseIsoTime('24:00')).toBeNull();
    expect(formatTimeOfDay(990, 'tr-TR')).toBe('16:30');
  });
});
