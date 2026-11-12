/**
 * Calendar-date helpers for the pickers. A date-only value is the string "yyyy-MM-dd" and every
 * computation runs on UTC midnights, so the local time zone can never shift a day.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_MS = 86_400_000;

/** Days since 1970-01-01 for a valid "yyyy-MM-dd", otherwise null. */
export function parseIsoDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = ISO_DATE.exec(value);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    return null;
  }
  return Math.round(ms / DAY_MS);
}

export function toIsoDate(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** Today in the user's local calendar (not UTC). */
export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function dayParts(day: number): {
  year: number;
  month: number;
  date: number;
  weekday: number;
} {
  const d = new Date(day * DAY_MS);
  // weekday: 1 = Monday … 7 = Sunday (ISO, same as Intl week info)
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth(),
    date: d.getUTCDate(),
    weekday: d.getUTCDay() || 7,
  };
}

export function dayOf(year: number, month: number, date: number): number {
  return Math.round(Date.UTC(year, month, date) / DAY_MS);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** Same day of month n months later, clamped to the month's last day (31 Jan + 1 = 28 Feb). */
export function addMonths(day: number, n: number): number {
  const { year, month, date } = dayParts(day);
  const target = new Date(Date.UTC(year, month + n, 1));
  const y = target.getUTCFullYear();
  const mo = target.getUTCMonth();
  return dayOf(y, mo, Math.min(date, daysInMonth(y, mo)));
}

export function startOfMonth(day: number): number {
  const { year, month } = dayParts(day);
  return dayOf(year, month, 1);
}

export function endOfMonth(day: number): number {
  const { year, month } = dayParts(day);
  return dayOf(year, month, daysInMonth(year, month));
}

/** First day of the week containing `day`; weekStart is 1 (Monday) … 7 (Sunday). */
export function startOfWeek(day: number, weekStart: number): number {
  const { weekday } = dayParts(day);
  return day - ((weekday - weekStart + 7) % 7);
}

export function clampDay(day: number, min: number | null, max: number | null): number {
  if (min !== null && day < min) return min;
  if (max !== null && day > max) return max;
  return day;
}

/** Six weeks starting on the locale's first weekday, covering the month of `day`. */
export function monthGrid(day: number, weekStart: number): number[][] {
  const first = startOfWeek(startOfMonth(day), weekStart);
  return Array.from({ length: 6 }, (_, w) =>
    Array.from({ length: 7 }, (_, i) => first + w * 7 + i),
  );
}

// Countries whose week starts on Sunday or Saturday (CLDR); everyone else starts on Monday.
const SUNDAY_START = new Set([
  'US',
  'CA',
  'MX',
  'BR',
  'JP',
  'KR',
  'CN',
  'TW',
  'HK',
  'IL',
  'IN',
  'PH',
  'ZA',
  'AU',
  'SA',
  'PE',
  'CO',
  'VE',
  'AR',
  'GT',
  'HN',
  'NI',
  'PA',
  'PR',
  'DO',
  'SV',
  'ID',
  'TH',
  'KE',
  'PK',
]);
const SATURDAY_START = new Set([
  'AE',
  'AF',
  'BH',
  'DJ',
  'DZ',
  'EG',
  'IQ',
  'IR',
  'JO',
  'KW',
  'LY',
  'OM',
  'QA',
  'SD',
  'SY',
]);
const DEFAULT_REGION: Record<string, string> = {
  en: 'US',
  tr: 'TR',
  ja: 'JP',
  ko: 'KR',
  zh: 'CN',
  he: 'IL',
  ar: 'EG',
  pt: 'BR',
  fa: 'IR',
};

/** 1 = Monday … 7 = Sunday, from Intl week info when the engine has it. */
export function weekStartOf(locale: string): number {
  try {
    const loc = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const info = loc.getWeekInfo?.() ?? loc.weekInfo;
    if (info && info.firstDay >= 1 && info.firstDay <= 7) return info.firstDay;
    const region = loc.region ?? DEFAULT_REGION[loc.language];
    if (region && SUNDAY_START.has(region)) return 7;
    if (region && SATURDAY_START.has(region)) return 6;
  } catch {
    // invalid locale tag: fall through
  }
  return 1;
}

function fmt(locale: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale, { ...opts, timeZone: 'UTC' });
}

/** Short weekday names starting on the locale's first weekday ("Pzt", "Sal", …). */
export function weekdayNames(
  locale: string,
  weekStart: number,
  style: 'short' | 'long' = 'short',
): string[] {
  // 2024-01-01 was a Monday.
  const monday = dayOf(2024, 0, 1);
  const f = fmt(locale, { weekday: style });
  return Array.from({ length: 7 }, (_, i) =>
    f.format(new Date((monday + ((weekStart - 1 + i) % 7)) * DAY_MS)),
  );
}

export function monthNames(locale: string, style: 'long' | 'short' = 'long'): string[] {
  const f = fmt(locale, { month: style });
  return Array.from({ length: 12 }, (_, m) => f.format(new Date(Date.UTC(2024, m, 1))));
}

/** Numeric date in the locale's order: tr "18.10.2026", en-US "10/18/2026". */
export function formatDay(day: number, locale: string): string {
  return fmt(locale, { day: '2-digit', month: '2-digit', year: 'numeric' }).format(
    new Date(day * DAY_MS),
  );
}

/** Screen reader label: "18 Ekim 2026 Pazar". */
export function formatDayLong(day: number, locale: string): string {
  return fmt(locale, { dateStyle: 'full' }).format(new Date(day * DAY_MS));
}

export function formatMonthYear(day: number, locale: string): string {
  return fmt(locale, { month: 'long', year: 'numeric' }).format(new Date(day * DAY_MS));
}

/** "HH:mm" → minutes since midnight, or null. */
export function parseIsoTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = ISO_TIME.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function toIsoTime(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  return `${String(h).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** Time in the locale's style (tr "16:30", en-US "04:30 PM"). */
export function formatTimeOfDay(minutes: number, locale: string): string {
  return fmt(locale, { hour: '2-digit', minute: '2-digit' }).format(new Date(minutes * 60_000));
}

export type DateRangePreset =
  'today' | 'yesterday' | 'last7' | 'last30' | 'thisMonth' | 'lastMonth';

export const DATE_RANGE_PRESETS: readonly DateRangePreset[] = [
  'today',
  'yesterday',
  'last7',
  'last30',
  'thisMonth',
  'lastMonth',
];

/** Inclusive [from, to] days of a preset relative to `today`. */
export function presetRange(preset: DateRangePreset, today: number): [number, number] {
  switch (preset) {
    case 'today':
      return [today, today];
    case 'yesterday':
      return [today - 1, today - 1];
    case 'last7':
      return [today - 6, today];
    case 'last30':
      return [today - 29, today];
    case 'thisMonth':
      return [startOfMonth(today), today];
    case 'lastMonth': {
      const prev = addMonths(startOfMonth(today), -1);
      return [prev, endOfMonth(prev)];
    }
  }
}
