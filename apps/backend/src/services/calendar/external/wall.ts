import { occurrenceKey, safeZone, zonedParts, zonedToUtc, type WallTime } from '@crewhall/shared';
import { resolveTzid } from '../ics';
import type { ExtTime } from './types';

/** An IANA zone from what a provider sends (IANA, Windows names), UTC as the last resort. */
export const zoneOf = (...names: (string | null | undefined)[]) => {
  for (const n of names) {
    const z = resolveTzid(n ?? undefined);
    if (z) return safeZone(z);
  }
  return 'UTC';
};

/** `2026-10-28T09:00:00(.0000000)` → wall-clock parts; null when malformed. */
export function parseWall(s: string): WallTime | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (!m) return null;
  return {
    year: +m[1]!,
    month: +m[2]!,
    day: +m[3]!,
    hour: +m[4]!,
    minute: +m[5]!,
    second: +(m[6] ?? 0),
  };
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Wall-clock text of an instant in a zone, without offset (Graph's dateTime). */
export function formatWall(at: Date, tz: string): string {
  const p = zonedParts(at, tz);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/** Local date of an instant in a zone. */
export function wallDate(at: Date, tz: string): string {
  return formatWall(at, tz).slice(0, 10);
}

/** The occurrence key (`occurrenceKey`) of a start. */
export const keyOf = (t: ExtTime) => (t.allDay ? t.date : occurrenceKey(t.at, false));

/** Wire start/end text of an ExtTime (`YYYY-MM-DD` or ISO). */
export const wireOf = (t: ExtTime) => (t.allDay ? t.date : t.at.toISOString());

/** iCalendar basic date or date-time (`20261028`, `20261028T090000`, `…Z`) in a zone. */
export function parseBasic(v: string, tz: string): ExtTime | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (h === undefined) return { allDay: true, date: `${y}-${mo}-${d}` };
  if (z) return { allDay: false, at: new Date(Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!)) };
  return {
    allDay: false,
    at: zonedToUtc({ year: +y!, month: +mo!, day: +d!, hour: +h!, minute: +mi!, second: +s! }, tz),
  };
}

/** A key as iCalendar basic text: `20261028` or `20261028T060000Z`. */
export function basicOf(key: string): string {
  if (key.length === 10) return key.replace(/-/g, '');
  return new Date(key)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}
