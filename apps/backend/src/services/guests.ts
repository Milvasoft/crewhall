import { and, eq, gt, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { conversationMembers, orgMembers, spaceMembers, type DbOrTx } from '@crewhall/db';
import type { Actor } from '@crewhall/shared';
import { AppError } from '../http/errors';
import { audit } from './audit';

/**
 * Guests (roadmap 13, design doc 17 §5 "Misafir"): people from outside the org who see only
 * the spaces and conversations they were added to, for a limited time if the admin says so.
 */

/** A membership that counts: active, and not past its end (guests). */
export function liveMember(): SQL {
  return and(
    eq(orgMembers.status, 'active'),
    or(isNull(orgMembers.expiresAt), gt(orgMembers.expiresAt, sql`now()`)),
  )!;
}

/** User ids a guest may see and reach: people who share a space or a conversation with them. */
export function guestPeers(userId: string): SQL {
  return sql`(
    select peer.user_id from ${spaceMembers} mine
      join ${spaceMembers} peer on peer.space_id = mine.space_id
      where mine.user_id = ${userId}
    union
    select cp.user_id from ${conversationMembers} cm
      join ${conversationMembers} cp on cp.conversation_id = cm.conversation_id
      where cm.user_id = ${userId}
  )`;
}

/** For guests: every one of `userIds` must be a peer; others pass through. */
export async function assertGuestReach(db: DbOrTx, actor: Actor, userIds: string[]) {
  if (actor.orgRole !== 'guest') return;
  const others = [...new Set(userIds.filter((id) => id !== actor.userId))];
  if (!others.length) return;
  const rows = await db.execute<{ id: string }>(
    sql`select p.user_id as id from ${guestPeers(actor.userId)} p(user_id)
        where p.user_id in (${sql.join(
          others.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`,
  );
  if (new Set(rows.rows.map((r) => r.id)).size < others.length) {
    throw new AppError('forbidden', { reason: 'guest_scope' });
  }
}

/**
 * guest.expire (hourly): guests past their end date are suspended, which closes every way
 * in (sessions resolve no active org, collab and WS refuse them). Extending the date in the
 * members list brings them back.
 */
export async function expireGuests(db: DbOrTx, now = new Date()) {
  const expired = await db
    .update(orgMembers)
    .set({ status: 'suspended' })
    .where(
      and(
        eq(orgMembers.role, 'guest'),
        eq(orgMembers.status, 'active'),
        lte(orgMembers.expiresAt, now),
      ),
    )
    .returning({ orgId: orgMembers.organizationId, userId: orgMembers.userId });
  for (const m of expired) {
    await audit(db, {
      orgId: m.orgId,
      actorId: null,
      action: 'org.member.status',
      targetType: 'user',
      targetId: m.userId,
      meta: { from: 'active', to: 'suspended', reason: 'guest_expired' },
    });
  }
  return expired.length;
}

export async function guestsOf(db: DbOrTx, orgId: string, userIds: string[]) {
  if (!userIds.length) return new Set<string>();
  const rows = await db
    .select({ userId: orgMembers.userId })
    .from(orgMembers)
    .where(
      and(
        eq(orgMembers.organizationId, orgId),
        eq(orgMembers.role, 'guest'),
        inArray(orgMembers.userId, userIds),
      ),
    );
  return new Set(rows.map((r) => r.userId));
}

/** Whether the person is a guest of the org (any status). */
export async function isGuest(db: DbOrTx, orgId: string, userId: string) {
  return (await guestsOf(db, orgId, [userId])).has(userId);
}
