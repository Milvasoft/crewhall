import { and, asc, count, eq, inArray, isNull, ne } from 'drizzle-orm';
import { boardCards, boardSprints, type BoardSettingsData, type DbOrTx } from '@crewhall/db';
import type {
  BoardSprint,
  CreateSprint,
  Sprint,
  SprintBurndown,
  SprintUnit,
  UpdateSprint,
} from '@crewhall/shared';
import type { z } from 'zod';
import { AppError } from '../../http/errors';
import type { DriveActor } from '../drive/access';
import { loadBoard, requireManage, requireRole, touchBoard, type BoardAccess } from './access';
import { announce } from './boards';

/**
 * Sprints of a board (kararlar 2026-10-29 "Panolarda proje yönetimi"). Planned and active
 * sprints hold cards; a card without a sprint is in the backlog. At most one sprint is active
 * (a partial unique index backs it); the board's `settings.sprint` mirrors that one.
 */

export type SprintRow = typeof boardSprints.$inferSelect;

/** Sprints a board keeps; closed ones count too. */
export const SPRINTS_PER_BOARD = 500;

export const sprintUnit = (settings: Pick<BoardSettingsData, 'fields'>): SprintUnit =>
  settings.fields.points ? 'points' : 'cards';

const weightOf = (unit: SprintUnit, card: { points: number | null }) =>
  unit === 'points' ? (card.points ?? 0) : 1;

export async function activeSprint(db: DbOrTx, boardId: string): Promise<SprintRow | null> {
  const [row] = await db
    .select()
    .from(boardSprints)
    .where(and(eq(boardSprints.boardNodeId, boardId), eq(boardSprints.status, 'active')));
  return row ?? null;
}

/** The legacy single sprint of `settings.sprint`, read from the active one. */
export const legacySprint = (row: SprintRow | null): BoardSprint | null =>
  row ? { name: row.name, startsOn: row.startsOn, endsOn: row.endsOn } : null;

export async function toSprints(db: DbOrTx, rows: SprintRow[]): Promise<Sprint[]> {
  if (rows.length === 0) return [];
  const counts = await db
    .select({ sprintId: boardCards.sprintId, n: count() })
    .from(boardCards)
    .where(
      and(
        inArray(
          boardCards.sprintId,
          rows.map((r) => r.id),
        ),
        isNull(boardCards.deletedAt),
      ),
    )
    .groupBy(boardCards.sprintId);
  const n = new Map(counts.map((c) => [c.sprintId, Number(c.n)]));
  return rows.map((r) => ({
    id: r.id,
    boardId: r.boardNodeId,
    name: r.name,
    goal: r.goal,
    startsOn: r.startsOn,
    endsOn: r.endsOn,
    status: r.status,
    startedAt: r.startedAt?.toISOString() ?? null,
    closedAt: r.closedAt?.toISOString() ?? null,
    result: r.result ?? null,
    cardCount: n.get(r.id) ?? 0,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** Planned and active sprints in the order they run: the board detail and planning. */
export async function openSprints(db: DbOrTx, boardId: string): Promise<Sprint[]> {
  const rows = await db
    .select()
    .from(boardSprints)
    .where(and(eq(boardSprints.boardNodeId, boardId), ne(boardSprints.status, 'closed')))
    .orderBy(asc(boardSprints.startsOn), asc(boardSprints.createdAt));
  return toSprints(db, rows);
}

export async function listSprints(db: DbOrTx, a: DriveActor, boardId: string) {
  await loadBoard(db, a, boardId);
  const rows = await db
    .select()
    .from(boardSprints)
    .where(eq(boardSprints.boardNodeId, boardId))
    .orderBy(asc(boardSprints.startsOn), asc(boardSprints.createdAt));
  return { items: await toSprints(db, rows) };
}

async function loadSprint(db: DbOrTx, a: DriveActor, sprintId: string) {
  const [sprint] = await db
    .select()
    .from(boardSprints)
    .where(and(eq(boardSprints.id, sprintId), eq(boardSprints.orgId, a.org.id)));
  if (!sprint) throw new AppError('not_found');
  const access = await loadBoard(db, a, sprint.boardNodeId, { forUpdate: true });
  return { sprint, access };
}

async function reload(db: DbOrTx, id: string) {
  const [row] = await db.select().from(boardSprints).where(eq(boardSprints.id, id));
  return (await toSprints(db, [row!]))[0]!;
}

async function changed(db: DbOrTx, a: DriveActor, access: BoardAccess) {
  announce(access.node, await touchBoard(db, access.node.id, a.userId));
}

export async function createSprint(
  db: DbOrTx,
  a: DriveActor,
  boardId: string,
  input: z.output<typeof CreateSprint>,
): Promise<Sprint> {
  const access = await loadBoard(db, a, boardId, { forUpdate: true });
  requireRole(a, access.role, 'edit');
  const [n] = await db
    .select({ n: count() })
    .from(boardSprints)
    .where(eq(boardSprints.boardNodeId, boardId));
  if (Number(n?.n ?? 0) >= SPRINTS_PER_BOARD) {
    throw new AppError('board_limit_reached', { sprints: SPRINTS_PER_BOARD });
  }
  const [row] = await db
    .insert(boardSprints)
    .values({
      orgId: a.org.id,
      boardNodeId: boardId,
      name: input.name,
      goal: input.goal,
      startsOn: input.startsOn,
      endsOn: input.endsOn,
      createdBy: a.userId,
    })
    .returning();
  await changed(db, a, access);
  return (await toSprints(db, [row!]))[0]!;
}

export async function updateSprint(
  db: DbOrTx,
  a: DriveActor,
  sprintId: string,
  input: z.output<typeof UpdateSprint>,
): Promise<Sprint> {
  const { sprint, access } = await loadSprint(db, a, sprintId);
  requireRole(a, access.role, 'edit');
  if (sprint.status === 'closed') throw new AppError('board_sprint_state', { status: 'closed' });
  const startsOn = input.startsOn ?? sprint.startsOn;
  const endsOn = input.endsOn ?? sprint.endsOn;
  if (endsOn < startsOn) throw new AppError('validation_failed', { field: 'endsOn' });
  await db
    .update(boardSprints)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.goal !== undefined ? { goal: input.goal } : {}),
      startsOn,
      endsOn,
    })
    .where(eq(boardSprints.id, sprintId));
  await changed(db, a, access);
  return reload(db, sprintId);
}

/** Only a planned sprint is deleted; its cards go back to the backlog. */
export async function deleteSprint(db: DbOrTx, a: DriveActor, sprintId: string) {
  const { sprint, access } = await loadSprint(db, a, sprintId);
  requireRole(a, access.role, 'edit');
  if (sprint.status !== 'planned') {
    throw new AppError('board_sprint_state', { status: sprint.status });
  }
  await db
    .update(boardCards)
    .set({ sprintId: null, sprintAddedAt: null })
    .where(eq(boardCards.sprintId, sprintId));
  await db.delete(boardSprints).where(eq(boardSprints.id, sprintId));
  await changed(db, a, access);
}

export async function startSprint(db: DbOrTx, a: DriveActor, sprintId: string): Promise<Sprint> {
  const { sprint, access } = await loadSprint(db, a, sprintId);
  requireManage(a, access);
  if (sprint.status !== 'planned') {
    throw new AppError('board_sprint_state', { status: sprint.status });
  }
  const active = await activeSprint(db, access.node.id);
  if (active) throw new AppError('board_sprint_active', { sprintId: active.id });
  await db
    .update(boardSprints)
    .set({ status: 'active', startedAt: new Date() })
    .where(eq(boardSprints.id, sprintId));
  await changed(db, a, access);
  return reload(db, sprintId);
}

/**
 * Closes the active sprint: its result is kept, unfinished cards (not done, not archived)
 * move to `moveTo` (a planned sprint of the board) or to the backlog.
 */
export async function closeSprint(
  db: DbOrTx,
  a: DriveActor,
  sprintId: string,
  moveTo: string | null,
): Promise<{ sprint: Sprint; moved: number }> {
  const { sprint, access } = await loadSprint(db, a, sprintId);
  requireManage(a, access);
  if (sprint.status !== 'active') {
    throw new AppError('board_sprint_state', { status: sprint.status });
  }
  const moved = await closeRow(db, access, sprint, moveTo);
  await changed(db, a, access);
  return { sprint: await reload(db, sprintId), moved };
}

async function closeRow(db: DbOrTx, access: BoardAccess, sprint: SprintRow, moveTo: string | null) {
  if (moveTo) await assertSprintTarget(db, access.node.id, moveTo, { plannedOnly: true });
  const unit = sprintUnit(access.board.settings);
  const cards = await db
    .select({
      id: boardCards.id,
      points: boardCards.points,
      doneAt: boardCards.doneAt,
      archivedAt: boardCards.archivedAt,
    })
    .from(boardCards)
    .where(and(eq(boardCards.sprintId, sprint.id), isNull(boardCards.deletedAt)));
  const total = cards.reduce((s, c) => s + weightOf(unit, c), 0);
  const done = cards.filter((c) => c.doneAt).reduce((s, c) => s + weightOf(unit, c), 0);
  const open = cards.filter((c) => !c.doneAt && !c.archivedAt).map((c) => c.id);
  if (open.length) {
    await db
      .update(boardCards)
      .set({ sprintId: moveTo, sprintAddedAt: moveTo ? new Date() : null })
      .where(inArray(boardCards.id, open));
  }
  await db
    .update(boardSprints)
    .set({ status: 'closed', closedAt: new Date(), result: { unit, done, total } })
    .where(eq(boardSprints.id, sprint.id));
  return open.length;
}

/** A sprint a card may be planned in: planned or active, on the same board. */
export async function assertSprintTarget(
  db: DbOrTx,
  boardId: string,
  sprintId: string,
  opts: { plannedOnly?: boolean } = {},
) {
  const [row] = await db
    .select({ status: boardSprints.status })
    .from(boardSprints)
    .where(and(eq(boardSprints.id, sprintId), eq(boardSprints.boardNodeId, boardId)));
  const ok = row && (opts.plannedOnly ? row.status === 'planned' : row.status !== 'closed');
  if (!ok) throw new AppError('invalid_target', { reason: 'sprint', id: sprintId });
}

/**
 * `updateBoard({ sprint })` from clients before sprints: a value edits the active sprint or
 * starts one holding the backlog (the band used to cover every card); null closes it.
 */
export async function applyLegacySprint(
  db: DbOrTx,
  a: DriveActor,
  access: BoardAccess,
  value: BoardSprint | null,
) {
  const active = await activeSprint(db, access.node.id);
  if (value === null) {
    if (active) await closeRow(db, access, active, null);
    return;
  }
  if (active) {
    await db
      .update(boardSprints)
      .set({ name: value.name, startsOn: value.startsOn, endsOn: value.endsOn })
      .where(eq(boardSprints.id, active.id));
    return;
  }
  const [row] = await db
    .insert(boardSprints)
    .values({
      orgId: a.org.id,
      boardNodeId: access.node.id,
      name: value.name,
      startsOn: value.startsOn,
      endsOn: value.endsOn,
      status: 'active',
      startedAt: new Date(),
      createdBy: a.userId,
    })
    .returning();
  await db
    .update(boardCards)
    .set({ sprintId: row!.id, sprintAddedAt: new Date() })
    .where(
      and(
        eq(boardCards.boardNodeId, access.node.id),
        isNull(boardCards.sprintId),
        isNull(boardCards.deletedAt),
      ),
    );
}

/* --------------------------------- burndown --------------------------------- */

function zoneOrUtc(tz: string | undefined) {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

/** Calendar days from `from` to `to`, both ISO dates, inclusive. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (
    let d = Date.parse(`${from}T00:00:00Z`);
    d <= Date.parse(`${to}T00:00:00Z`) && out.length < 400;
    d += 86_400_000
  ) {
    out.push(new Date(d).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Burndown of a sprint, computed from when each card joined it and when it was done (no
 * history table). A card that left the sprint is not in it any more, so a closed sprint's
 * line only shows what stayed; its `result` keeps the numbers at closing.
 */
export async function burndown(
  db: DbOrTx,
  a: DriveActor,
  sprintId: string,
  tz: string | undefined,
  now = new Date(),
): Promise<SprintBurndown> {
  const [sprint] = await db
    .select()
    .from(boardSprints)
    .where(and(eq(boardSprints.id, sprintId), eq(boardSprints.orgId, a.org.id)));
  if (!sprint) throw new AppError('not_found');
  const access = await loadBoard(db, a, sprint.boardNodeId);
  const unit = sprintUnit(access.board.settings);
  const zone = zoneOrUtc(tz);
  const dayOf = (d: Date) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  const cards = (
    await db
      .select({
        points: boardCards.points,
        doneAt: boardCards.doneAt,
        addedAt: boardCards.sprintAddedAt,
        createdAt: boardCards.createdAt,
      })
      .from(boardCards)
      .where(and(eq(boardCards.sprintId, sprintId), isNull(boardCards.deletedAt)))
  ).map((c) => ({
    w: weightOf(unit, c),
    added: dayOf(c.addedAt ?? c.createdAt),
    done: c.doneAt ? dayOf(c.doneAt) : null,
  }));
  const today = dayOf(now);
  const days = daysBetween(sprint.startsOn, sprint.endsOn);
  const scopeOn = (d: string) => cards.filter((c) => c.added <= d).reduce((s, c) => s + c.w, 0);
  const start = scopeOn(days[0] ?? sprint.startsOn);
  const last = Math.max(1, days.length - 1);
  let total = 0;
  let remainingNow = 0;
  const out = days.map((date, i) => {
    const scope = scopeOn(date);
    const past = date <= today;
    const remaining = past
      ? cards
          .filter((c) => c.added <= date && !(c.done && c.done <= date))
          .reduce((s, c) => s + c.w, 0)
      : null;
    if (past) {
      total = scope;
      remainingNow = remaining ?? 0;
    }
    return {
      date,
      scope,
      remaining,
      ideal: Math.round(start * (1 - i / last) * 100) / 100,
    };
  });
  if (days[0] !== undefined && days[0] > today) {
    total = cards.reduce((s, c) => s + c.w, 0);
    remainingNow = cards.filter((c) => !c.done).reduce((s, c) => s + c.w, 0);
  }
  return { sprintId, unit, days: out, total, done: total - remainingNow };
}
