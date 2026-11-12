import type { CalendarProvider } from '@crewhall/shared';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  calendarAccounts,
  calendarAttendees,
  calendarEvents,
  calendarMembers,
  calendars,
  spaceMembers,
  spaces,
  users,
  type DbOrTx,
} from '@crewhall/db';
import {
  can,
  canCalendar,
  type Actor,
  type Calendar,
  type CalendarKind,
  type CalendarRole,
  type SpaceColor,
  type SpaceRole,
  type UserSummary,
} from '@crewhall/shared';
import { AppError } from '../../http/errors';
import type { OrgRow } from '../../http/types';
import { orgContext } from '../membership';
import { isModuleEnabled } from '../identity/modules';

export type CalendarRow = typeof calendars.$inferSelect;

/**
 * The kind the permission function sees. A mirrored (external) calendar is never managed in
 * Crewhall (its name and sharing live at the provider), which is exactly the rule for space
 * calendars: write by role, manage never.
 */
export const permKind = (kind: CalendarRow['kind']): CalendarKind =>
  kind === 'external' ? 'space' : kind;

/** API kind: mirrored calendars travel as personal ones (with `external` set) for older clients. */
export const wireKind = (kind: CalendarRow['kind']): CalendarKind =>
  kind === 'external' ? 'personal' : kind;
export type EventRow = typeof calendarEvents.$inferSelect;
export type AttendeeRow = typeof calendarAttendees.$inferSelect;

/** Who is asking, in the active org. */
export interface CalActor {
  org: OrgRow;
  actor: Actor;
  userId: string;
  userName: string;
  userEmail: string;
}

/** The org may switch the calendar off; jobs and CalDAV check it themselves. */
export function calendarEnabled(db: DbOrTx, orgId: string) {
  return isModuleEnabled(db, orgId, 'calendar');
}

type UserRow = { id: string; name: string; email: string; image: string | null };
export const toSummary = (u: UserRow): UserSummary => ({
  id: u.id,
  name: u.name,
  email: u.email,
  imageUrl: u.image && /^https?:\/\//.test(u.image) ? u.image : null,
});

export async function usersByIds(db: DbOrTx, ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (!unique.length) return new Map<string, UserSummary>();
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email, image: users.image })
    .from(users)
    .where(inArray(users.id, unique));
  return new Map(rows.map((r) => [r.id, toSummary(r)]));
}

/** Space role → calendar role, through the single permission function. */
export function spaceCalendarRole(a: CalActor, spaceRole: SpaceRole | null): CalendarRole | null {
  const res = { type: 'space' as const, org: orgContext(a.org), myRole: spaceRole };
  if (!can(a.actor, 'space.view', res)) return null;
  if (can(a.actor, 'space.update_settings', res)) return 'owner';
  if (can(a.actor, 'space.edit_content', res)) return 'editor';
  return 'viewer';
}

/**
 * Creates what every person has without asking: their personal calendar and one calendar per
 * shared space they belong to. Idempotent (unique indexes), cheap after the first call.
 */
export async function ensureCalendars(db: DbOrTx, a: CalActor) {
  await db
    .insert(calendars)
    .values({ orgId: a.org.id, kind: 'personal', ownerId: a.userId, name: a.userName, color: 's1' })
    .onConflictDoNothing();
  const missing = await db
    .select({ id: spaces.id, name: spaces.name, color: spaces.color })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
    .where(
      and(
        eq(spaceMembers.userId, a.userId),
        eq(spaces.orgId, a.org.id),
        eq(spaces.kind, 'shared'),
        isNull(spaces.deletedAt),
        sql`not exists (select 1 from ${calendars} c where c.space_id = ${spaces.id} and c.kind = 'space')`,
      ),
    );
  if (missing.length) {
    await db
      .insert(calendars)
      .values(
        missing.map((s) => ({
          orgId: a.org.id,
          kind: 'space' as const,
          spaceId: s.id,
          name: s.name,
          color: s.color,
        })),
      )
      .onConflictDoNothing();
  }
}

export async function personalCalendar(db: DbOrTx, a: CalActor): Promise<CalendarRow> {
  const find = () =>
    db
      .select()
      .from(calendars)
      .where(
        and(
          eq(calendars.orgId, a.org.id),
          eq(calendars.kind, 'personal'),
          eq(calendars.ownerId, a.userId),
          isNull(calendars.deletedAt),
        ),
      );
  let [row] = await find();
  if (!row) {
    await ensureCalendars(db, a);
    [row] = await find();
  }
  return row!;
}

export interface CalendarAccess {
  calendar: CalendarRow;
  role: CalendarRole | null;
  /** Space name and colour for space calendars (they follow the space). */
  space: { name: string; color: SpaceColor; archived: boolean } | null;
}

/** Roles of the caller on the given calendars (null = none). */
export async function rolesFor(
  db: DbOrTx,
  a: CalActor,
  rows: CalendarRow[],
): Promise<Map<string, CalendarAccess>> {
  const out = new Map<string, CalendarAccess>();
  const teamIds = rows.filter((r) => r.kind === 'team').map((r) => r.id);
  const spaceIds = rows.filter((r) => r.spaceId).map((r) => r.spaceId!);
  const [members, spaceRows, spaceRoles] = await Promise.all([
    teamIds.length
      ? db
          .select()
          .from(calendarMembers)
          .where(
            and(inArray(calendarMembers.calendarId, teamIds), eq(calendarMembers.userId, a.userId)),
          )
      : Promise.resolve([]),
    spaceIds.length
      ? db.select().from(spaces).where(inArray(spaces.id, spaceIds))
      : Promise.resolve([]),
    spaceIds.length
      ? db
          .select()
          .from(spaceMembers)
          .where(and(inArray(spaceMembers.spaceId, spaceIds), eq(spaceMembers.userId, a.userId)))
      : Promise.resolve([]),
  ]);
  for (const c of rows) {
    let role: CalendarRole | null = null;
    let space: CalendarAccess['space'] = null;
    if (c.kind === 'personal') role = c.ownerId === a.userId ? 'owner' : null;
    else if (c.kind === 'external') {
      // Only the person who connected the account sees it; read-only at the provider stays so.
      role = c.ownerId === a.userId ? (c.externalWritable ? 'owner' : 'viewer') : null;
    } else if (c.kind === 'team') {
      role = members.find((m) => m.calendarId === c.id)?.role ?? null;
    } else {
      const s = spaceRows.find((x) => x.id === c.spaceId);
      if (s && !s.deletedAt) {
        space = { name: s.name, color: s.color as SpaceColor, archived: Boolean(s.archivedAt) };
        const sr = (spaceRoles.find((m) => m.spaceId === s.id)?.role ?? null) as SpaceRole | null;
        role = spaceCalendarRole(a, sr);
        // An archived space is read-only.
        if (role && s.archivedAt) role = 'viewer';
      }
    }
    if (c.deletedAt) role = null;
    out.set(c.id, { calendar: c, role, space });
  }
  return out;
}

/** A calendar of the active org the caller can read; 404 otherwise (design 1.18). */
export async function loadCalendar(db: DbOrTx, a: CalActor, calendarId: string) {
  const [row] = await db
    .select()
    .from(calendars)
    .where(and(eq(calendars.id, calendarId), eq(calendars.orgId, a.org.id)));
  if (!row || row.deletedAt) throw new AppError('not_found');
  const access = (await rolesFor(db, a, [row])).get(row.id)!;
  if (!canCalendar('read', { role: access.role, kind: permKind(row.kind) })) {
    throw new AppError('not_found');
  }
  return access;
}

export function requireWrite(access: CalendarAccess) {
  if (!canCalendar('write', { role: access.role, kind: permKind(access.calendar.kind) })) {
    throw new AppError('calendar_read_only');
  }
}

export function requireManage(access: CalendarAccess) {
  if (access.calendar.kind === 'space') throw new AppError('calendar_not_team');
  if (!canCalendar('manage', { role: access.role, kind: permKind(access.calendar.kind) })) {
    throw new AppError('forbidden');
  }
}

/** Every calendar the caller can read in the active org. */
export async function readableCalendars(db: DbOrTx, a: CalActor): Promise<CalendarAccess[]> {
  await ensureCalendars(db, a);
  const rows = await db
    .select()
    .from(calendars)
    .where(
      and(
        eq(calendars.orgId, a.org.id),
        isNull(calendars.deletedAt),
        sql`(
          (${calendars.kind} in ('personal', 'external') and ${calendars.ownerId} = ${a.userId})
          or (${calendars.kind} = 'team' and ${calendars.id} in (select calendar_id from ${calendarMembers} where user_id = ${a.userId}))
          or (${calendars.kind} = 'space' and ${calendars.spaceId} in (select space_id from ${spaceMembers} where user_id = ${a.userId}))
        )`,
      ),
    );
  const roles = await rolesFor(db, a, rows);
  return [...roles.values()].filter((x) => x.role !== null);
}

const KIND_ORDER = { personal: 0, external: 1, team: 2, space: 3 } as const;

export async function toCalendars(
  db: DbOrTx,
  a: CalActor,
  list: CalendarAccess[],
): Promise<Calendar[]> {
  const teamIds = list.filter((x) => x.calendar.kind === 'team').map((x) => x.calendar.id);
  const counts = teamIds.length
    ? await db
        .select({ id: calendarMembers.calendarId, n: sql<number>`count(*)::int` })
        .from(calendarMembers)
        .where(inArray(calendarMembers.calendarId, teamIds))
        .groupBy(calendarMembers.calendarId)
    : [];
  const accountIds = [
    ...new Set(list.map((x) => x.calendar.accountId).filter((x): x is string => Boolean(x))),
  ];
  const accounts = accountIds.length
    ? await db
        .select({
          id: calendarAccounts.id,
          provider: calendarAccounts.provider,
          email: calendarAccounts.email,
        })
        .from(calendarAccounts)
        .where(inArray(calendarAccounts.id, accountIds))
    : [];
  return list
    .filter((x) => x.role !== null)
    .sort(
      (x, y) =>
        KIND_ORDER[x.calendar.kind] - KIND_ORDER[y.calendar.kind] ||
        nameOf(x).localeCompare(nameOf(y), 'tr'),
    )
    .map((x) => ({
      id: x.calendar.id,
      kind: wireKind(x.calendar.kind),
      name: nameOf(x),
      color: (x.space?.color ?? x.calendar.color) as SpaceColor,
      description: x.calendar.description,
      spaceId: x.calendar.spaceId,
      ownerId: x.calendar.ownerId,
      isDefault: x.calendar.kind === 'personal' && x.calendar.ownerId === a.userId,
      myRole: x.role!,
      memberCount:
        x.calendar.kind === 'team' ? (counts.find((c) => c.id === x.calendar.id)?.n ?? 0) : 1,
      permissions: {
        write: canCalendar('write', { role: x.role, kind: permKind(x.calendar.kind) }),
        manage: canCalendar('manage', { role: x.role, kind: permKind(x.calendar.kind) }),
      },
      external: externalRef(x.calendar, accounts),
      createdAt: x.calendar.createdAt.toISOString(),
    }));
}

const nameOf = (x: CalendarAccess) => x.space?.name ?? x.calendar.name;

function externalRef(
  c: CalendarRow,
  accounts: { id: string; provider: CalendarProvider; email: string }[],
): Calendar['external'] {
  if (c.kind !== 'external') return null;
  const acc = accounts.find((x) => x.id === c.accountId);
  return acc
    ? {
        provider: acc.provider,
        accountId: acc.id,
        email: acc.email,
        writable: Boolean(c.externalWritable),
      }
    : null;
}

/** Bumps the CalDAV ctag of the calendars an event change touched. */
export async function touchCalendars(db: DbOrTx, ids: string[]) {
  const unique = [...new Set(ids)];
  if (!unique.length) return;
  await db
    .update(calendars)
    .set({ changeSeq: sql`${calendars.changeSeq} + 1` })
    .where(inArray(calendars.id, unique));
}
