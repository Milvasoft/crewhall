import { inArray } from 'drizzle-orm';
import { users, type DbOrTx } from '@crewhall/db';
import type { Actor, UserSummary } from '@crewhall/shared';
import type { OrgRow } from '../../http/types';
import { isModuleEnabled } from '../identity/modules';

/** Who is asking, in the active org. */
export interface ContactsActor {
  org: OrgRow;
  actor: Actor;
  userId: string;
  userName: string;
  userEmail: string;
}

/** The org may switch contacts off; jobs and CardDAV check it themselves. */
export function contactsEnabled(db: DbOrTx, orgId: string) {
  return isModuleEnabled(db, orgId, 'contacts');
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
