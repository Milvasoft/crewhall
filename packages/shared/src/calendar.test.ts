import { describe, expect, it } from 'vitest';
import {
  addDaysToDate,
  civilFromDay,
  dayNumber,
  occurrenceKey,
  weekdayOfDay,
  zonedParts,
  zonedToUtc,
} from './schemas/calendar-time';
import {
  expandRRule,
  formatRRule,
  parseRRule,
  seriesEnd,
  type RRule,
} from './schemas/calendar-rrule';
import { canCalendar, CreateCalendarEvent, OccurrencesQuery } from './schemas/calendar';

const rule = (s: string): RRule => {
  const r = parseRRule(s);
  if (!r) throw new Error(`bad rule ${s}`);
  return r;
};

const keys = (input: Parameters<typeof expandRRule>[0]) =>
  expandRRule(input).map((o) => (typeof o.start === 'string' ? o.start : o.start.toISOString()));

describe('calendar time', () => {
  it('converts civil dates and weekdays', () => {
    expect(dayNumber(1970, 1, 1)).toBe(0);
    expect(civilFromDay(dayNumber(2026, 10, 22))).toEqual({ year: 2026, month: 10, day: 22 });
    expect(weekdayOfDay(dayNumber(2026, 10, 22))).toBe(4); // Thursday
    expect(addDaysToDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysToDate('2024-02-28', 1)).toBe('2024-02-29');
  });

  it('maps wall-clock times through DST changes', () => {
    // Berlin: 2026-03-29 02:00 → 03:00.
    const before = zonedToUtc(
      { year: 2026, month: 3, day: 28, hour: 9, minute: 0, second: 0 },
      'Europe/Berlin',
    );
    const after = zonedToUtc(
      { year: 2026, month: 3, day: 30, hour: 9, minute: 0, second: 0 },
      'Europe/Berlin',
    );
    expect(before.toISOString()).toBe('2026-03-28T08:00:00.000Z');
    expect(after.toISOString()).toBe('2026-03-30T07:00:00.000Z');
    // A time inside the gap moves forward.
    const gap = zonedToUtc(
      { year: 2026, month: 3, day: 29, hour: 2, minute: 30, second: 0 },
      'Europe/Berlin',
    );
    expect(zonedParts(gap, 'Europe/Berlin').hour).toBe(3);
    // Istanbul has no DST.
    const ist = zonedToUtc(
      { year: 2026, month: 7, day: 1, hour: 10, minute: 0, second: 0 },
      'Europe/Istanbul',
    );
    expect(ist.toISOString()).toBe('2026-07-01T07:00:00.000Z');
  });

  it('names occurrences', () => {
    expect(occurrenceKey(new Date('2026-10-22T07:00:00Z'), false)).toBe('2026-10-22T07:00:00.000Z');
    expect(occurrenceKey('2026-10-22', true)).toBe('2026-10-22');
  });
});

describe('rrule', () => {
  it('parses, formats and refuses unsupported parts', () => {
    expect(formatRRule(rule('RRULE:freq=weekly;byday=MO,WE;interval=2'))).toBe(
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE',
    );
    expect(parseRRule('FREQ=HOURLY')).toBeNull();
    expect(parseRRule('FREQ=DAILY;BYHOUR=9')).toBeNull();
    expect(parseRRule('FREQ=DAILY;COUNT=3;UNTIL=20261231')).toBeNull();
    expect(parseRRule('FREQ=WEEKLY;BYDAY=1MO')).toBeNull();
    expect(formatRRule(rule('FREQ=DAILY;UNTIL=20261231T235959Z'))).toBe(
      'FREQ=DAILY;UNTIL=20261231T235959Z',
    );
  });

  it('keeps wall-clock time of a weekly series across DST', () => {
    const out = keys({
      rule: rule('FREQ=WEEKLY'),
      allDay: false,
      start: new Date('2026-03-21T08:00:00Z'), // Sat 09:00 Berlin (+1)
      timeZone: 'Europe/Berlin',
      duration: 3_600_000,
      from: new Date('2026-03-01T00:00:00Z'),
      to: new Date('2026-04-10T00:00:00Z'),
    });
    expect(out).toEqual([
      '2026-03-21T08:00:00.000Z',
      '2026-03-28T08:00:00.000Z',
      '2026-04-04T07:00:00.000Z', // 09:00 local in summer time
    ]);
  });

  it('expands BYDAY weekly, COUNT and EXDATE', () => {
    const out = keys({
      rule: rule('FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=5'),
      allDay: false,
      start: new Date('2026-10-19T07:00:00Z'), // Monday
      timeZone: 'Europe/Istanbul',
      duration: 1_800_000,
      from: new Date('2026-10-01T00:00:00Z'),
      to: new Date('2026-12-01T00:00:00Z'),
      exdates: new Set(['2026-10-21T07:00:00.000Z']),
    });
    // 19, (21 removed but counted), 23, 26, 28
    expect(out).toEqual([
      '2026-10-19T07:00:00.000Z',
      '2026-10-23T07:00:00.000Z',
      '2026-10-26T07:00:00.000Z',
      '2026-10-28T07:00:00.000Z',
    ]);
  });

  it('expands monthly ordinals, last weekday and month days', () => {
    expect(
      keys({
        rule: rule('FREQ=MONTHLY;BYDAY=-1FR;COUNT=3'),
        allDay: true,
        start: '2026-10-30',
        timeZone: 'UTC',
        duration: 1,
        from: new Date('2026-01-01T00:00:00Z'),
        to: new Date('2027-12-31T00:00:00Z'),
      }),
    ).toEqual(['2026-10-30', '2026-11-27', '2026-12-25']);
    // The last weekday of the month.
    expect(
      keys({
        rule: rule('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=2'),
        allDay: true,
        start: '2026-10-30',
        timeZone: 'UTC',
        duration: 1,
        from: new Date('2026-01-01T00:00:00Z'),
        to: new Date('2027-12-31T00:00:00Z'),
      }),
    ).toEqual(['2026-10-30', '2026-11-30']);
    // The 31st skips short months.
    expect(
      keys({
        rule: rule('FREQ=MONTHLY;COUNT=3'),
        allDay: true,
        start: '2026-10-31',
        timeZone: 'UTC',
        duration: 1,
        from: new Date('2026-01-01T00:00:00Z'),
        to: new Date('2027-12-31T00:00:00Z'),
      }),
    ).toEqual(['2026-10-31', '2026-12-31', '2027-01-31']);
  });

  it('expands yearly and stops at UNTIL', () => {
    expect(
      keys({
        rule: rule('FREQ=YEARLY;UNTIL=20290101'),
        allDay: true,
        start: '2026-05-19',
        timeZone: 'UTC',
        duration: 1,
        from: new Date('2020-01-01T00:00:00Z'),
        to: new Date('2040-01-01T00:00:00Z'),
      }),
    ).toEqual(['2026-05-19', '2027-05-19', '2028-05-19']);
  });

  it('jumps to a far range of an endless series', () => {
    const out = keys({
      rule: rule('FREQ=DAILY;INTERVAL=3'),
      allDay: false,
      start: new Date('2020-01-01T09:00:00Z'),
      timeZone: 'UTC',
      duration: 3_600_000,
      from: new Date('2030-01-01T00:00:00Z'),
      to: new Date('2030-01-08T00:00:00Z'),
    });
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out.length).toBeLessThanOrEqual(3);
    for (const k of out) expect(k.startsWith('2030-01-0')).toBe(true);
  });

  it('computes the end of a finite series', () => {
    const end = seriesEnd({
      rule: rule('FREQ=DAILY;COUNT=3'),
      allDay: false,
      start: new Date('2026-10-22T07:00:00Z'),
      timeZone: 'UTC',
      duration: 3_600_000,
    });
    expect(end?.toISOString()).toBe('2026-10-24T08:00:00.000Z');
    expect(
      seriesEnd({
        rule: rule('FREQ=DAILY'),
        allDay: false,
        start: new Date(),
        timeZone: 'UTC',
        duration: 1,
      }),
    ).toBeNull();
  });
});

describe('calendar contract', () => {
  it('checks event times', () => {
    const base = { calendarId: '0193a5b0-0000-7000-8000-000000000001', title: 'Plan' };
    expect(
      CreateCalendarEvent.safeParse({
        ...base,
        allDay: true,
        start: '2026-10-22',
        end: '2026-10-23',
      }).success,
    ).toBe(true);
    expect(
      CreateCalendarEvent.safeParse({
        ...base,
        allDay: true,
        start: '2026-10-22',
        end: '2026-10-22',
      }).success,
    ).toBe(false);
    expect(
      CreateCalendarEvent.safeParse({
        ...base,
        start: '2026-10-22T10:00:00Z',
        end: '2026-10-22T09:00:00Z',
      }).success,
    ).toBe(false);
    expect(
      CreateCalendarEvent.safeParse({
        ...base,
        start: '2026-10-22T10:00:00Z',
        end: '2026-10-22T11:00:00Z',
        rrule: 'FREQ=SECONDLY',
      }).success,
    ).toBe(false);
  });

  it('limits occurrence ranges', () => {
    expect(
      OccurrencesQuery.safeParse({ from: '2026-01-01T00:00:00Z', to: '2028-01-01T00:00:00Z' })
        .success,
    ).toBe(false);
    const ok = OccurrencesQuery.parse({
      from: '2026-10-01T00:00:00Z',
      to: '2026-11-01T00:00:00Z',
      cards: 'false',
    });
    expect(ok.cards).toBe(false);
    expect(ok.meetings).toBe(true);
  });

  it('decides calendar rights', () => {
    expect(canCalendar('write', { role: 'viewer', kind: 'team' })).toBe(false);
    expect(canCalendar('write', { role: 'editor', kind: 'space' })).toBe(true);
    expect(canCalendar('manage', { role: 'owner', kind: 'space' })).toBe(false);
    expect(canCalendar('manage', { role: 'owner', kind: 'team' })).toBe(true);
    expect(canCalendar('read', { role: null, kind: 'personal' })).toBe(false);
  });
});
