import { and, asc, eq, gt, ilike, inArray, isNotNull, or, sql, type SQL } from 'drizzle-orm';
import {
  directoryProfiles,
  externalIdentities,
  orgMembers,
  users,
  type DbOrTx,
} from '@crewhall/db';
import {
  canContacts,
  type DirectoryFacets,
  type DirectoryField,
  type DirectoryPerson,
  type DirectoryQuery,
  type OrgChart,
  type UpdateDirectoryProfile,
  type UserSummary,
} from '@crewhall/shared';
import type { z } from 'zod';
import type { DirectoryQuery as QuerySchema } from '@crewhall/shared';
import { AppError } from '../../http/errors';
import type { ContactsActor } from './access';
import { toSummary } from './access';

export type { DirectoryQuery };
type Query = z.output<typeof QuerySchema>;

type ProfileRow = typeof directoryProfiles.$inferSelect;
type UserRow = typeof users.$inferSelect;
type MemberRow = typeof orgMembers.$inferSelect;

/**
 * The org directory (roadmap 15): active org members (platform users, AD/LDAP synced by
 * identity) with the directory profile on top. Guests see nobody here (chat shows them the
 * people they share conversations with).
 */

function requireRead(a: ContactsActor) {
  if (!canContacts('directory.read', { orgRole: a.actor.orgRole })) throw new AppError('forbidden');
}

const like = (q: string) => `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

async function reportCounts(db: DbOrTx, orgId: string, ids: string[]) {
  if (!ids.length) return new Map<string, number>();
  const rows = await db
    .select({ id: directoryProfiles.managerId, n: sql<number>`count(*)::int` })
    .from(directoryProfiles)
    .innerJoin(
      orgMembers,
      and(
        eq(orgMembers.userId, directoryProfiles.userId),
        eq(orgMembers.organizationId, directoryProfiles.orgId),
        eq(orgMembers.status, 'active'),
      ),
    )
    .where(and(eq(directoryProfiles.orgId, orgId), inArray(directoryProfiles.managerId, ids)))
    .groupBy(directoryProfiles.managerId);
  return new Map(rows.map((r) => [r.id!, r.n]));
}

async function linkedToDirectory(db: DbOrTx, orgId: string, ids: string[]) {
  if (!ids.length) return new Set<string>();
  const rows = await db
    .select({ userId: externalIdentities.userId })
    .from(externalIdentities)
    .where(
      and(
        eq(externalIdentities.orgId, orgId),
        inArray(externalIdentities.userId, ids),
        isNotNull(externalIdentities.dn),
      ),
    );
  return new Set(rows.map((r) => r.userId));
}

async function toPeople(
  db: DbOrTx,
  a: ContactsActor,
  rows: { u: UserRow; m: MemberRow; p: ProfileRow | null }[],
): Promise<DirectoryPerson[]> {
  const ids = rows.map((r) => r.u.id);
  const managerIds = rows.map((r) => r.p?.managerId).filter((x): x is string => Boolean(x));
  const [counts, linked, managers] = await Promise.all([
    reportCounts(db, a.org.id, ids),
    linkedToDirectory(db, a.org.id, ids),
    managerIds.length
      ? db.select().from(users).where(inArray(users.id, managerIds))
      : Promise.resolve([] as UserRow[]),
  ]);
  const admin = canContacts('directory.manage', { orgRole: a.actor.orgRole });
  return rows.map(({ u, m, p }) => {
    const manager = p?.managerId ? managers.find((x) => x.id === p.managerId) : undefined;
    const own = u.id === a.userId;
    // A birthday is private until its person shows it (the person and admins always see it).
    const showBirthday = own || admin || !!p?.birthdayVisible;
    return {
      user: toSummary(u),
      orgRole: m.role,
      title: p?.title ?? null,
      department: p?.department ?? null,
      team: p?.team ?? null,
      phone: p?.phone ?? null,
      mobile: p?.mobile ?? null,
      location: p?.location ?? null,
      about: p?.about ?? null,
      manager: manager ? toSummary(manager) : null,
      reportCount: counts.get(u.id) ?? 0,
      syncedFields: (p?.syncedFields ?? []) as DirectoryField[],
      fromDirectory: linked.has(u.id),
      joinedAt: m.joinedAt?.toISOString() ?? null,
      birthday: showBirthday ? (p?.birthday ?? null) : null,
      birthdayVisible: p?.birthdayVisible ?? false,
      startedOn: p?.startedOn ?? null,
      permissions: {
        edit: canContacts('directory.edit', { orgRole: a.actor.orgRole, own }),
        editManager: admin,
      },
    };
  });
}

function baseQuery(db: DbOrTx, a: ContactsActor, extra: SQL[]) {
  return db
    .select({ u: users, m: orgMembers, p: directoryProfiles })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.userId))
    .leftJoin(
      directoryProfiles,
      and(
        eq(directoryProfiles.userId, users.id),
        eq(directoryProfiles.orgId, orgMembers.organizationId),
      ),
    )
    .where(
      and(
        eq(orgMembers.organizationId, a.org.id),
        eq(orgMembers.status, 'active'),
        // Guests are not part of the org directory.
        sql`${orgMembers.role} <> 'guest'`,
        ...extra,
      ),
    );
}

const encodeCursor = (name: string, id: string) =>
  Buffer.from(JSON.stringify([name, id])).toString('base64url');

function decodeCursor(cursor: string): { name: string; id: string } | null {
  try {
    const v: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'string') {
      return { name: v[0], id: v[1] };
    }
  } catch {
    // An unreadable cursor starts from the top.
  }
  return null;
}

export async function listDirectory(db: DbOrTx, a: ContactsActor, q: Query) {
  requireRead(a);
  const extra: SQL[] = [];
  const term = q.q?.trim();
  if (term) {
    const t = like(term);
    extra.push(
      or(
        ilike(users.name, t),
        ilike(users.email, t),
        ilike(directoryProfiles.title, t),
        ilike(directoryProfiles.department, t),
        ilike(directoryProfiles.team, t),
        ilike(directoryProfiles.phone, t),
        ilike(directoryProfiles.mobile, t),
        ilike(directoryProfiles.location, t),
      )!,
    );
  }
  if (q.department) extra.push(eq(directoryProfiles.department, q.department));
  if (q.team) extra.push(eq(directoryProfiles.team, q.team));
  if (q.location) extra.push(eq(directoryProfiles.location, q.location));
  if (q.managerId) extra.push(eq(directoryProfiles.managerId, q.managerId));
  // Cursor: the last name and id seen (names sort with Turkish rules).
  if (q.cursor) {
    const cur = decodeCursor(q.cursor);
    if (cur) {
      extra.push(
        or(
          sql`${users.name} collate "tr-x-icu" > ${cur.name}`,
          and(sql`${users.name} collate "tr-x-icu" = ${cur.name}`, gt(users.id, cur.id)),
        )!,
      );
    }
  }
  const rows = await baseQuery(db, a, extra)
    .orderBy(sql`${users.name} collate "tr-x-icu"`, asc(users.id))
    .limit(q.limit + 1);
  const more = rows.length > q.limit;
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    items: await toPeople(db, a, page),
    nextCursor: more && last ? encodeCursor(last.u.name, last.u.id) : null,
  };
}

export async function getPerson(db: DbOrTx, a: ContactsActor, userId: string) {
  requireRead(a);
  const [row] = await baseQuery(db, a, [eq(users.id, userId)]);
  if (!row) throw new AppError('not_found');
  return (await toPeople(db, a, [row]))[0]!;
}

export async function facets(db: DbOrTx, a: ContactsActor): Promise<DirectoryFacets> {
  requireRead(a);
  const count = async (
    col:
      | typeof directoryProfiles.department
      | typeof directoryProfiles.team
      | typeof directoryProfiles.location,
  ) => {
    const rows = await db
      .select({ value: col, count: sql<number>`count(*)::int` })
      .from(directoryProfiles)
      .innerJoin(
        orgMembers,
        and(
          eq(orgMembers.userId, directoryProfiles.userId),
          eq(orgMembers.organizationId, directoryProfiles.orgId),
          eq(orgMembers.status, 'active'),
        ),
      )
      .where(and(eq(directoryProfiles.orgId, a.org.id), isNotNull(col)))
      .groupBy(col)
      .orderBy(col);
    return rows.filter((r) => r.value).map((r) => ({ value: r.value!, count: r.count }));
  };
  return {
    departments: await count(directoryProfiles.department),
    teams: await count(directoryProfiles.team),
    locations: await count(directoryProfiles.location),
  };
}

export async function orgChart(db: DbOrTx, a: ContactsActor): Promise<OrgChart> {
  requireRead(a);
  const rows = await baseQuery(db, a, []).orderBy(sql`${users.name} collate "tr-x-icu"`);
  const active = new Set(rows.map((r) => r.u.id));
  const reports = new Map<string, number>();
  for (const r of rows) {
    const m = r.p?.managerId;
    if (m && active.has(m)) reports.set(m, (reports.get(m) ?? 0) + 1);
  }
  return {
    items: rows.map((r) => ({
      user: toSummary(r.u) as UserSummary,
      title: r.p?.title ?? null,
      department: r.p?.department ?? null,
      // A manager who left the org: the person shows at the top.
      managerId: r.p?.managerId && active.has(r.p.managerId) ? r.p.managerId : null,
      reportCount: reports.get(r.u.id) ?? 0,
      team: r.p?.team ?? null,
      managerSynced: (r.p?.syncedFields ?? []).includes('managerId'),
      syncedFields: (r.p?.syncedFields ?? []) as DirectoryField[],
    })),
    permissions: { editManager: canContacts('directory.manage', { orgRole: a.actor.orgRole }) },
  };
}

const FIELD_COLUMN: Record<Exclude<DirectoryField, 'managerId'> | 'about', keyof ProfileRow> = {
  title: 'title',
  department: 'department',
  team: 'team',
  phone: 'phone',
  mobile: 'mobile',
  location: 'location',
  about: 'about',
};

export async function updateProfile(
  db: DbOrTx,
  a: ContactsActor,
  userId: string,
  patch: UpdateDirectoryProfile,
) {
  const person = await getPerson(db, a, userId);
  if (!person.permissions.edit) throw new AppError('forbidden');
  if (patch.managerId !== undefined && !person.permissions.editManager) {
    throw new AppError('forbidden', { field: 'managerId' });
  }
  const synced = new Set(person.syncedFields);
  const set: Partial<ProfileRow> = {};
  for (const [field, column] of Object.entries(FIELD_COLUMN) as [
    keyof typeof FIELD_COLUMN,
    keyof ProfileRow,
  ][]) {
    const v = patch[field];
    if (v === undefined) continue;
    if (field !== 'about' && synced.has(field))
      throw new AppError('directory_field_synced', { field });
    (set as Record<string, unknown>)[column] = v === '' ? null : v;
  }
  if (patch.managerId !== undefined) {
    if (synced.has('managerId'))
      throw new AppError('directory_field_synced', { field: 'managerId' });
    if (patch.managerId !== null) {
      if (patch.managerId === userId) throw new AppError('directory_manager_cycle');
      await getPerson(db, a, patch.managerId);
      // Walk up from the new manager: reaching the person would close a loop.
      let cursor: string | null = patch.managerId;
      for (let i = 0; cursor && i < 200; i++) {
        const [row]: { managerId: string | null }[] = await db
          .select({ managerId: directoryProfiles.managerId })
          .from(directoryProfiles)
          .where(and(eq(directoryProfiles.orgId, a.org.id), eq(directoryProfiles.userId, cursor)));
        cursor = row?.managerId ?? null;
        if (cursor === userId) throw new AppError('directory_manager_cycle');
      }
    }
    set.managerId = patch.managerId;
  }
  // Birthday and its visibility: the person's own choice (admins may correct the date).
  if (patch.birthday !== undefined) set.birthday = patch.birthday;
  if (patch.birthdayVisible !== undefined) {
    if (userId !== a.userId) throw new AppError('forbidden', { field: 'birthdayVisible' });
    set.birthdayVisible = patch.birthdayVisible;
  }
  if (patch.startedOn !== undefined) set.startedOn = patch.startedOn;
  if (Object.keys(set).length) {
    await db
      .insert(directoryProfiles)
      .values({ orgId: a.org.id, userId, ...set })
      .onConflictDoUpdate({
        target: [directoryProfiles.orgId, directoryProfiles.userId],
        set: { ...set, updatedAt: new Date() },
      });
  }
  return getPerson(db, a, userId);
}

/** Everyone of the directory with their profile (vCard export, CardDAV). */
export async function allPeople(db: DbOrTx, a: ContactsActor) {
  requireRead(a);
  return baseQuery(db, a, []).orderBy(sql`${users.name} collate "tr-x-icu"`);
}
