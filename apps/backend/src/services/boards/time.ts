import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { boardTimeEntries, type DbOrTx } from '@crewhall/db';
import type { AddTimeEntry, MyTimer, TimeEntry, UpdateTimeEntry } from '@crewhall/shared';
import type { z } from 'zod';
import { AppError } from '../../http/errors';
import type { DriveActor } from '../drive/access';
import {
  canManage,
  loadCard,
  requireRole,
  touchBoard,
  userSummaries,
  type BoardAccess,
} from './access';
import { announce } from './boards';
import { linkedCardOf } from './links';

/**
 * Time tracking (kararlar 2026-10-29). An entry belongs to a card and a person; a timer
 * entry has no minutes while it runs and gets them when stopped (at least one). Editors log
 * time; people edit their own entries, board managers every entry; viewers only read.
 */

type EntryRow = typeof boardTimeEntries.$inferSelect;

/** Minutes a timer ran, rounded up: a started minute counts. */
const elapsed = (from: Date, to = new Date()) =>
  Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 60_000));

async function toEntries(
  db: DbOrTx,
  a: DriveActor,
  rows: EntryRow[],
  managers: Set<string>,
): Promise<TimeEntry[]> {
  const people = await userSummaries(
    db,
    rows.map((r) => r.userId),
  );
  return rows.flatMap((r) => {
    const user = people.get(r.userId);
    if (!user) return [];
    return [
      {
        id: r.id,
        cardId: r.cardId,
        user,
        startedAt: r.startedAt.toISOString(),
        minutes: r.minutes,
        note: r.note,
        source: r.source,
        canEdit: r.userId === a.userId || managers.has(r.cardId),
      },
    ];
  });
}

const changed = async (db: DbOrTx, a: DriveActor, access: BoardAccess) =>
  announce(access.node, await touchBoard(db, access.node.id, a.userId));

export async function listTime(db: DbOrTx, a: DriveActor, cardId: string) {
  const access = await loadCard(db, a, cardId);
  const rows = await db
    .select()
    .from(boardTimeEntries)
    .where(eq(boardTimeEntries.cardId, cardId))
    .orderBy(desc(boardTimeEntries.startedAt));
  const managers = new Set(canManage(a, access) ? [cardId] : []);
  return { items: await toEntries(db, a, rows, managers) };
}

/** Minutes of finished entries per card (the card's `spentMinutes`). */
export async function spentMinutes(db: DbOrTx, cardIds: string[]) {
  if (cardIds.length === 0) return new Map<string, number>();
  const rows = await db
    .select({
      cardId: boardTimeEntries.cardId,
      n: sql<string>`coalesce(sum(${boardTimeEntries.minutes}), 0)`,
    })
    .from(boardTimeEntries)
    .where(and(inArray(boardTimeEntries.cardId, cardIds), isNotNull(boardTimeEntries.minutes)))
    .groupBy(boardTimeEntries.cardId);
  return new Map(rows.map((r) => [r.cardId, Number(r.n)]));
}

export async function addTime(
  db: DbOrTx,
  a: DriveActor,
  cardId: string,
  input: z.output<typeof AddTimeEntry>,
): Promise<TimeEntry> {
  const access = await loadCard(db, a, cardId);
  requireRole(a, access.role, 'edit');
  const [row] = await db
    .insert(boardTimeEntries)
    .values({
      orgId: a.org.id,
      cardId,
      userId: a.userId,
      startedAt: input.startedAt ? new Date(input.startedAt) : new Date(),
      minutes: input.minutes,
      note: input.note,
      source: 'manual',
    })
    .returning();
  await changed(db, a, access);
  return (await toEntries(db, a, [row!], new Set()))[0]!;
}

/** Finishes the caller's running timer; null when none runs. */
async function stopRunning(db: DbOrTx, a: DriveActor) {
  const [running] = await db
    .select()
    .from(boardTimeEntries)
    .where(and(eq(boardTimeEntries.userId, a.userId), isNull(boardTimeEntries.minutes)))
    .for('update');
  if (!running) return null;
  const [row] = await db
    .update(boardTimeEntries)
    .set({ minutes: elapsed(running.startedAt) })
    .where(eq(boardTimeEntries.id, running.id))
    .returning();
  return row!;
}

export async function startTimer(db: DbOrTx, a: DriveActor, cardId: string): Promise<TimeEntry> {
  const access = await loadCard(db, a, cardId);
  requireRole(a, access.role, 'edit');
  const stopped = await stopRunning(db, a);
  if (stopped && stopped.cardId !== cardId) {
    const other = await loadCard(db, a, stopped.cardId, { includeDeleted: true }).catch(() => null);
    if (other) await changed(db, a, other);
  }
  const [row] = await db
    .insert(boardTimeEntries)
    .values({
      orgId: a.org.id,
      cardId,
      userId: a.userId,
      startedAt: new Date(),
      source: 'timer',
    })
    .returning();
  await changed(db, a, access);
  return (await toEntries(db, a, [row!], new Set()))[0]!;
}

export async function stopTimer(db: DbOrTx, a: DriveActor) {
  const row = await stopRunning(db, a);
  if (!row) return { entry: null };
  const access = await loadCard(db, a, row.cardId, { includeDeleted: true }).catch(() => null);
  if (access) await changed(db, a, access);
  return { entry: (await toEntries(db, a, [row], new Set()))[0] ?? null };
}

export async function myTimer(db: DbOrTx, a: DriveActor): Promise<MyTimer> {
  const [row] = await db
    .select()
    .from(boardTimeEntries)
    .where(
      and(
        eq(boardTimeEntries.userId, a.userId),
        eq(boardTimeEntries.orgId, a.org.id),
        isNull(boardTimeEntries.minutes),
      ),
    );
  if (!row) return { entry: null };
  const card = await linkedCardOf(db, a, row.cardId);
  if (!card) return { entry: null };
  const [entry] = await toEntries(db, a, [row], new Set());
  return { entry: entry ? { ...entry, card } : null };
}

async function loadEntry(db: DbOrTx, a: DriveActor, entryId: string) {
  const [row] = await db
    .select()
    .from(boardTimeEntries)
    .where(and(eq(boardTimeEntries.id, entryId), eq(boardTimeEntries.orgId, a.org.id)));
  if (!row) throw new AppError('not_found');
  const access = await loadCard(db, a, row.cardId);
  if (row.userId !== a.userId) {
    if (!canManage(a, access)) throw new AppError('forbidden', { reason: 'time_entry' });
  } else {
    requireRole(a, access.role, 'edit');
  }
  return { row, access };
}

export async function updateTime(
  db: DbOrTx,
  a: DriveActor,
  entryId: string,
  input: z.output<typeof UpdateTimeEntry>,
): Promise<TimeEntry> {
  const { row, access } = await loadEntry(db, a, entryId);
  // A running timer gets its minutes when it stops.
  if (row.minutes === null && input.minutes !== undefined) {
    throw new AppError('conflict', { reason: 'timer_running' });
  }
  const [updated] = await db
    .update(boardTimeEntries)
    .set({
      ...(input.minutes !== undefined ? { minutes: input.minutes } : {}),
      ...(input.startedAt !== undefined ? { startedAt: new Date(input.startedAt) } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    })
    .where(eq(boardTimeEntries.id, entryId))
    .returning();
  await changed(db, a, access);
  const managers = new Set(canManage(a, access) ? [row.cardId] : []);
  return (await toEntries(db, a, [updated!], managers))[0]!;
}

export async function deleteTime(db: DbOrTx, a: DriveActor, entryId: string) {
  const { access } = await loadEntry(db, a, entryId);
  await db.delete(boardTimeEntries).where(eq(boardTimeEntries.id, entryId));
  await changed(db, a, access);
}
