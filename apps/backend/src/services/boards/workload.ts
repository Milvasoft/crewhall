import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import {
  boardCards,
  boardSprints,
  boards,
  cardAssignees,
  nodes,
  spaceMembers,
  type DbOrTx,
} from '@crewhall/db';
import {
  DEFAULT_CAPACITY_HOURS,
  type UserSummary,
  type Workload,
  type WorkloadCell,
} from '@crewhall/shared';
import { loadSpace, requireNodeAction, type DriveActor } from '../drive/access';
import { loadBoard, nodeAudience, userSummaries } from './access';
import { daysBetween } from './sprints';

/**
 * Workload (kararlar 2026-10-29): estimated hours of open, assigned cards per person and
 * week. A card's estimate spreads evenly over the days from its start to its due date
 * (one date: that day; none: its open sprint's dates) and splits between its assignees.
 * Cards without an estimate are counted in the cells they touch, never guessed.
 */

const DAY = 86_400_000;

function zoneOrUtc(tz: string | undefined) {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

/** Monday of the week holding an ISO date. */
export function mondayOf(iso: string) {
  const t = Date.parse(`${iso}T00:00:00Z`);
  const weekday = (new Date(t).getUTCDay() + 6) % 7;
  return new Date(t - weekday * DAY).toISOString().slice(0, 10);
}

const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

const emptyCell = (): WorkloadCell => ({ hours: 0, cardIds: [], unestimated: 0 });

async function compute(
  db: DbOrTx,
  boardIds: string[],
  audience: UserSummary[],
  capacityHours: number,
  q: { from?: string | undefined; weeks: number; tz?: string | undefined },
): Promise<Workload> {
  const zone = zoneOrUtc(q.tz);
  const dayOf = (d: Date) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  const first = mondayOf(q.from ?? dayOf(new Date()));
  const weeks = Array.from({ length: q.weeks }, (_, i) => addDays(first, i * 7));
  const end = addDays(first, q.weeks * 7 - 1);

  const rows =
    boardIds.length === 0
      ? []
      : await db
          .select({ card: boardCards, settings: boards.settings, sprint: boardSprints })
          .from(boardCards)
          .innerJoin(boards, eq(boards.nodeId, boardCards.boardNodeId))
          .innerJoin(nodes, eq(nodes.id, boardCards.boardNodeId))
          .leftJoin(
            boardSprints,
            and(eq(boardSprints.id, boardCards.sprintId), ne(boardSprints.status, 'closed')),
          )
          .where(
            and(
              inArray(boardCards.boardNodeId, boardIds),
              isNull(boardCards.deletedAt),
              isNull(boardCards.archivedAt),
              isNull(boardCards.doneAt),
              isNull(nodes.deletedAt),
            ),
          );
  const assignees =
    rows.length === 0
      ? []
      : await db
          .select({ cardId: cardAssignees.cardId, userId: cardAssignees.userId })
          .from(cardAssignees)
          .where(
            inArray(
              cardAssignees.cardId,
              rows.map((r) => r.card.id),
            ),
          );
  const byCard = new Map<string, string[]>();
  for (const a of assignees) byCard.set(a.cardId, [...(byCard.get(a.cardId) ?? []), a.userId]);

  const people = new Map<string, { cells: WorkloadCell[]; undated: WorkloadCell }>();
  const row = (userId: string) => {
    let p = people.get(userId);
    if (!p) {
      p = { cells: weeks.map(emptyCell), undated: emptyCell() };
      people.set(userId, p);
    }
    return p;
  };
  for (const u of audience) row(u.id);

  const shown = new Set<string>();
  const add = (cell: WorkloadCell, cardId: string, hours: number | null) => {
    if (!cell.cardIds.includes(cardId)) {
      cell.cardIds.push(cardId);
      if (hours === null) cell.unestimated++;
    }
    cell.hours += hours ?? 0;
    shown.add(cardId);
  };

  for (const { card, sprint } of rows) {
    const who = byCard.get(card.id) ?? [];
    if (who.length === 0) continue;
    const hours = card.estimateMinutes !== null ? card.estimateMinutes / 60 : null;
    let from = card.startAt ? dayOf(card.startAt) : card.dueAt ? dayOf(card.dueAt) : null;
    let to = card.dueAt ? dayOf(card.dueAt) : from;
    if (!from && sprint) {
      from = sprint.startsOn;
      to = sprint.endsOn;
    }
    if (!from || !to) {
      for (const u of who) add(row(u).undated, card.id, hours === null ? null : hours / who.length);
      continue;
    }
    if (to < first || from > end) continue;
    const days = daysBetween(from, to);
    for (const u of who) {
      const p = row(u);
      weeks.forEach((w, i) => {
        const inWeek = days.filter((d) => d >= w && d <= addDays(w, 6)).length;
        if (inWeek === 0) return;
        add(
          p.cells[i]!,
          card.id,
          hours === null ? null : (hours * inWeek) / days.length / who.length,
        );
      });
    }
  }

  const users = await userSummaries(db, [...people.keys()]);
  const round = (c: WorkloadCell) => ({ ...c, hours: Math.round(c.hours * 10) / 10 });
  return {
    weeks,
    capacityHours,
    people: [...people.entries()]
      .flatMap(([id, p]) => {
        const user = users.get(id);
        return user ? [{ user, cells: p.cells.map(round), undated: round(p.undated) }] : [];
      })
      .sort((x, y) => x.user.name.localeCompare(y.user.name, 'tr')),
    cards: rows
      .filter((r) => shown.has(r.card.id))
      .map((r) => ({
        id: r.card.id,
        boardId: r.card.boardNodeId,
        key: `${r.settings.key}-${r.card.number}`,
        title: r.card.title,
        estimateMinutes: r.card.estimateMinutes,
      })),
  };
}

export async function boardWorkload(
  db: DbOrTx,
  a: DriveActor,
  boardId: string,
  q: { from?: string | undefined; weeks: number; tz?: string | undefined },
) {
  const access = await loadBoard(db, a, boardId);
  return compute(
    db,
    [boardId],
    await nodeAudience(db, access.node),
    access.board.settings.capacityHours ?? DEFAULT_CAPACITY_HOURS,
    q,
  );
}

/** Every live board of the space; its members are the rows. */
export async function spaceWorkload(
  db: DbOrTx,
  a: DriveActor,
  spaceId: string,
  q: { from?: string | undefined; weeks: number; tz?: string | undefined },
) {
  const { role } = await loadSpace(db, a, spaceId);
  requireNodeAction(a, role, 'space.view');
  const boardRows = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.spaceId, spaceId), eq(nodes.type, 'board'), isNull(nodes.deletedAt)));
  const members = await db
    .select({ id: spaceMembers.userId })
    .from(spaceMembers)
    .where(eq(spaceMembers.spaceId, spaceId));
  const audience = [
    ...(
      await userSummaries(
        db,
        members.map((m) => m.id),
      )
    ).values(),
  ];
  return compute(
    db,
    boardRows.map((b) => b.id),
    audience,
    DEFAULT_CAPACITY_HOURS,
    q,
  );
}
