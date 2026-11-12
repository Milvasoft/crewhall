import { type BoardCard, type BoardDetail } from '@crewhall/shared';
import { z } from 'zod';

/**
 * Board filters live in the address (design 6.4): a shared link opens the same view, and
 * the filter stays personal. `person=me,none,<userId>`, `tag=<labelId>,…`,
 * `date=overdue|week|month|none`, `q=` search, `view=list`, `group=person|tag`.
 */

// The router hands back what it validated before (arrays) as well as raw strings.
const csv = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => {
    const out = (typeof v === 'string' ? v.split(',') : v).filter(Boolean);
    return out.length ? out : undefined;
  })
  .optional();

export const DUE_FILTERS = ['overdue', 'week', 'month', 'none'] as const;

/** Views besides the kanban (the default): `view=list|backlog|timeline|workload`. */
export const BOARD_VIEWS = ['list', 'backlog', 'timeline', 'workload'] as const;
export type BoardView = 'board' | (typeof BOARD_VIEWS)[number];

export const boardSearch = z.object({
  person: csv,
  tag: csv,
  date: z.enum(DUE_FILTERS).optional().catch(undefined),
  q: z.string().optional(),
  view: z.enum(BOARD_VIEWS).optional().catch(undefined),
  group: z.enum(['person', 'tag']).optional().catch(undefined),
});

export type BoardSearchIn = z.input<typeof boardSearch>;
export type BoardSearch = z.output<typeof boardSearch>;

export const ME = 'me';
export const NOBODY = 'none';

/** Search object back to the address form (comma lists). */
export function toSearch(s: BoardSearch): BoardSearchIn {
  return {
    person: s.person?.length ? s.person.join(',') : undefined,
    tag: s.tag?.length ? s.tag.join(',') : undefined,
    date: s.date,
    q: s.q || undefined,
    view: s.view,
    group: s.group,
  };
}

export function hasFilters(s: BoardSearch): boolean {
  return Boolean(s.person?.length || s.tag?.length || s.date || s.q?.trim());
}

const DAY = 86_400_000;

/** Turkish-aware lower case for search. */
const fold = (v: string) => v.toLocaleLowerCase('tr');

export function matches(
  card: BoardCard,
  s: BoardSearch,
  ctx: { meId: string; key: string; now?: number },
): boolean {
  if (s.person?.length) {
    const ids = card.assignees.map((u) => u.id);
    const ok = s.person.some((k) =>
      k === ME ? ids.includes(ctx.meId) : k === NOBODY ? ids.length === 0 : ids.includes(k),
    );
    if (!ok) return false;
  }
  if (s.tag?.length && !s.tag.some((l) => card.labels.includes(l))) return false;
  if (s.date) {
    const now = ctx.now ?? Date.now();
    const due = card.dueAt ? Date.parse(card.dueAt) : null;
    if (s.date === 'none' && due !== null) return false;
    if (s.date === 'overdue' && (due === null || due >= now)) return false;
    if (s.date === 'week' && (due === null || due > now + 7 * DAY)) return false;
    if (s.date === 'month' && (due === null || due > now + 31 * DAY)) return false;
  }
  const q = s.q?.trim();
  if (q) {
    const hay = fold(`${ctx.key}-${card.number} ${card.title} ${card.excerpt}`);
    if (
      !fold(q)
        .split(/\s+/)
        .every((w) => hay.includes(w))
    ) {
      return false;
    }
  }
  return true;
}

/**
 * While a sprint runs, the kanban and the list show its cards only; the backlog and the
 * timeline show everything. Cards from servers before sprints (no `sprintId`) always show.
 */
export function sprintScope(d: BoardDetail): BoardDetail {
  const active = d.sprints?.find((x) => x.status === 'active');
  if (!active) return d;
  return {
    ...d,
    cards: d.cards.filter((c) => c.sprintId === undefined || c.sprintId === active.id),
  };
}

export function visibleCards(d: BoardDetail, s: BoardSearch, meId: string): BoardCard[] {
  const key = d.board.settings.key;
  return d.cards.filter((c) => matches(c, s, { meId, key }));
}

/** Due state of a card: shown in warning colour when close, danger when past (6.1). */
export function dueState(dueAt: string | null, now = Date.now()) {
  if (!dueAt) return null;
  const t = Date.parse(dueAt);
  const days = Math.floor((t - now) / DAY);
  if (t < now) return { tone: 'danger' as const, days: Math.max(1, Math.ceil((now - t) / DAY)) };
  if (days <= 2) return { tone: 'warn' as const, days };
  return { tone: 'none' as const, days };
}

export const cardRef = (key: string, n: number) => `${key}-${n}`;
