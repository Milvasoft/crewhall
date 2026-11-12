import {
  civilFromDay,
  dateToDay,
  daysInMonthOf,
  dayToDate,
  formatRRule,
  parseRRule,
  RRULE_WEEKDAYS,
  weekdayOfDay,
  type RRule,
  type RRuleFreq,
} from '@crewhall/shared';

/**
 * Repeat choices of the event editor (Google/Outlook style) on top of RFC 5545 rules: a few
 * presets named after the start date, and a custom rule (every N days/weeks/months/years,
 * weekdays, end never / after N / on a date).
 */

export type RepeatPreset =
  'none' | 'daily' | 'weekdays' | 'weekly' | 'monthlyDay' | 'monthlyNth' | 'yearly' | 'custom';

export const REPEAT_PRESETS: RepeatPreset[] = [
  'none',
  'daily',
  'weekdays',
  'weekly',
  'monthlyDay',
  'monthlyNth',
  'yearly',
  'custom',
];

/** nth weekday of the month of a date (-1 when it is the last one). */
export function nthOfMonth(date: string) {
  const d = dateToDay(date);
  const c = civilFromDay(d);
  const n = c.day + 7 > daysInMonthOf(c.year, c.month) ? -1 : Math.ceil(c.day / 7);
  return { n, weekday: weekdayOfDay(d), day: c.day };
}

export function presetRule(preset: RepeatPreset, date: string): string | null {
  const { n, weekday, day } = nthOfMonth(date);
  switch (preset) {
    case 'none':
    case 'custom':
      return null;
    case 'daily':
      return 'FREQ=DAILY';
    case 'weekdays':
      return 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
    case 'weekly':
      return `FREQ=WEEKLY;BYDAY=${RRULE_WEEKDAYS[weekday]}`;
    case 'monthlyDay':
      return `FREQ=MONTHLY;BYMONTHDAY=${day}`;
    case 'monthlyNth':
      return `FREQ=MONTHLY;BYDAY=${n}${RRULE_WEEKDAYS[weekday]}`;
    case 'yearly':
      return 'FREQ=YEARLY';
  }
}

/** Which preset a stored rule is (for the start date), or custom. */
export function presetOf(rule: string | null, date: string): RepeatPreset {
  if (!rule) return 'none';
  const canon = (s: string) => {
    const r = parseRRule(s);
    return r ? formatRRule(r) : s;
  };
  const c = canon(rule);
  for (const p of REPEAT_PRESETS) {
    const r = presetRule(p, date);
    if (r && canon(r) === c) return p;
  }
  // A plain weekly rule without BYDAY repeats on the start's weekday.
  if (c === 'FREQ=WEEKLY') return 'weekly';
  return 'custom';
}

export interface CustomRule {
  freq: RRuleFreq;
  interval: number;
  /** WEEKLY: 0 = Sunday … 6 = Saturday. */
  weekdays: number[];
  end: 'never' | 'count' | 'until';
  count: number;
  /** `YYYY-MM-DD`, inclusive. */
  until: string;
}

export function customFrom(rule: string | null, date: string): CustomRule {
  const r = rule ? parseRRule(rule) : null;
  const base: CustomRule = {
    freq: r?.freq ?? 'WEEKLY',
    interval: r?.interval ?? 1,
    weekdays: r?.byDay.filter((d) => d.n === null).map((d) => d.weekday) ?? [],
    end: r?.count ? 'count' : r?.until ? 'until' : 'never',
    count: r?.count ?? 10,
    until: r?.until
      ? r.until.kind === 'date'
        ? dayToDate(r.until.day)
        : new Date(r.until.ms).toISOString().slice(0, 10)
      : dayToDate(dateToDay(date) + 90),
  };
  if (!base.weekdays.length) base.weekdays = [weekdayOfDay(dateToDay(date))];
  return base;
}

/** RRULE text of a custom rule; UNTIL is the end of that day in the event's zone (as UTC). */
export function customRule(c: CustomRule, allDay: boolean, untilInstant?: Date): string {
  const r: RRule = {
    freq: c.freq,
    interval: Math.max(1, Math.min(999, Math.round(c.interval))),
    count: c.end === 'count' ? Math.max(1, Math.min(1000, Math.round(c.count))) : null,
    until: null,
    byDay:
      c.freq === 'WEEKLY'
        ? [...new Set(c.weekdays)]
            .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
            .map((weekday) => ({
              weekday,
              n: null,
            }))
        : [],
    byMonthDay: [],
    byMonth: [],
    bySetPos: [],
    wkst: 1,
  };
  if (c.end === 'until') {
    r.until =
      allDay || !untilInstant
        ? { kind: 'date', day: dateToDay(c.until) }
        : { kind: 'instant', ms: untilInstant.getTime() };
  }
  return formatRRule(r);
}

const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

export function weekdayName(weekday: number, locale: string, style: 'long' | 'short' = 'long') {
  // 2026-10-18 is a Sunday.
  const d = new Date(Date.UTC(2026, 9, 18 + weekday, 12));
  return new Intl.DateTimeFormat(locale, { weekday: style, timeZone: 'UTC' }).format(d);
}

export const orderedWeekdays = (weekStart: number) =>
  weekStart === 1 ? WEEKDAY_ORDER : weekStart === 6 ? [6, 0, 1, 2, 3, 4, 5] : [0, 1, 2, 3, 4, 5, 6];
