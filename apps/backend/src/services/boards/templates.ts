import { resources, type AppLocale } from '@crewhall/i18n';
import type { BoardSettingsData } from '@crewhall/db';
import type { BoardTemplate, LabelColor } from '@crewhall/shared';
import { DONE_ARCHIVE_DAYS, dayToDate, safeZone, zonedDay } from '@crewhall/shared';

/**
 * Board templates (design 6.7): columns, labels, WIP limits and fields, never cards.
 * Names come from email/boards.json so a Turkish org gets Turkish column names.
 */

interface ColumnSpec {
  name: string;
  wipLimit: number | null;
  isDone: boolean;
}

const LABEL_COLORS: LabelColor[] = ['s1', 's2', 's4', 'danger', 's5', 'info', 's3', 'warning'];

/** WIP limits per template column index (the rest have none). */
const WIP: Record<BoardTemplate, Record<number, number>> = {
  empty: {},
  sprint: { 1: 3 },
  roadmap: { 2: 3, 3: 4 },
  bugs: { 2: 2 },
};

export function templateColumns(template: BoardTemplate, locale: AppLocale): ColumnSpec[] {
  const names: readonly string[] = resources[locale].email.boards.templates[template].columns;
  return names.map((name, i) => ({
    name,
    wipLimit: WIP[template][i] ?? null,
    isDone: i === names.length - 1,
  }));
}

/** The sprint template's first sprint: two weeks, both ends included. */
const SPRINT_DAYS = 14;

/** `timeZone` is the creator's: the first sprint starts on their today, not UTC's. */
export function templateSettings(
  template: BoardTemplate,
  locale: AppLocale,
  input: { key: string; cardChats: boolean; timeZone?: string },
  now = new Date(),
): BoardSettingsData {
  const labels: readonly string[] = resources[locale].email.boards.templates[template].labels;
  const today = zonedDay(now, safeZone(input.timeZone));
  return {
    key: input.key,
    template,
    labels: labels.map((name, i) => ({
      id: `l${i + 1}`,
      name,
      color: LABEL_COLORS[i % LABEL_COLORS.length]!,
    })),
    cardChats: input.cardChats,
    fields: { points: template === 'sprint', priority: template === 'bugs' },
    doneArchiveDays: DONE_ARCHIVE_DAYS,
    sprint:
      template === 'sprint'
        ? {
            name: resources[locale].email.boards.sprintName,
            startsOn: dayToDate(today),
            endsOn: dayToDate(today + SPRINT_DAYS - 1),
          }
        : null,
  };
}

const ASCII: Record<string, string> = { ç: 'C', ğ: 'G', ı: 'I', i: 'I', ö: 'O', ş: 'S', ü: 'U' };

/** "Milvaion Yol Haritası" → "MIL"; editable later in the board settings. */
export function deriveKey(name: string): string {
  const letters = [...name.toLocaleLowerCase('tr')]
    .map((ch) => ASCII[ch] ?? ch.toUpperCase())
    .join('')
    .replace(/[^A-Z0-9 ]/g, '')
    .trim();
  const first = letters.split(/\s+/)[0] ?? '';
  const key = /^[A-Z]/.test(first) ? first.slice(0, 3) : '';
  return key.length >= 2 ? key : 'KRT';
}
