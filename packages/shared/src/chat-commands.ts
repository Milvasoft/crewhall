/**
 * Chat slash commands (roadmap 23), shared by web and mobile so both read a line the same
 * way. Only a known command as the first word counts; anything else is sent as plain text.
 */

export const CHAT_COMMANDS = ['meet', 'remind', 'poll', 'me', 'whisper', 'zamanla', 'gif'] as const;
export type ChatCommand = (typeof CHAT_COMMANDS)[number];

const KNOWN = new Set<string>(CHAT_COMMANDS);

/** `/remind 15dk toplantı` → { command: 'remind', rest: '15dk toplantı' }; else null. */
export function parseSlashCommand(text: string): { command: ChatCommand; rest: string } | null {
  const m = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(text.trimStart());
  if (!m) return null;
  const name = m[1]!.toLowerCase();
  if (!KNOWN.has(name)) return null;
  return { command: name as ChatCommand, rest: (m[2] ?? '').trim() };
}

// ---- /remind ------------------------------------------------------------------------

const MINUTE = 60_000;
const UNITS: [RegExp, number][] = [
  [/^(dk|dak|dakika|m|min|mins|minute|minutes)$/, MINUTE],
  [/^(sa|saat|h|hr|hrs|hour|hours)$/, 60 * MINUTE],
  [/^(g|gün|gun|d|day|days)$/, 24 * 60 * MINUTE],
  [/^(hf|hafta|w|week|weeks)$/, 7 * 24 * 60 * MINUTE],
];

const unitMs = (word: string) => UNITS.find(([re]) => re.test(word))?.[1] ?? null;

/** Monday = 1 … Sunday = 0 (Date#getDay). */
const WEEKDAYS: Record<string, number> = {
  pazar: 0,
  pazartesi: 1,
  salı: 2,
  sali: 2,
  çarşamba: 3,
  carsamba: 3,
  perşembe: 4,
  persembe: 4,
  cuma: 5,
  cumartesi: 6,
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/** Turkish case endings after a time or day: "9'da", "yarın'a", "15:30'ta". */
const stripSuffix = (w: string) => w.replace(/['’](d[ae]|t[ae]|[ae]|y[ae])$/u, '');

function parseClock(word: string): { h: number; m: number } | null {
  const ampm = /^(\d{1,2})(?:[:.](\d{2}))?(am|pm)$/.exec(word);
  if (ampm) {
    let h = Number(ampm[1]);
    const m = Number(ampm[2] ?? 0);
    if (h < 1 || h > 12 || m > 59) return null;
    if (ampm[3] === 'pm' && h < 12) h += 12;
    if (ampm[3] === 'am' && h === 12) h = 0;
    return { h, m };
  }
  const c = /^(\d{1,2})(?:[:.](\d{2}))?$/.exec(word);
  if (!c) return null;
  const h = Number(c[1]);
  const m = Number(c[2] ?? 0);
  if (h > 23 || m > 59) return null;
  return { h, m };
}

/** "dd/mm", "dd/mm/yyyy" or "dd.mm.yyyy" (two-part dots read as a time: "9.30"). */
function parseDate(word: string, now: Date): Date | null {
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(word);
  if (iso) {
    const [y, mo, da] = [Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])];
    const out = new Date(y, mo, da);
    return out.getMonth() === mo && out.getDate() === da ? out : null;
  }
  const d =
    /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(word) ??
    /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/.exec(word);
  if (!d) return null;
  const day = Number(d[1]);
  const month = Number(d[2]) - 1;
  let year = d[3] ? Number(d[3]) : now.getFullYear();
  if (year < 100) year += 2000;
  const out = new Date(year, month, day);
  if (out.getMonth() !== month || out.getDate() !== day) return null;
  // No year and already past: next year.
  if (
    !d[3] &&
    out.getTime() < new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  ) {
    out.setFullYear(year + 1);
  }
  return out;
}

/**
 * `/remind` text → when and what, in the device's time zone:
 * - relative: "15dk toplantı", "2 saat 30 dk …", "1d …", "in 10 minutes …"
 * - absolute: "yarın 9:00 …", "cuma 14.30 …", "bugün 17'de …", "25/12 10:00 …", "18:00 …"
 *   (a day without a time means 09:00; a time without a day means the next such time)
 * Returns null when no time is found or it is not in the future.
 */
export function parseWhen(
  input: string,
  now: Date = new Date(),
): { at: Date; text: string } | null {
  const words = input.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  const lower = (k: number) => stripSuffix((words[k] ?? '').toLocaleLowerCase('tr'));
  // "/remind me in 15 minutes …", "/remind bana 15dk …"
  if (['me', 'bana'].includes(lower(i))) i++;
  if (['in', 'içinde'].includes(lower(i))) i++;

  // Relative: one or more "<n><unit>" / "<n> <unit>" pairs.
  let offset = 0;
  for (;;) {
    const w = lower(i);
    const joined = /^(\d+)([\p{L}]+)$/u.exec(w);
    if (joined && unitMs(joined[2]!) !== null) {
      offset += Number(joined[1]) * unitMs(joined[2]!)!;
      i++;
      continue;
    }
    if (/^\d+$/.test(w) && unitMs(lower(i + 1)) !== null) {
      offset += Number(w) * unitMs(lower(i + 1))!;
      i += 2;
      continue;
    }
    break;
  }
  if (offset > 0) {
    if (['sonra', 'later'].includes(lower(i))) i++;
    return finish(new Date(now.getTime() + offset), words.slice(i), now);
  }

  // Absolute: optional day, then optional "saat"/"at" and a time.
  let day: Date | null = null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const w0 = lower(i);
  if (w0 === 'bugün' || w0 === 'bugun' || w0 === 'today') {
    day = today;
    i++;
  } else if (['öbürgün', 'öbür', 'obur', 'ertesi'].includes(w0) && lower(i + 1) === 'gün') {
    day = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 2);
    i += 2;
  } else if (w0 === 'öbürgün' || w0 === 'oburgun') {
    day = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 2);
    i++;
  } else if (w0 === 'day' && lower(i + 1) === 'after' && lower(i + 2) === 'tomorrow') {
    day = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 2);
    i += 3;
  } else if (w0 === 'yarın' || w0 === 'yarin' || w0 === 'tomorrow') {
    day = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    i++;
  } else if (w0 in WEEKDAYS) {
    const ahead = (WEEKDAYS[w0]! - today.getDay() + 7) % 7 || 7;
    day = new Date(today.getFullYear(), today.getMonth(), today.getDate() + ahead);
    i++;
  } else {
    const d = parseDate(w0, now);
    if (d) {
      day = d;
      i++;
    }
  }
  if (['saat', 'at'].includes(lower(i)) && parseClock(lower(i + 1))) i++;
  // A bare number is a time only after a day word or "saat"/"at" ("5 elma" is not 05:00).
  const w1 = lower(i);
  const clock = parseClock(w1);
  const explicit =
    clock &&
    (day !== null || /[:.]|am|pm/.test(w1) || lower(i - 1) === 'saat' || lower(i - 1) === 'at');
  if (explicit) i++;
  if (!day && !explicit) return null;
  const base = day ?? today;
  const at = new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate(),
    explicit ? clock.h : 9,
    explicit ? clock.m : 0,
  );
  // A time alone that already passed today means tomorrow.
  if (!day && at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return finish(at, words.slice(i), now);
}

/** `/remind` reads its time with the same rules. */
export const parseReminder = parseWhen;

function finish(at: Date, rest: string[], now: Date) {
  if (at.getTime() <= now.getTime()) return null;
  return { at, text: rest.join(' ').trim() };
}

// ---- /poll --------------------------------------------------------------------------

/** "Öğle yemeği? | Pizza | Döner" → question and options (the dialog fills in the rest). */
export function parsePollInput(input: string): { question: string; options: string[] } {
  const parts = input
    .split(/\s*\|\s*|\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  return { question: parts[0] ?? '', options: parts.slice(1) };
}
