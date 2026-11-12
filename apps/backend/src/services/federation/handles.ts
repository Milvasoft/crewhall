import { and, eq, sql } from 'drizzle-orm';
import { federationHandles, federationUsers, orgMembers, users, type DbOrTx } from '@crewhall/db';

/**
 * Federated handles (`handle@domain`): the e-mail's local part, lower case and limited to
 * [a-z0-9._-], with a number added on a clash. Fixed once given, so a changed e-mail keeps
 * the address.
 */

export function handleBase(email: string): string {
  const local = email.slice(0, email.indexOf('@') >= 0 ? email.indexOf('@') : undefined);
  const cleaned = local
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ı/g, 'i')
    .replace(/[^a-z0-9._-]+/g, '.')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 48);
  return cleaned || 'user';
}

/** Active, non-guest member of the org: only they get an address. */
async function federatable(db: DbOrTx, orgId: string, userId: string) {
  const [m] = await db
    .select({ role: orgMembers.role, status: orgMembers.status })
    .from(orgMembers)
    .where(and(eq(orgMembers.organizationId, orgId), eq(orgMembers.userId, userId)));
  return !!m && m.status === 'active' && m.role !== 'guest';
}

export async function handleOf(db: DbOrTx, orgId: string, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ handle: federationHandles.handle })
    .from(federationHandles)
    .where(eq(federationHandles.userId, userId));
  if (row) return row.handle;
  if (!(await federatable(db, orgId, userId))) return null;
  const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
  if (!user) return null;
  const base = handleBase(user.email);
  for (let i = 1; i < 1000; i++) {
    const handle = i === 1 ? base : `${base}${i}`;
    const [taken] = await db
      .insert(federationHandles)
      .values({ userId, orgId, handle })
      .onConflictDoNothing()
      .returning({ handle: federationHandles.handle });
    if (taken) return taken.handle;
    // Another request gave this person a handle meanwhile.
    const [mine] = await db
      .select({ handle: federationHandles.handle })
      .from(federationHandles)
      .where(eq(federationHandles.userId, userId));
    if (mine) return mine.handle;
  }
  return null;
}

/**
 * The local person behind a handle. A person who never got a handle yet is found by the
 * local part of their e-mail and given it now.
 */
export async function userByHandle(db: DbOrTx, orgId: string, handle: string) {
  const [row] = await db
    .select({ userId: federationHandles.userId })
    .from(federationHandles)
    .where(and(eq(federationHandles.orgId, orgId), eq(federationHandles.handle, handle)));
  let userId = row?.userId ?? null;
  if (!userId) {
    const candidates = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .innerJoin(orgMembers, eq(orgMembers.userId, users.id))
      .where(
        and(
          eq(orgMembers.organizationId, orgId),
          sql`lower(split_part(${users.email}, '@', 1)) like ${`${handle.split(/[._-]/)[0]}%`}`,
        ),
      );
    const match = candidates.find((c) => handleBase(c.email) === handle);
    if (match && (await handleOf(db, orgId, match.id)) === handle) userId = match.id;
  }
  if (!userId || !(await federatable(db, orgId, userId))) return null;
  const [user] = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(eq(users.id, userId));
  return user ?? null;
}

/** Remembers a person on a peer (name refreshed on every sighting). */
export async function upsertRemoteUser(
  db: DbOrTx,
  orgId: string,
  peerId: string,
  handle: string,
  name: string,
) {
  const [row] = await db
    .insert(federationUsers)
    .values({ orgId, peerId, handle, name: name.slice(0, 200) })
    .onConflictDoUpdate({
      target: [federationUsers.peerId, federationUsers.handle],
      set: { name: name.slice(0, 200), updatedAt: new Date() },
    })
    .returning();
  return row!;
}
