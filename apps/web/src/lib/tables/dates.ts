import { parseIsoDate, toIsoDate } from '@crewhall/ui';

/** Day numbers (days since 1970-01-01, UTC) for the calendar and timeline views. */

export const dayNum = (iso: string) => parseIsoDate(iso.slice(0, 10));

/** ISO weekday 1 (Monday) … 7 (Sunday). */
export const isoWeekday = (day: number) => (((day + 3) % 7) + 7) % 7 + 1;

/** The weeks shown for the month of `anchor`: whole weeks starting on `weekStart`. */
export function monthGrid(anchor: string, weekStart: number) {
  const [y, m] = anchor.split('-').map(Number) as [number, number];
  const first = Math.round(Date.UTC(y, m - 1, 1) / 86_400_000);
  const last = Math.round(Date.UTC(y, m, 0) / 86_400_000);
  const start = first - ((isoWeekday(first) - weekStart + 7) % 7);
  const weeks = Math.ceil((last - start + 1) / 7);
  const days = Array.from({ length: weeks * 7 }, (_, i) => start + i);
  return { first, last, days, from: toIsoDate(days[0]!), to: toIsoDate(days[days.length - 1]!) };
}

/** Same day of month, n months later (clamped by Date). */
export function shiftMonth(anchor: string, n: number) {
  const [y, m] = anchor.split('-').map(Number) as [number, number];
  return toIsoDate(Math.round(Date.UTC(y, m - 1 + n, 1) / 86_400_000));
}

/** Timeline window: `weeks` weeks from the week of `anchor`. */
export function timelineRange(anchor: string, weekStart: number, weeks: number) {
  const a = dayNum(anchor) ?? 0;
  const start = a - ((isoWeekday(a) - weekStart + 7) % 7);
  const days = Array.from({ length: weeks * 7 }, (_, i) => start + i);
  return { start, end: start + weeks * 7 - 1, days, from: toIsoDate(start), to: toIsoDate(start + weeks * 7 - 1) };
}
