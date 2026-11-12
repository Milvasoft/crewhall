// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/datetime-playground/logic.ts. See THIRD_PARTY.md.
export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month0: number): number {
  return new Date(year, month0 + 1, 0).getDate();
}

export function dayOfYear(d: Date): number {
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  const cur = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.floor((cur - start) / 86_400_000);
}

/** ISO 8601 week number (weeks start Monday; week 1 contains the first Thursday). */
export function isoWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = (date.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  date.setUTCDate(date.getUTCDate() - day + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  return 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
}

export function quarter(d: Date): number {
  return Math.floor(d.getMonth() / 3) + 1;
}

export interface Offset {
  years: number;
  months: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

export function applyOffset(d: Date, off: Offset): Date {
  const r = new Date(d.getTime());
  r.setFullYear(r.getFullYear() + off.years);
  r.setMonth(r.getMonth() + off.months);
  r.setDate(r.getDate() + off.days);
  r.setHours(r.getHours() + off.hours);
  r.setMinutes(r.getMinutes() + off.minutes);
  r.setSeconds(r.getSeconds() + off.seconds);
  return r;
}

export interface Diff {
  ms: number;
  seconds: number;
  minutes: number;
  hours: number;
  days: number;
}

export function diff(a: Date, b: Date): Diff {
  const ms = b.getTime() - a.getTime();
  return {
    ms,
    seconds: ms / 1000,
    minutes: ms / 60_000,
    hours: ms / 3_600_000,
    days: ms / 86_400_000,
  };
}
