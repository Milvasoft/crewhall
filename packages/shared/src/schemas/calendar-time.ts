/**
 * Calendar time helpers shared by the api, web and mobile (roadmap 14): civil dates as day
 * numbers, IANA zone conversions through Intl (no tz database of our own) and the keys that
 * name an occurrence of a recurring event. Pure functions, no dependencies.
 */

/** `YYYY-MM-DD`, the wire form of an all-day date. */
export const CALENDAR_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface CivilDate {
  year: number;
  /** 1-12 */
  month: number;
  day: number;
}

export interface WallTime extends CivilDate {
  hour: number;
  minute: number;
  second: number;
}

const DAY_MS = 86_400_000;

/** Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's algorithm). */
export function dayNumber(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function civilFromDay(n: number): CivilDate {
  const z = n + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

/** 0 = Sunday … 6 = Saturday. */
export const weekdayOfDay = (n: number) => (((n + 4) % 7) + 7) % 7;

export function daysInMonthOf(year: number, month: number): number {
  return (
    dayNumber(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1, 1) -
    dayNumber(year, month, 1)
  );
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function formatCalendarDate(d: CivilDate): string {
  return `${pad(d.year, 4)}-${pad(d.month)}-${pad(d.day)}`;
}

export function parseCalendarDate(s: string): CivilDate | null {
  if (!CALENDAR_DATE_RE.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1 || d > daysInMonthOf(y, m)) return null;
  return { year: y, month: m, day: d };
}

export const dateToDay = (s: string): number => {
  const d = parseCalendarDate(s);
  if (!d) throw new Error(`invalid date ${s}`);
  return dayNumber(d.year, d.month, d.day);
};

export const dayToDate = (n: number): string => formatCalendarDate(civilFromDay(n));

/** Adds days to a `YYYY-MM-DD`. */
export const addDaysToDate = (s: string, days: number) => dayToDate(dateToDay(s) + days);

// ---- zones ------------------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** True for a zone name this runtime knows (IANA, or UTC). */
export function isValidTimeZone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** The zone itself when valid, otherwise UTC. */
export function safeZone(tz: string | null | undefined): string {
  return tz && isValidTimeZone(tz) ? tz : 'UTC';
}

/** Wall-clock parts of an instant in a zone. */
export function zonedParts(instant: Date | number, timeZone: string): WallTime {
  const t = typeof instant === 'number' ? instant : instant.getTime();
  const parts = formatter(timeZone).formatToParts(new Date(t));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

/** Offset of the zone from UTC at an instant, in milliseconds (east positive). */
export function zoneOffsetMs(instant: number, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - (instant - (((instant % 1000) + 1000) % 1000));
}

/**
 * The instant a wall-clock time names in a zone. A time skipped by a DST jump moves forward
 * by the gap (02:30 on a spring-forward night becomes 03:30); a repeated hour resolves to
 * one of its two instants.
 */
export function zonedToUtc(w: WallTime, timeZone: string): Date {
  const guess = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const first = guess - zoneOffsetMs(guess, timeZone);
  const second = guess - zoneOffsetMs(first, timeZone);
  if (first === second) return new Date(first);
  // Two answers: the earlier one that maps back to the same wall time wins (repeated hour).
  const back = (t: number) => {
    const p = zonedParts(t, timeZone);
    return p.hour === w.hour && p.minute === w.minute;
  };
  const candidates = [Math.min(first, second), Math.max(first, second)];
  const exact = candidates.find(back);
  return new Date(exact ?? Math.max(first, second));
}

/** Local calendar day number of an instant in a zone. */
export function zonedDay(instant: Date | number, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  return dayNumber(p.year, p.month, p.day);
}

/** Midnight (start of the local day) in a zone, as an instant. */
export function startOfZonedDay(day: number, timeZone: string): Date {
  const c = civilFromDay(day);
  return zonedToUtc({ ...c, hour: 0, minute: 0, second: 0 }, timeZone);
}

/** Minutes since local midnight of an instant in a zone. */
export function zonedMinuteOfDay(instant: Date | number, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  return p.hour * 60 + p.minute;
}

/** The UTC midnight instant of a `YYYY-MM-DD` (how all-day rows sort in the database). */
export const utcMidnight = (date: string) => new Date(dateToDay(date) * DAY_MS);

// ---- occurrences ------------------------------------------------------------------------------

/**
 * Names an occurrence of a recurring event (its original start): the UTC ISO instant for
 * timed events, `YYYY-MM-DD` for all-day ones. Overrides and EXDATEs use the same key.
 */
export function occurrenceKey(start: Date | string, allDay: boolean): string {
  if (allDay)
    return typeof start === 'string'
      ? start.slice(0, 10)
      : dayToDate(Math.floor(start.getTime() / DAY_MS));
  return (typeof start === 'string' ? new Date(start) : start).toISOString();
}
