import {
  civilFromDay,
  dateToDay,
  dayNumber,
  daysInMonthOf,
  dayToDate,
  weekdayOfDay,
  zonedDay,
  zonedParts,
  zonedToUtc,
} from './calendar-time';

/**
 * RFC 5545 recurrence rules (roadmap 14), the subset calendars actually send: FREQ DAILY,
 * WEEKLY, MONTHLY or YEARLY with INTERVAL, COUNT, UNTIL, BYDAY (with ordinals), BYMONTHDAY,
 * BYMONTH, BYSETPOS and WKST. Occurrences are expanded in the event's own zone, so a weekly
 * 09:00 stays 09:00 across DST changes. Anything else (BYHOUR, BYWEEKNO…) is refused when the
 * rule is parsed, never silently misread.
 */

export const RRULE_FREQS = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const;
export type RRuleFreq = (typeof RRULE_FREQS)[number];

/** 0 = Sunday … 6 = Saturday, like Date#getDay. */
export const RRULE_WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;

export interface RRuleByDay {
  weekday: number;
  /** 1 = first, -1 = last; null = every such weekday of the period. */
  n: number | null;
}

/** UNTIL is inclusive: a date for all-day events, an instant (ms) for timed ones. */
export type RRuleUntil = { kind: 'date'; day: number } | { kind: 'instant'; ms: number };

export interface RRule {
  freq: RRuleFreq;
  interval: number;
  count: number | null;
  until: RRuleUntil | null;
  byDay: RRuleByDay[];
  byMonthDay: number[];
  byMonth: number[];
  bySetPos: number[];
  /** Week start for WEEKLY with INTERVAL > 1; Monday by default. */
  wkst: number;
}

export const RRULE_MAX_COUNT = 1000;

const intList = (v: string, min: number, max: number, nonZero = false) => {
  const out: number[] = [];
  for (const part of v.split(',')) {
    if (!/^[+-]?\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < min || n > max || (nonZero && n === 0)) return null;
    out.push(n);
  }
  return out;
};

function parseUntil(v: string): RRuleUntil | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  if (h === undefined) return { kind: 'date', day: dayNumber(+y!, +mo!, +d!) };
  // A floating UNTIL (no Z) is read as UTC; RFC 5545 requires UTC with a timed DTSTART.
  return { kind: 'instant', ms: Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!) };
}

/**
 * Parses `FREQ=WEEKLY;BYDAY=MO,WE` (with or without the `RRULE:` prefix). Returns null for
 * malformed or unsupported rules.
 */
export function parseRRule(input: string): RRule | null {
  const text = input.trim().replace(/^RRULE:/i, '');
  if (!text || text.length > 500) return null;
  const rule: RRule = {
    freq: 'DAILY',
    interval: 1,
    count: null,
    until: null,
    byDay: [],
    byMonthDay: [],
    byMonth: [],
    bySetPos: [],
    wkst: 1,
  };
  let freq: RRuleFreq | null = null;
  for (const part of text.split(';')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq < 1) return null;
    const key = part.slice(0, eq).toUpperCase();
    const value = part.slice(eq + 1).toUpperCase();
    switch (key) {
      case 'FREQ':
        if (!(RRULE_FREQS as readonly string[]).includes(value)) return null;
        freq = value as RRuleFreq;
        break;
      case 'INTERVAL': {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > 999) return null;
        rule.interval = n;
        break;
      }
      case 'COUNT': {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > RRULE_MAX_COUNT) return null;
        rule.count = n;
        break;
      }
      case 'UNTIL':
        rule.until = parseUntil(value);
        if (!rule.until) return null;
        break;
      case 'BYDAY':
        for (const d of value.split(',')) {
          const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(d);
          if (!m) return null;
          const n = m[1] === undefined ? null : Number(m[1]);
          if (n !== null && (n === 0 || n < -53 || n > 53)) return null;
          rule.byDay.push({ weekday: RRULE_WEEKDAYS.indexOf(m[2] as 'SU'), n });
        }
        break;
      case 'BYMONTHDAY': {
        const l = intList(value, -31, 31, true);
        if (!l) return null;
        rule.byMonthDay = l;
        break;
      }
      case 'BYMONTH': {
        const l = intList(value, 1, 12);
        if (!l) return null;
        rule.byMonth = l;
        break;
      }
      case 'BYSETPOS': {
        const l = intList(value, -366, 366, true);
        if (!l) return null;
        rule.bySetPos = l;
        break;
      }
      case 'WKST': {
        const i = RRULE_WEEKDAYS.indexOf(value as 'SU');
        if (i < 0) return null;
        rule.wkst = i;
        break;
      }
      default:
        return null;
    }
  }
  if (!freq) return null;
  rule.freq = freq;
  if (rule.count !== null && rule.until !== null) return null;
  // Ordinals only make sense within a month or year.
  if (rule.byDay.some((d) => d.n !== null) && (freq === 'DAILY' || freq === 'WEEKLY')) return null;
  // Yearly "nth weekday of the year" is not supported; with BYMONTH it is per month.
  if (freq === 'YEARLY' && rule.byDay.length > 0 && rule.byMonth.length === 0) return null;
  if (rule.bySetPos.length > 0 && freq !== 'MONTHLY' && freq !== 'YEARLY') return null;
  return rule;
}

const two = (n: number) => String(n).padStart(2, '0');

/** Canonical text without the `RRULE:` prefix. */
export function formatRRule(rule: RRule): string {
  const parts = [`FREQ=${rule.freq}`];
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.count !== null) parts.push(`COUNT=${rule.count}`);
  if (rule.until) {
    if (rule.until.kind === 'date')
      parts.push(`UNTIL=${dayToDate(rule.until.day).replace(/-/g, '')}`);
    else {
      const d = new Date(rule.until.ms);
      parts.push(
        `UNTIL=${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}T${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}Z`,
      );
    }
  }
  if (rule.byDay.length) {
    parts.push(
      `BYDAY=${rule.byDay.map((d) => `${d.n ?? ''}${RRULE_WEEKDAYS[d.weekday]}`).join(',')}`,
    );
  }
  if (rule.byMonthDay.length) parts.push(`BYMONTHDAY=${rule.byMonthDay.join(',')}`);
  if (rule.byMonth.length) parts.push(`BYMONTH=${rule.byMonth.join(',')}`);
  if (rule.bySetPos.length) parts.push(`BYSETPOS=${rule.bySetPos.join(',')}`);
  if (rule.wkst !== 1) parts.push(`WKST=${RRULE_WEEKDAYS[rule.wkst]}`);
  return parts.join(';');
}

// ---- expansion --------------------------------------------------------------------------------

function weekdaysInMonth(year: number, month: number, d: RRuleByDay): number[] {
  const first = dayNumber(year, month, 1);
  const len = daysInMonthOf(year, month);
  const all: number[] = [];
  const offset = (d.weekday - weekdayOfDay(first) + 7) % 7;
  for (let x = first + offset; x < first + len; x += 7) all.push(x);
  if (d.n === null) return all;
  const pick = d.n > 0 ? all[d.n - 1] : all[all.length + d.n];
  return pick === undefined ? [] : [pick];
}

function monthSet(rule: RRule, year: number, month: number, startDayOfMonth: number): number[] {
  const first = dayNumber(year, month, 1);
  const len = daysInMonthOf(year, month);
  let byMonthDay: number[] | null = null;
  if (rule.byMonthDay.length) {
    byMonthDay = rule.byMonthDay
      .map((n) => (n > 0 ? n : len + n + 1))
      .filter((n) => n >= 1 && n <= len)
      .map((n) => first + n - 1);
  }
  let byDay: number[] | null = null;
  if (rule.byDay.length) byDay = rule.byDay.flatMap((d) => weekdaysInMonth(year, month, d));
  if (byMonthDay && byDay) {
    const s = new Set(byDay);
    return byMonthDay.filter((x) => s.has(x));
  }
  if (byMonthDay) return byMonthDay;
  if (byDay) return byDay;
  // No day parts: the start's day of month; months without it are skipped (RFC 5545).
  return startDayOfMonth <= len ? [first + startDayOfMonth - 1] : [];
}

function applySetPos(rule: RRule, set: number[]): number[] {
  const sorted = [...new Set(set)].sort((a, b) => a - b);
  if (!rule.bySetPos.length) return sorted;
  const out: number[] = [];
  for (const p of rule.bySetPos) {
    const x = p > 0 ? sorted[p - 1] : sorted[sorted.length + p];
    if (x !== undefined) out.push(x);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/** Candidate days of period `k` (k-th DAILY step, week, month or year from the start). */
function periodDays(rule: RRule, startDay: number, k: number): number[] {
  const start = civilFromDay(startDay);
  const monthOk = (d: number) =>
    !rule.byMonth.length || rule.byMonth.includes(civilFromDay(d).month);
  switch (rule.freq) {
    case 'DAILY': {
      const d = startDay + k * rule.interval;
      if (!monthOk(d)) return [];
      if (rule.byMonthDay.length) {
        const c = civilFromDay(d);
        const len = daysInMonthOf(c.year, c.month);
        if (!rule.byMonthDay.some((n) => (n > 0 ? n : len + n + 1) === c.day)) return [];
      }
      if (rule.byDay.length && !rule.byDay.some((x) => x.weekday === weekdayOfDay(d))) return [];
      return [d];
    }
    case 'WEEKLY': {
      const weekStart =
        startDay - ((weekdayOfDay(startDay) - rule.wkst + 7) % 7) + 7 * k * rule.interval;
      const weekdays = rule.byDay.length
        ? rule.byDay.map((x) => x.weekday)
        : [weekdayOfDay(startDay)];
      return weekdays
        .map((w) => weekStart + ((w - rule.wkst + 7) % 7))
        .filter(monthOk)
        .sort((a, b) => a - b);
    }
    case 'MONTHLY': {
      const total = start.year * 12 + (start.month - 1) + k * rule.interval;
      const year = Math.floor(total / 12);
      const month = (total % 12) + 1;
      if (rule.byMonth.length && !rule.byMonth.includes(month)) return [];
      return applySetPos(rule, monthSet(rule, year, month, start.day));
    }
    case 'YEARLY': {
      const year = start.year + k * rule.interval;
      const months = rule.byMonth.length ? rule.byMonth : [start.month];
      const set = months.flatMap((m) =>
        rule.byDay.length || rule.byMonthDay.length
          ? monthSet(rule, year, m, start.day)
          : start.day <= daysInMonthOf(year, m)
            ? [dayNumber(year, m, start.day)]
            : [],
      );
      return applySetPos(rule, set);
    }
  }
}

/** First day of period `k`; no candidate of the period lies before it. */
function periodStartDay(rule: RRule, startDay: number, k: number): number {
  const start = civilFromDay(startDay);
  switch (rule.freq) {
    case 'DAILY':
      return startDay + k * rule.interval;
    case 'WEEKLY':
      return startDay - ((weekdayOfDay(startDay) - rule.wkst + 7) % 7) + 7 * k * rule.interval;
    case 'MONTHLY': {
      const total = start.year * 12 + (start.month - 1) + k * rule.interval;
      return dayNumber(Math.floor(total / 12), (total % 12) + 1, 1);
    }
    case 'YEARLY':
      return dayNumber(start.year + k * rule.interval, 1, 1);
  }
}

/** Index of the period that contains `day` (or the last one before it). */
function periodIndexOf(rule: RRule, startDay: number, day: number): number {
  const start = civilFromDay(startDay);
  const c = civilFromDay(day);
  switch (rule.freq) {
    case 'DAILY':
      return Math.floor((day - startDay) / rule.interval);
    case 'WEEKLY': {
      const ws = startDay - ((weekdayOfDay(startDay) - rule.wkst + 7) % 7);
      return Math.floor((day - ws) / (7 * rule.interval));
    }
    case 'MONTHLY':
      return Math.floor((c.year * 12 + c.month - (start.year * 12 + start.month)) / rule.interval);
    case 'YEARLY':
      return Math.floor((c.year - start.year) / rule.interval);
  }
}

export interface ExpandInput {
  rule: RRule;
  allDay: boolean;
  /** All-day: the first date. Timed: the first start instant. */
  start: string | Date;
  /** The event's zone; wall-clock time of the first start is kept in it. */
  timeZone: string;
  /** Timed: length in ms. All-day: length in days. */
  duration: number;
  /** Occurrences overlapping [from, to) are returned. */
  from: Date;
  to: Date;
  /** Occurrence keys (see occurrenceKey) to leave out. */
  exdates?: ReadonlySet<string>;
  /** Hard cap on returned occurrences. */
  limit?: number;
}

export interface Occurrence {
  /** occurrenceKey of the original start. */
  key: string;
  /** All-day: `YYYY-MM-DD`; timed: instant. */
  start: string | Date;
  end: string | Date;
}

const DAY_MS = 86_400_000;
const MAX_PERIODS = 200_000;

/**
 * Expands a rule into the occurrences that overlap [from, to). The first start always
 * counts as the first occurrence (COUNT includes it); EXDATEs are removed after counting.
 */
export function expandRRule(input: ExpandInput): Occurrence[] {
  const { rule, allDay, timeZone } = input;
  const limit = input.limit ?? 2000;
  const fromMs = input.from.getTime();
  const toMs = input.to.getTime();

  let startDay: number;
  let minuteOfDay = 0;
  let second = 0;
  if (allDay) startDay = dateToDay(input.start as string);
  else {
    const p = zonedParts(input.start as Date, timeZone);
    startDay = dayNumber(p.year, p.month, p.day);
    minuteOfDay = p.hour * 60 + p.minute;
    second = p.second;
  }

  const instantOf = (day: number) => {
    const c = civilFromDay(day);
    return zonedToUtc(
      { ...c, hour: Math.floor(minuteOfDay / 60), minute: minuteOfDay % 60, second },
      timeZone,
    );
  };
  const make = (day: number): Occurrence => {
    if (allDay) {
      const date = dayToDate(day);
      return { key: date, start: date, end: dayToDate(day + input.duration) };
    }
    const s = instantOf(day);
    return { key: s.toISOString(), start: s, end: new Date(s.getTime() + input.duration) };
  };
  const overlaps = (day: number) => {
    if (allDay) {
      // All-day rows compare as UTC dates; a day of slack on each side covers every zone.
      const s = day * DAY_MS;
      return s < toMs + DAY_MS && s + input.duration * DAY_MS > fromMs - DAY_MS;
    }
    const s = instantOf(day).getTime();
    return s < toMs && s + input.duration > fromMs;
  };
  const afterUntil = (day: number) => {
    if (!rule.until) return false;
    if (rule.until.kind === 'date') return day > rule.until.day;
    if (allDay) return day * DAY_MS > rule.until.ms;
    return instantOf(day).getTime() > rule.until.ms;
  };
  // Local day after which no occurrence can overlap the range.
  const lastDay = allDay ? Math.floor(toMs / DAY_MS) + 1 : zonedDay(toMs, timeZone) + 1;

  const out: Occurrence[] = [];
  const skip = input.exdates ?? new Set<string>();
  const push = (day: number) => {
    if (!overlaps(day)) return;
    const o = make(day);
    if (!skip.has(o.key)) out.push(o);
  };

  let k = 0;
  let counted = 0;
  if (rule.count === null) {
    // Without COUNT nothing before the range matters: jump close to it.
    const durDays = allDay ? input.duration : Math.ceil(input.duration / DAY_MS);
    const firstDay =
      (allDay ? Math.floor(fromMs / DAY_MS) : zonedDay(fromMs, timeZone)) - durDays - 2;
    k = Math.max(0, periodIndexOf(rule, startDay, firstDay) - 1);
  }
  if (k === 0) {
    counted = 1;
    if (afterUntil(startDay)) return out;
    push(startDay);
  }

  for (let periods = 0; periods < MAX_PERIODS && out.length < limit; periods++, k++) {
    if (periodStartDay(rule, startDay, k) > lastDay) break;
    const days = periodDays(rule, startDay, k);
    let pastEnd = false;
    for (const day of days) {
      if (day <= startDay) continue;
      if (afterUntil(day) || day > lastDay) {
        pastEnd = true;
        break;
      }
      if (rule.count !== null && counted >= rule.count) return out;
      counted++;
      push(day);
      if (out.length >= limit) return out;
    }
    if (pastEnd) break;
    if (rule.count !== null && counted >= rule.count) break;
  }
  return out;
}

/**
 * The end of the last occurrence, or null when the series never ends; used to keep finished
 * series out of range queries.
 */
export function seriesEnd(
  input: Omit<ExpandInput, 'from' | 'to' | 'limit' | 'exdates'>,
): Date | null {
  const { rule, allDay } = input;
  if (rule.count === null && rule.until === null) return null;
  if (rule.until && rule.count === null) {
    const untilMs =
      rule.until.kind === 'date' ? (rule.until.day + 1) * DAY_MS + DAY_MS : rule.until.ms;
    return new Date(untilMs + (allDay ? input.duration * DAY_MS : input.duration) + DAY_MS);
  }
  const all = expandRRule({
    ...input,
    from: new Date(Date.UTC(1000, 0, 1)),
    to: new Date(Date.UTC(9999, 0, 1)),
    limit: RRULE_MAX_COUNT + 1,
  });
  const last = all[all.length - 1];
  if (!last) return null;
  if (allDay) return new Date(dateToDay(last.end as string) * DAY_MS + DAY_MS);
  return last.end as Date;
}
