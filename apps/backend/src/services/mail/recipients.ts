import { and, asc, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import {
  contacts,
  mailAccounts,
  mailRecentRecipients,
  orgMembers,
  users,
  type DbOrTx,
} from '@crewhall/db';
import type { MailRecipientSuggestion, MailRecipientsQuery } from '@crewhall/shared';
import { contactsEnabled } from '../contacts/access';

const like = (q: string) => `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

/**
 * Recipient autocomplete: people this user wrote to first (most used), then active org members
 * with their mailbox address when they connected one, then external contacts (roadmap 15) the
 * user may see while the contacts module is on.
 */
export async function suggestRecipients(
  db: DbOrTx,
  orgId: string,
  userId: string,
  q: MailRecipientsQuery,
): Promise<MailRecipientSuggestion[]> {
  const term = like(q.q);
  const recent = await db
    .select()
    .from(mailRecentRecipients)
    .where(
      and(
        eq(mailRecentRecipients.orgId, orgId),
        eq(mailRecentRecipients.userId, userId),
        q.q
          ? or(ilike(mailRecentRecipients.address, term), ilike(mailRecentRecipients.name, term))
          : undefined,
      ),
    )
    .orderBy(desc(mailRecentRecipients.useCount), desc(mailRecentRecipients.lastUsedAt))
    .limit(q.limit);

  const members = await db
    .select({ name: users.name, email: users.email, mailbox: mailAccounts.email })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.userId))
    .leftJoin(
      mailAccounts,
      and(
        eq(mailAccounts.userId, users.id),
        eq(mailAccounts.orgId, orgId),
        eq(mailAccounts.kind, 'personal'),
      ),
    )
    .where(
      and(
        eq(orgMembers.organizationId, orgId),
        eq(orgMembers.status, 'active'),
        q.q
          ? or(ilike(users.name, term), ilike(users.email, term), ilike(mailAccounts.email, term))
          : undefined,
      ),
    )
    .orderBy(asc(users.name))
    .limit(q.limit);

  const people =
    q.q && (await contactsEnabled(db, orgId))
      ? await db
          .select({ name: contacts.displayName, emails: contacts.emails })
          .from(contacts)
          .where(
            and(
              eq(contacts.orgId, orgId),
              isNull(contacts.deletedAt),
              or(eq(contacts.visibility, 'org'), eq(contacts.createdBy, userId)),
              ilike(contacts.searchText, like(q.q.toLocaleLowerCase('tr'))),
              sql`jsonb_array_length(${contacts.emails}) > 0`,
            ),
          )
          .orderBy(asc(contacts.displayName))
          .limit(q.limit)
      : [];

  const out = new Map<string, MailRecipientSuggestion>();
  for (const r of recent)
    out.set(r.address, { name: r.name, address: r.address, source: 'recent' });
  for (const m of members) {
    const address = (m.mailbox ?? m.email).toLowerCase();
    if (!out.has(address)) out.set(address, { name: m.name, address, source: 'member' });
  }
  for (const c of people) {
    for (const e of c.emails) {
      const address = e.value.toLowerCase();
      if (!out.has(address)) out.set(address, { name: c.name, address, source: 'contact' });
    }
  }
  return [...out.values()].slice(0, q.limit);
}
