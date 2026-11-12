import { and, inArray, isNull } from 'drizzle-orm';
import { contacts, type DbOrTx } from '@crewhall/db';

/**
 * A mirror leaves with its account, like the account's calendars. Soft: CardDAV clients learn of
 * it the way they learn of any deletion. Nothing happens at the provider.
 */
export async function dropMirror(db: DbOrTx, accountIds: string[]) {
  if (!accountIds.length) return;
  const now = new Date();
  await db
    .update(contacts)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(inArray(contacts.accountId, accountIds), isNull(contacts.deletedAt)));
}
