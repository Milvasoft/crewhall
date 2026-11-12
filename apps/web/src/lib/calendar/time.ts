import {
  addDaysToDate,
  civilFromDay,
  dateToDay,
  dayToDate,
  startOfZonedDay,
  weekdayOfDay,
  zonedDay,
  zonedMinuteOfDay,
  zonedToUtc,
  type CalendarOccurrence,
  type CalendarView,
} from '@crewhall/shared';

/**
 * View maths for the calendar (roadmap 14). Everything is computed in the person's calendar
 * zone (CalendarSettings.timeZone), not the browser's: a week starts at that zone's midnight,
 * timed events are placed by their minute of day there, all-day events by their dates.
 */

export const SNAP_MINUTES = 15;
export const HOUR_PX = 48;

export function todayIn(tz: string, now = Date.now()) {
  return dayToDate(zonedDay(now, tz));
}

export function startOfWeekDate(date: string, weekStart: number) {
  const d = dateToDay(date);
  return dayToDate(d - ((weekdayOfDay(d) - weekStart + 7) % 7));
}

/** First and last (exclusive) visible dates of a view around `date`. */
export function viewDates(view: CalendarView, date: string, weekStart: number) {
  if (view === 'day') return { first: date, end: addDaysToDate(date, 1) };
  if (view === 'week') {
    const first = startOfWeekDate(date, weekStart);
    return { first, end: addDaysToDate(first, 7) };
  }
  if (view === 'agenda') return { first: date, end: addDaysToDate(date, 30) };
  const c = civilFromDay(dateToDay(date));
  const monthFirst = dayToDate(dateToDay(date) - c.day + 1);
  const first = startOfWeekDate(monthFirst, weekStart);
  return { first, end: addDaysToDate(first, 42) };
}

/** The instants of a date range in a zone (for the occurrences query). */
export function rangeInstants(first: string, end: string, tz: string) {
  return {
    from: startOfZonedDay(dateToDay(first), tz).toISOString(),
    to: startOfZonedDay(dateToDay(end), tz).toISOString(),
  };
}

export function shiftDate(view: CalendarView, date: string, dir: -1 | 1) {
  if (view === 'day') return addDaysToDate(date, dir);
  if (view === 'week') return addDaysToDate(date, 7 * dir);
  if (view === 'agenda') return addDaysToDate(date, 30 * dir);
  const c = civilFromDay(dateToDay(date));
  const total = c.year * 12 + c.month - 1 + dir;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-01`;
}

export function datesBetween(first: string, end: string) {
  const out: string[] = [];
  for (let d = dateToDay(first); d < dateToDay(end); d++) out.push(dayToDate(d));
  return out;
}

/** Local dates an occurrence covers (all-day: its dates; timed: the days it touches). */
export function datesOf(o: Pick<CalendarOccurrence, 'allDay' | 'start' | 'end'>, tz: string) {
  if (o.allDay) {
    const last = Math.max(dateToDay(o.start), dateToDay(o.end) - 1);
    return datesBetween(o.start, dayToDate(last + 1));
  }
  const s = zonedDay(Date.parse(o.start), tz);
  // An event ending exactly at midnight does not touch the next day.
  const endMs = Math.max(Date.parse(o.start), Date.parse(o.end) - 1);
  const e = zonedDay(endMs, tz);
  return datesBetween(dayToDate(s), dayToDate(e + 1));
}

/** Instant of a local date + minute of day in a zone. */
export function instantAt(date: string, minute: number, tz: string) {
  const c = civilFromDay(dateToDay(date));
  const m = Math.max(0, Math.min(24 * 60, minute));
  if (m === 24 * 60) return startOfZonedDay(dateToDay(date) + 1, tz);
  return zonedToUtc({ ...c, hour: Math.floor(m / 60), minute: m % 60, second: 0 }, tz);
}

export const minuteOf = (iso: string, tz: string) => zonedMinuteOfDay(Date.parse(iso), tz);
export const dateOf = (iso: string, tz: string) => dayToDate(zonedDay(Date.parse(iso), tz));

export const snap = (minute: number, step = SNAP_MINUTES) => Math.round(minute / step) * step;

export function hhmm(minute: number) {
  const m = ((minute % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * The end date of a timed event in the editor: an end time at or before the start time on the
 * start's date means the next day (23:30–00:30, or 23:00–00:00 for a slot at 23:00).
 */
export function rollEndDate(
  startDate: string,
  startTime: string,
  endDate: string,
  endTime: string,
) {
  if (endDate === startDate && parseHhmm(endTime) <= parseHhmm(startTime)) {
    return addDaysToDate(startDate, 1);
  }
  return endDate;
}

/**
 * After the person picks a start or end time: the end moves to the next day when it is at or
 * before the start, and back to the start's day when a next-day end becomes later than the start
 * again (10:00–09:00 → next day, then 10:00–11:00 → same day, not 25 hours).
 */
export function settleEndDate(
  startDate: string,
  startTime: string,
  endDate: string,
  endTime: string,
) {
  if (endDate === addDaysToDate(startDate, 1) && parseHhmm(endTime) > parseHhmm(startTime)) {
    return startDate;
  }
  return rollEndDate(startDate, startTime, endDate, endTime);
}

export function parseHhmm(v: string) {
  const [h, m] = v.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export interface Placed<T> {
  item: T;
  /** Minutes from the day's midnight. */
  top: number;
  bottom: number;
  column: number;
  columns: number;
}

/**
 * Side-by-side layout of the timed events of one day: overlapping events share the width,
 * each cluster gets as many columns as it needs at its busiest moment.
 */
export function layoutDay<T>(items: { item: T; top: number; bottom: number }[]): Placed<T>[] {
  const sorted = [...items].sort((a, b) => a.top - b.top || b.bottom - a.bottom);
  const out: Placed<T>[] = [];
  let cluster: Placed<T>[] = [];
  let clusterEnd = -1;
  let columnsEnd: number[] = [];
  const flush = () => {
    const n = columnsEnd.length;
    for (const p of cluster) p.columns = n;
    out.push(...cluster);
    cluster = [];
    columnsEnd = [];
  };
  for (const x of sorted) {
    const bottom = Math.max(x.bottom, x.top + 15);
    if (cluster.length && x.top >= clusterEnd) flush();
    let col = columnsEnd.findIndex((end) => end <= x.top);
    if (col < 0) {
      col = columnsEnd.length;
      columnsEnd.push(bottom);
    } else columnsEnd[col] = bottom;
    cluster.push({ item: x.item, top: x.top, bottom, column: col, columns: 1 });
    clusterEnd = Math.max(clusterEnd, bottom);
  }
  flush();
  return out;
}

/** Wire start/end of an all-day range moved by `days`. */
export function moveDates(start: string, end: string, days: number) {
  return { start: addDaysToDate(start, days), end: addDaysToDate(end, days) };
}

/** The browser's zone, sent once while the person has not chosen one. */
export function browserZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

/** Every zone this browser knows (Intl.supportedValuesOf), for the settings select. */
export function knownZones(): string[] {
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] })
      .supportedValuesOf;
    const list = fn ? fn('timeZone') : [];
    return list.includes('UTC') ? list : ['UTC', ...list];
  } catch {
    return ['UTC', 'Europe/Istanbul'];
  }
}

const BCP47: Record<string, string> = { tr: 'tr-TR', en: 'en-GB' };

/** Clock time of an instant in the calendar zone (not the browser's). */
export function formatTimeIn(iso: string, locale: string, tz: string) {
  return new Intl.DateTimeFormat(BCP47[locale] ?? locale, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: tz,
  }).format(new Date(iso));
}

/** A `YYYY-MM-DD` (a calendar date, zone-free) formatted for the locale. */
export function formatDateOnly(
  date: string,
  locale: string,
  opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' },
) {
  return new Intl.DateTimeFormat(BCP47[locale] ?? locale, { ...opts, timeZone: 'UTC' }).format(
    new Date(dateToDay(date) * 86_400_000),
  );
}
