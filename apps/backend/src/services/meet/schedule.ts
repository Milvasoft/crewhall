import type { MeetingRecurrence } from '@crewhall/shared';

const DAY_MS = 86_400_000;

/** Local calendar parts of `date` in an IANA zone. */
function partsIn(date: Date, timeZone: string) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday ?? '');
  return {
    key: `${p.year}-${p.month}-${p.day}`,
    weekday,
  };
}

export function safeTimeZone(tz: string | undefined | null): string {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

const isWeekday = (d: number) => d >= 1 && d <= 5;

/**
 * Occurrences of a (possibly recurring) meeting are the first start shifted by whole days,
 * so the wall-clock time stays the same in UTC; good enough without DST-aware rules.
 * Returns the first occurrence that has not ended before `now`.
 */
export function nextOccurrence(
  firstStart: Date,
  durationMinutes: number,
  recurrence: MeetingRecurrence,
  now: Date,
  timeZone = 'UTC',
): Date | null {
  const end = (d: Date) => d.getTime() + durationMinutes * 60_000;
  if (recurrence === 'none') return end(firstStart) >= now.getTime() ? firstStart : null;
  if (end(firstStart) >= now.getTime()) return firstStart;
  const step = recurrence === 'weekly' ? 7 : 1;
  const behindDays = Math.floor((now.getTime() - end(firstStart)) / DAY_MS);
  let n = Math.max(1, Math.floor(behindDays / step) * step);
  for (let i = 0; i < 400; i++, n += step) {
    const candidate = new Date(firstStart.getTime() + n * DAY_MS);
    if (end(candidate) < now.getTime()) continue;
    if (recurrence === 'weekdays' && !isWeekday(partsIn(candidate, timeZone).weekday)) continue;
    return candidate;
  }
  return null;
}

/** Is `date` on the same local calendar day as `now`? */
export function sameLocalDay(date: Date, now: Date, timeZone: string): boolean {
  return partsIn(date, timeZone).key === partsIn(now, timeZone).key;
}
