import { and, asc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { authLockouts, orgMembers, users, type DbOrTx } from '@crewhall/db';
import { guestPeers } from './guests';
import type { Actor, OrgMember, OrgPermission, UpdateOrgMember } from '@crewhall/shared';
import { AppError } from '../http/errors';
import type { MemberRow, RequestInfo } from '../http/types';
import { audit } from './audit';
import { clearLockout } from './lockout';
import { defaultSpaceIds, ensurePersonalSpace, joinSpaces } from './spaces';

type UserRow = typeof users.$inferSelect;

/**
 * `lock` is passed only to people who manage members: it is the end of the sign-in
 * lock (1.16) and becomes `lockedUntil` while it is in the future.
 */
export function toOrgMember(m: MemberRow, u: UserRow, lock?: { until: Date | null }): OrgMember {
  const lockedUntil =
    lock === undefined
      ? {}
      : { lockedUntil: lock.until && lock.until > new Date() ? lock.until.toISOString() : null };
  return {
    ...lockedUntil,
    user: { id: u.id, name: u.name, email: u.email, imageUrl: u.image },
    role: m.role,
    permissions: m.permissions as OrgPermission[],
    status: m.status,
    twoFactorEnabled: u.twoFactorEnabled,
    joinedAt: m.joinedAt ? m.joinedAt.toISOString() : null,
    lastSeenAt: u.lastSeenAt ? u.lastSeenAt.toISOString() : null,
    expiresAt: m.expiresAt ? m.expiresAt.toISOString() : null,
  };
}

const encodeCursor = (name: string, id: string) =>
  Buffer.from(JSON.stringify([name, id])).toString('base64url');

function decodeCursor(cursor: string): [string, string] {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === 'string' &&
      typeof value[1] === 'string'
    ) {
      return [value[0], value[1]];
    }
  } catch {
    // fall through
  }
  throw new AppError('bad_request', { reason: 'invalid_cursor' });
}

export interface MemberQuery {
  cursor?: string | undefined;
  limit: number;
  q?: string | undefined;
  role?: OrgMember['role'] | undefined;
  status?: OrgMember['status'] | undefined;
}

/**
 * Org directory, sorted by name with Turkish collation. Guests only see people they
 * share a space or a conversation with (design doc 17 §5 "Misafir").
 */
export async function listMembers(
  db: DbOrTx,
  orgId: string,
  actor: Actor,
  query: MemberQuery,
  showLocks: boolean,
) {
  // Pending invitations live in their own list; no org_members row is "invited" yet.
  if (query.status === 'invited') return { items: [], nextCursor: null };

  const conds: SQL[] = [eq(orgMembers.organizationId, orgId)];
  if (query.role) conds.push(eq(orgMembers.role, query.role));
  if (query.status) conds.push(eq(orgMembers.status, query.status));
  if (query.q?.trim()) {
    const term = `%${query.q.trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    const match = or(ilike(users.name, term), ilike(users.email, term));
    if (match) conds.push(match);
  }
  if (actor.orgRole === 'guest') {
    conds.push(sql`${users.id} in ${guestPeers(actor.userId)}`);
  }
  if (query.cursor) {
    const [name, id] = decodeCursor(query.cursor);
    conds.push(sql`(${users.name}, ${users.id}) > (${name}, ${id}::uuid)`);
  }

  const rows = await db
    .select({ m: orgMembers, u: users, lockedUntil: authLockouts.lockedUntil })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.userId))
    .leftJoin(authLockouts, eq(authLockouts.email, users.email))
    .where(and(...conds))
    .orderBy(asc(users.name), asc(users.id))
    .limit(query.limit + 1);

  const pageRows = rows.slice(0, query.limit);
  const last = pageRows.at(-1);
  return {
    items: pageRows.map((r) =>
      toOrgMember(r.m, r.u, showLocks ? { until: r.lockedUntil } : undefined),
    ),
    nextCursor: rows.length > query.limit && last ? encodeCursor(last.u.name, last.u.id) : null,
  };
}

export async function getMember(db: DbOrTx, orgId: string, userId: string) {
  const [row] = await db
    .select({ m: orgMembers, u: users, lockedUntil: authLockouts.lockedUntil })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.userId))
    .leftJoin(authLockouts, eq(authLockouts.email, users.email))
    .where(and(eq(orgMembers.organizationId, orgId), eq(orgMembers.userId, userId)));
  return row ?? null;
}

export async function updateMember(
  db: DbOrTx,
  orgId: string,
  actorId: string,
  targetUserId: string,
  input: UpdateOrgMember,
  req: RequestInfo,
): Promise<OrgMember> {
  const target = await getMember(db, orgId, targetUserId);
  if (!target) throw new AppError('member_not_found');
  if (target.m.role === 'owner') throw new AppError('cannot_change_owner');
  if (targetUserId === actorId && input.status === 'suspended') {
    throw new AppError('forbidden', { reason: 'cannot_suspend_self' });
  }

  const patch: Partial<MemberRow> = {};
  if (input.role && input.role !== target.m.role) patch.role = input.role;
  if (input.status && input.status !== target.m.status) patch.status = input.status;
  if (input.permissions) patch.permissions = [...new Set(input.permissions)];
  const role = patch.role ?? target.m.role;
  // Guests get no org permissions (portal.*) and are the only ones with an end date.
  if (role === 'guest' && (patch.permissions ?? target.m.permissions).length) {
    if (input.permissions?.length) throw new AppError('forbidden', { reason: 'guest_permissions' });
    patch.permissions = [];
  }
  if (input.expiresAt !== undefined) {
    if (role !== 'guest' && input.expiresAt !== null) {
      throw new AppError('validation_failed', { field: 'expiresAt', reason: 'guests_only' });
    }
    const until = input.expiresAt === null ? null : new Date(input.expiresAt);
    if (until && until <= new Date()) {
      throw new AppError('validation_failed', { field: 'expiresAt', reason: 'in_past' });
    }
    if ((until?.getTime() ?? null) !== (target.m.expiresAt?.getTime() ?? null)) {
      patch.expiresAt = until;
    }
    // A guest the hourly job suspended comes back with a new end date.
    const expired = target.m.expiresAt !== null && target.m.expiresAt <= new Date();
    if (target.m.status === 'suspended' && expired && input.status === undefined) {
      patch.status = 'active';
    }
  }
  if (patch.role && patch.role !== 'guest' && target.m.expiresAt) patch.expiresAt = null;
  if (Object.keys(patch).length === 0) {
    return toOrgMember(target.m, target.u, { until: target.lockedUntil });
  }

  const [updated] = await db
    .update(orgMembers)
    .set(patch)
    .where(eq(orgMembers.id, target.m.id))
    .returning();
  if (!updated) throw new AppError('member_not_found');

  // A guest promoted to member gets what members get on joining.
  if (patch.role && target.m.role === 'guest') {
    await ensurePersonalSpace(db, orgId, target.u);
    await joinSpaces(db, orgId, target.u.id, await defaultSpaceIds(db, orgId), 'viewer', actorId);
  }

  const base = { orgId, actorId, targetType: 'user', targetId: targetUserId };
  if (patch.role) {
    await audit(
      db,
      { ...base, action: 'org.member.role', meta: { from: target.m.role, to: patch.role } },
      req,
    );
  }
  if (patch.status) {
    await audit(
      db,
      { ...base, action: 'org.member.status', meta: { from: target.m.status, to: patch.status } },
      req,
    );
  }
  if (patch.expiresAt !== undefined) {
    await audit(
      db,
      {
        ...base,
        action: 'org.member.expiry',
        meta: {
          from: target.m.expiresAt?.toISOString() ?? null,
          to: patch.expiresAt?.toISOString() ?? null,
        },
      },
      req,
    );
  }
  if (patch.permissions) {
    await audit(
      db,
      {
        ...base,
        action: 'org.member.permissions',
        meta: { from: target.m.permissions, to: patch.permissions },
      },
      req,
    );
  }
  return toOrgMember(updated, target.u, { until: target.lockedUntil });
}

/** Lifts a member's sign-in lock early (org.manage_members); audited as auth.account.unlocked. */
export async function unlockMember(
  db: DbOrTx,
  orgId: string,
  actorId: string,
  targetUserId: string,
  req: RequestInfo,
): Promise<OrgMember> {
  const target = await getMember(db, orgId, targetUserId);
  if (!target) throw new AppError('member_not_found');
  await clearLockout(db, target.u.email);
  await audit(
    db,
    {
      orgId,
      actorId,
      action: 'auth.account.unlocked',
      targetType: 'user',
      targetId: targetUserId,
      meta: { email: target.u.email, wasLockedUntil: target.lockedUntil?.toISOString() ?? null },
    },
    req,
  );
  return toOrgMember(target.m, target.u, { until: null });
}
