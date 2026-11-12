/** Finds a date (and a time) in selected text, to start a calendar event from. */

const MONTHS: Record<string, number> = {
  ocak: 0,
  şubat: 1,
  mart: 2,
  nisan: 3,
  mayıs: 4,
  haziran: 5,
  temmuz: 6,
  ağustos: 7,
  eylül: 8,
  ekim: 9,
  kasım: 10,
  aralık: 11,
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sep: 8,
  sept: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11,
};

export interface FoundDate {
  date: Date;
  hasTime: boolean;
}

const NAME = Object.keys(MONTHS).join('|');

function make(year: number | null, month: number, day: number, now: Date): Date | null {
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  let y = year ?? now.getFullYear();
  if (y < 100) y += 2000;
  const d = new Date(y, month, day);
  if (d.getMonth() !== month) return null;
  // No year written and the day has passed: the next one is meant.
  if (year === null && d.getTime() < new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) {
    d.setFullYear(y + 1);
  }
  return d;
}

function dateIn(text: string, now: Date): Date | null {
  const iso = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(text);
  if (iso) return make(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), now);
  const dotted = /\b(\d{1,2})[./](\d{1,2})[./](\d{2,4})\b/.exec(text);
  if (dotted) return make(Number(dotted[3]), Number(dotted[2]) - 1, Number(dotted[1]), now);
  const dayFirst = new RegExp(`\\b(\\d{1,2})\\s+(${NAME})\\b(?:\\s+(\\d{4}))?`, 'iu').exec(text);
  if (dayFirst) {
    return make(
      dayFirst[3] ? Number(dayFirst[3]) : null,
      MONTHS[dayFirst[2]!.toLocaleLowerCase('tr')] ?? MONTHS[dayFirst[2]!.toLowerCase()] ?? -1,
      Number(dayFirst[1]),
      now,
    );
  }
  const monthFirst = new RegExp(`\\b(${NAME})\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?\\b`, 'iu').exec(text);
  if (monthFirst) {
    return make(
      monthFirst[3] ? Number(monthFirst[3]) : null,
      MONTHS[monthFirst[1]!.toLocaleLowerCase('tr')] ?? MONTHS[monthFirst[1]!.toLowerCase()] ?? -1,
      Number(monthFirst[2]),
      now,
    );
  }
  return null;
}

export function findDate(text: string, now: Date = new Date()): FoundDate | null {
  const date = dateIn(text, now);
  if (!date) return null;
  const time = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\b(?![./]\d)/.exec(
    // The date itself may look like a time ("12.03"): only what follows it counts when dotted.
    text.replace(/\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b/g, ' ').replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g, ' '),
  );
  if (!time) return { date, hasTime: false };
  date.setHours(Number(time[1]), Number(time[2]), 0, 0);
  return { date, hasTime: true };
}

/** Value for an `<input type="datetime-local">` in local time. */
export function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
