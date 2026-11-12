import { and, eq, inArray, sql } from 'drizzle-orm';
import { calendarMembers, calendars, orgMembers, users, type DbOrTx } from '@crewhall/db';
import type { CalendarMember, CreateCalendar, UpdateCalendar } from '@crewhall/shared';
import type { z } from 'zod';
import type { CreateCalendar as CreateSchema } from '@crewhall/shared';
import { AppError } from '../../http/errors';
import {
  loadCalendar,
  readableCalendars,
  requireManage,
  toCalendars,
  toSummary,
  type CalActor,
} from './access';

export type { CreateCalendar };

export async function listCalendars(db: DbOrTx, a: CalActor) {
  return { items: await toCalendars(db, a, await readableCalendars(db, a)) };
}

async function activeMembers(db: DbOrTx, orgId: string, ids: string[]) {
  if (!ids.length) return new Set<string>();
  const rows = await db
    .select({ id: orgMembers.userId })
    .from(orgMembers)
    .where(
      and(
        eq(orgMembers.organizationId, orgId),
        eq(orgMembers.status, 'active'),
        inArray(orgMembers.userId, ids),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

export async function createCalendar(
  db: DbOrTx,
  a: CalActor,
  input: z.output<typeof CreateSchema>,
) {
  if (a.actor.orgRole === 'guest') throw new AppError('forbidden');
  const others = input.members.filter((m) => m.userId !== a.userId);
  const known = await activeMembers(
    db,
    a.org.id,
    others.map((m) => m.userId),
  );
  const missing = others.find((m) => !known.has(m.userId));
  if (missing) throw new AppError('validation_failed', { field: 'members', id: missing.userId });
  const row = await db.transaction(async (tx) => {
    const [cal] = await tx
      .insert(calendars)
      .values({
        orgId: a.org.id,
        kind: 'team',
        ownerId: a.userId,
        name: input.name,
        color: input.color,
        description: input.description ?? null,
      })
      .returning();
    await tx.insert(calendarMembers).values([
      { orgId: a.org.id, calendarId: cal!.id, userId: a.userId, role: 'owner' as const },
      ...others.map((m) => ({
        orgId: a.org.id,
        calendarId: cal!.id,
        userId: m.userId,
        role: m.role,
      })),
    ]);
    return cal!;
  });
  const access = await loadCalendar(db, a, row.id);
  return (await toCalendars(db, a, [access]))[0]!;
}

export async function updateCalendar(
  db: DbOrTx,
  a: CalActor,
  calendarId: string,
  input: UpdateCalendar,
) {
  const access = await loadCalendar(db, a, calendarId);
  // A person may rename and recolour their own calendar; space calendars follow the space.
  requireManage(access);
  await db
    .update(calendars)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      changeSeq: sql`${calendars.changeSeq} + 1`,
    })
    .where(eq(calendars.id, calendarId));
  const fresh = await loadCalendar(db, a, calendarId);
  return (await toCalendars(db, a, [fresh]))[0]!;
}

export async function deleteCalendar(db: DbOrTx, a: CalActor, calendarId: string) {
  const access = await loadCalendar(db, a, calendarId);
  if (access.calendar.kind !== 'team') throw new AppError('calendar_not_team');
  requireManage(access);
  await db.update(calendars).set({ deletedAt: new Date() }).where(eq(calendars.id, calendarId));
}

export async function listMembers(db: DbOrTx, a: CalActor, calendarId: string) {
  const access = await loadCalendar(db, a, calendarId);
  if (access.calendar.kind !== 'team') {
    // Personal: the owner. Space: managed in the space's members.
    if (access.calendar.kind === 'personal') {
      const [u] = await db.select().from(users).where(eq(users.id, access.calendar.ownerId!));
      return { items: u ? [{ user: toSummary(u), role: 'owner' as const }] : [] };
    }
    throw new AppError('calendar_not_team');
  }
  const rows = await db
    .select({ m: calendarMembers, u: users })
    .from(calendarMembers)
    .innerJoin(users, eq(users.id, calendarMembers.userId))
    .where(eq(calendarMembers.calendarId, calendarId));
  const order = { owner: 0, editor: 1, viewer: 2 } as const;
  return {
    items: rows
      .map((r): CalendarMember => ({ user: toSummary(r.u), role: r.m.role }))
      .sort(
        (x, y) => order[x.role] - order[y.role] || x.user.name.localeCompare(y.user.name, 'tr'),
      ),
  };
}

export async function setMember(
  db: DbOrTx,
  a: CalActor,
  calendarId: string,
  userId: string,
  role: 'editor' | 'viewer',
): Promise<CalendarMember> {
  const access = await loadCalendar(db, a, calendarId);
  if (access.calendar.kind !== 'team') throw new AppError('calendar_not_team');
  requireManage(access);
  if (!(await activeMembers(db, a.org.id, [userId])).has(userId)) {
    throw new AppError('member_not_found');
  }
  const [current] = await db
    .select()
    .from(calendarMembers)
    .where(and(eq(calendarMembers.calendarId, calendarId), eq(calendarMembers.userId, userId)));
  if (current?.role === 'owner') await keepAnOwner(db, calendarId, userId);
  await db
    .insert(calendarMembers)
    .values({ orgId: a.org.id, calendarId, userId, role })
    .onConflictDoUpdate({
      target: [calendarMembers.calendarId, calendarMembers.userId],
      set: { role, updatedAt: new Date() },
    });
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  return { user: toSummary(u!), role };
}

async function keepAnOwner(db: DbOrTx, calendarId: string, leaving: string) {
  const owners = await db
    .select({ userId: calendarMembers.userId })
    .from(calendarMembers)
    .where(and(eq(calendarMembers.calendarId, calendarId), eq(calendarMembers.role, 'owner')));
  if (owners.filter((o) => o.userId !== leaving).length === 0) {
    throw new AppError('calendar_last_owner');
  }
}

export async function removeMember(db: DbOrTx, a: CalActor, calendarId: string, userId: string) {
  const access = await loadCalendar(db, a, calendarId);
  if (access.calendar.kind !== 'team') throw new AppError('calendar_not_team');
  // Anyone may leave; removing others needs the owner.
  if (userId !== a.userId) requireManage(access);
  const [current] = await db
    .select()
    .from(calendarMembers)
    .where(and(eq(calendarMembers.calendarId, calendarId), eq(calendarMembers.userId, userId)));
  if (!current) return;
  if (current.role === 'owner') await keepAnOwner(db, calendarId, userId);
  await db
    .delete(calendarMembers)
    .where(and(eq(calendarMembers.calendarId, calendarId), eq(calendarMembers.userId, userId)));
}
