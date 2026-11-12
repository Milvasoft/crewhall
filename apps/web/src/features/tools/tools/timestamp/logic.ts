// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/timestamp/logic.ts. See THIRD_PARTY.md.
export interface TimeInfo {
  unixSeconds: number;
  unixMillis: number;
  iso: string;
  utc: string;
  relative: string;
}

/**
 * Interpret free-form input as a moment in time. Accepts Unix seconds, Unix
 * milliseconds (auto-detected by magnitude), or any string `Date` can parse
 * (ISO 8601, RFC dates…). Returns null when it can't be understood.
 */
export function parseInput(input: string): Date | null {
  const s = input.trim();
  if (!s) return null;

  if (/^-?\d+$/.test(s)) {
    const n = Number(s);
    // 13+ digits → milliseconds; otherwise treat as seconds.
    const ms = Math.abs(n) >= 1e12 ? n : n * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `locale` formats the relative time; undefined uses the runtime default. */
export function toInfo(date: Date, now: Date = new Date(), locale?: string): TimeInfo {
  return {
    unixSeconds: Math.floor(date.getTime() / 1000),
    unixMillis: date.getTime(),
    iso: date.toISOString(),
    utc: date.toUTCString(),
    relative: relativeTime(date, now, locale),
  };
}

export const COMMON_TIMEZONES = [
  'UTC',
  'America/Los_Angeles',
  'America/New_York',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Istanbul',
  'Asia/Kolkata',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
];

/** Format a moment in a specific IANA time zone. Returns "" for invalid zones. */
export function formatInZone(date: Date, timeZone: string, locale?: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone,
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZoneName: 'short',
    }).format(date);
  } catch {
    return '';
  }
}

export function relativeTime(date: Date, now: Date = new Date(), locale?: string): string {
  const diffMs = date.getTime() - now.getTime();
  const abs = Math.abs(diffMs);
  const units: [number, Intl.RelativeTimeFormatUnit][] = [
    [1000 * 60 * 60 * 24 * 365, 'year'],
    [1000 * 60 * 60 * 24 * 30, 'month'],
    [1000 * 60 * 60 * 24, 'day'],
    [1000 * 60 * 60, 'hour'],
    [1000 * 60, 'minute'],
    [1000, 'second'],
  ];
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [ms, unit] of units) {
    if (abs >= ms || unit === 'second') {
      return rtf.format(Math.round(diffMs / ms), unit);
    }
  }
  return 'now';
}
