import { and, asc, eq, inArray, isNotNull, isNull, like, sql } from 'drizzle-orm';
import {
  orgMembers,
  spaceMembers,
  spaces,
  users,
  type DbOrTx,
  type SpaceRoleValue,
} from '@crewhall/db';
import { liveMember } from './guests';
import type { OrgSpace, Space, SpaceColor, SpaceMember, SpaceRole } from '@crewhall/shared';
import { SPACE_DELETE_RETENTION_DAYS } from '@crewhall/shared';
import { AppError } from '../http/errors';

export type SpaceRow = typeof spaces.$inferSelect;

/** Grey (s6) is reserved for personal spaces (design doc 16, setup 1.12). */
export const PERSONAL_COLOR: SpaceColor = 's6';

const TR_MAP: Record<string, string> = {
  ç: 'c',
  Ç: 'c',
  ğ: 'g',
  Ğ: 'g',
  ı: 'i',
  I: 'i',
  İ: 'i',
  ö: 'o',
  Ö: 'o',
  ş: 's',
  Ş: 's',
  ü: 'u',
  Ü: 'u',
};

export function slugify(name: string): string {
  const base = name
    .replace(/[çÇğĞıIİöÖşŞüÜ]/g, (ch) => TR_MAP[ch] ?? ch)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return base.length >= 2 ? base : `space-${base}`.replace(/-+$/g, '');
}

async function uniqueSlug(db: DbOrTx, orgId: string, wanted: string) {
  const taken = new Set(
    (
      await db
        .select({ slug: spaces.slug })
        .from(spaces)
        .where(and(eq(spaces.orgId, orgId), like(spaces.slug, `${wanted}%`)))
    ).map((r) => r.slug),
  );
  if (!taken.has(wanted)) return wanted;
  for (let i = 2; ; i++) {
    const candidate = `${wanted.slice(0, 36)}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export interface NewSpace {
  name: string;
  slug?: string | undefined;
  color: SpaceColor;
  icon?: string | null | undefined;
  isDefault?: boolean;
  description?: string | undefined;
  visibility?: 'invite_only' | 'org' | undefined;
}

export async function createSharedSpace(
  db: DbOrTx,
  orgId: string,
  creatorId: string,
  input: NewSpace,
): Promise<SpaceRow> {
  if (input.color === PERSONAL_COLOR) {
    throw new AppError('validation_failed', {
      in: 'body',
      issues: [
        { path: ['color'], code: 'reserved', message: 's6 is reserved for personal spaces' },
      ],
    });
  }
  let slug: string;
  if (input.slug) {
    const [clash] = await db
      .select({ id: spaces.id })
      .from(spaces)
      .where(and(eq(spaces.orgId, orgId), eq(spaces.slug, input.slug)));
    if (clash) throw new AppError('space_slug_taken');
    slug = input.slug;
  } else {
    slug = await uniqueSlug(db, orgId, slugify(input.name));
  }
  const [space] = await db
    .insert(spaces)
    .values({
      orgId,
      kind: 'shared',
      name: input.name,
      slug,
      color: input.color,
      icon: input.icon ?? null,
      isDefault: input.isDefault ?? false,
      description: input.description ?? null,
      visibility: input.visibility ?? 'invite_only',
      createdBy: creatorId,
    })
    .returning();
  if (!space) throw new AppError('internal');
  await db.insert(spaceMembers).values({
    spaceId: space.id,
    userId: creatorId,
    orgId,
    role: 'owner',
    addedBy: creatorId,
  });
  return space;
}

/** Every member gets a personal space when joining an org (design doc 17 §4); guests do not. */
export async function ensurePersonalSpace(
  db: DbOrTx,
  orgId: string,
  user: { id: string; name: string },
): Promise<SpaceRow> {
  const [existing] = await db
    .select()
    .from(spaces)
    .where(
      and(eq(spaces.orgId, orgId), eq(spaces.ownerUserId, user.id), eq(spaces.kind, 'personal')),
    );
  if (existing) return existing;
  const [space] = await db
    .insert(spaces)
    .values({
      orgId,
      kind: 'personal',
      ownerUserId: user.id,
      name: user.name,
      slug: `p-${user.id.replaceAll('-', '').slice(-12)}`,
      color: PERSONAL_COLOR,
      // Personal quota default (design doc 17 §8): 10 GB.
      quotaBytes: 10 * 1024 ** 3,
      createdBy: user.id,
    })
    .returning();
  if (!space) throw new AppError('internal');
  await db
    .insert(spaceMembers)
    .values({ spaceId: space.id, userId: user.id, orgId, role: 'owner', addedBy: user.id });
  return space;
}

export async function personalSpaceId(db: DbOrTx, orgId: string, userId: string) {
  const [row] = await db
    .select({ id: spaces.id })
    .from(spaces)
    .where(
      and(eq(spaces.orgId, orgId), eq(spaces.ownerUserId, userId), eq(spaces.kind, 'personal')),
    );
  return row?.id ?? null;
}

/** Adds the user to the given shared spaces; existing memberships are left as they are. */
export async function joinSpaces(
  db: DbOrTx,
  orgId: string,
  userId: string,
  spaceIds: string[],
  role: SpaceRoleValue,
  addedBy: string,
) {
  if (spaceIds.length === 0) return;
  const valid = await db
    .select({ id: spaces.id })
    .from(spaces)
    .where(
      and(
        eq(spaces.orgId, orgId),
        inArray(spaces.id, spaceIds),
        eq(spaces.kind, 'shared'),
        isNull(spaces.archivedAt),
      ),
    );
  if (valid.length === 0) return;
  await db
    .insert(spaceMembers)
    .values(valid.map((s) => ({ spaceId: s.id, userId, orgId, role, addedBy })))
    .onConflictDoNothing();
}

export async function defaultSpaceIds(db: DbOrTx, orgId: string) {
  return (
    await db
      .select({ id: spaces.id })
      .from(spaces)
      .where(
        and(
          eq(spaces.orgId, orgId),
          eq(spaces.isDefault, true),
          eq(spaces.kind, 'shared'),
          isNull(spaces.archivedAt),
          isNull(spaces.deletedAt),
        ),
      )
  ).map((r) => r.id);
}

export async function getSpaceRow(db: DbOrTx, orgId: string, spaceId: string) {
  const [row] = await db
    .select()
    .from(spaces)
    .where(and(eq(spaces.orgId, orgId), eq(spaces.id, spaceId)));
  return row ?? null;
}

export async function myRoleIn(db: DbOrTx, spaceId: string, userId: string) {
  const [row] = await db
    .select({ role: spaceMembers.role })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)));
  return (row?.role ?? null) as SpaceRole | null;
}

// Correlated on the outer row by name: Drizzle does not qualify single-table columns.
const memberCount = sql<number>`(select count(*)::int from ${spaceMembers} sm where sm.space_id = "spaces"."id")`;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function toSpace(row: SpaceRow, myRole: SpaceRole, count: number): Space {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    slug: row.slug,
    color: row.color,
    icon: row.icon,
    myRole,
    memberCount: count,
    usedBytes: row.usedBytes,
    quotaBytes: row.quotaBytes,
    archivedAt: iso(row.archivedAt),
    createdAt: row.createdAt.toISOString(),
    isDefault: row.isDefault,
    description: row.description,
    visibility: row.visibility,
    deletedAt: iso(row.deletedAt),
    purgeAt: row.deletedAt
      ? new Date(row.deletedAt.getTime() + SPACE_DELETE_RETENTION_DAYS * 86_400_000).toISOString()
      : null,
  };
}

/** Spaces the user is a member of, personal first, then by name (Turkish collation). */
export async function listMySpaces(
  db: DbOrTx,
  orgId: string,
  userId: string,
  archived: boolean,
  deleted = false,
) {
  const rows = await db
    .select({ space: spaces, role: spaceMembers.role, count: memberCount })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
    .where(
      and(
        eq(spaceMembers.userId, userId),
        eq(spaces.orgId, orgId),
        // Deleted spaces are listed only for their owner, to restore them.
        deleted
          ? and(isNotNull(spaces.deletedAt), eq(spaceMembers.role, 'owner'))
          : and(
              isNull(spaces.deletedAt),
              archived ? isNotNull(spaces.archivedAt) : isNull(spaces.archivedAt),
            ),
      ),
    )
    .orderBy(sql`${spaces.kind} = 'shared'`, asc(spaces.name));
  return rows.map((r) => toSpace(r.space, r.role, r.count));
}

export async function loadSpace(db: DbOrTx, orgId: string, spaceId: string, userId: string) {
  const [row] = await db
    .select({ space: spaces, count: memberCount })
    .from(spaces)
    .where(and(eq(spaces.orgId, orgId), eq(spaces.id, spaceId)));
  if (!row) return null;
  const role = await myRoleIn(db, spaceId, userId);
  return { row: row.space, count: row.count, myRole: role };
}

export async function listOrgSharedSpaces(
  db: DbOrTx,
  orgId: string,
  userId: string,
  archived: boolean,
): Promise<OrgSpace[]> {
  const rows = await db
    .select({ space: spaces, count: memberCount })
    .from(spaces)
    .where(
      and(
        eq(spaces.orgId, orgId),
        eq(spaces.kind, 'shared'),
        isNull(spaces.deletedAt),
        archived ? isNotNull(spaces.archivedAt) : isNull(spaces.archivedAt),
      ),
    )
    .orderBy(asc(spaces.name));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.space.id);
  const memberships = await db
    .select({
      spaceId: spaceMembers.spaceId,
      userId: spaceMembers.userId,
      role: spaceMembers.role,
      name: users.name,
      email: users.email,
      image: users.image,
    })
    .from(spaceMembers)
    .innerJoin(users, eq(users.id, spaceMembers.userId))
    .where(
      and(
        inArray(spaceMembers.spaceId, ids),
        sql`(${spaceMembers.userId} = ${userId} or ${spaceMembers.role} = 'owner')`,
      ),
    );
  return rows.map(({ space, count }) => {
    const mine = memberships.find((m) => m.spaceId === space.id && m.userId === userId);
    const owner = memberships.find((m) => m.spaceId === space.id && m.role === 'owner');
    const { myRole: _omit, ...rest } = toSpace(space, 'viewer', count);
    return {
      ...rest,
      myRole: mine?.role ?? null,
      owner: owner
        ? { id: owner.userId, name: owner.name, email: owner.email, imageUrl: owner.image }
        : null,
    };
  });
}

export async function listSpaceMembers(db: DbOrTx, spaceId: string): Promise<SpaceMember[]> {
  const rows = await db
    .select({ m: spaceMembers, u: users })
    .from(spaceMembers)
    .innerJoin(users, eq(users.id, spaceMembers.userId))
    .where(eq(spaceMembers.spaceId, spaceId))
    .orderBy(
      sql`array_position(array['owner','admin','editor','viewer']::space_role[], ${spaceMembers.role})`,
      asc(users.name),
    );
  return rows.map(({ m, u }) => ({
    user: { id: u.id, name: u.name, email: u.email, imageUrl: u.image },
    role: m.role,
    addedAt: m.createdAt.toISOString(),
  }));
}

export async function spaceMember(db: DbOrTx, spaceId: string, userId: string) {
  const [row] = await db
    .select({ m: spaceMembers, u: users })
    .from(spaceMembers)
    .innerJoin(users, eq(users.id, spaceMembers.userId))
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)));
  if (!row) return null;
  return {
    user: { id: row.u.id, name: row.u.name, email: row.u.email, imageUrl: row.u.image },
    role: row.m.role,
    addedAt: row.m.createdAt.toISOString(),
  } satisfies SpaceMember;
}

/** Active org member, or null (guests included; suspended people are not). */
export async function activeOrgMember(db: DbOrTx, orgId: string, userId: string) {
  const [row] = await db
    .select()
    .from(orgMembers)
    .where(and(eq(orgMembers.organizationId, orgId), eq(orgMembers.userId, userId), liveMember()));
  return row ?? null;
}
