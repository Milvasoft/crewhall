import { and, eq, ilike, sql } from 'drizzle-orm';
import { contactCompanies, contacts, type DbOrTx } from '@crewhall/db';
import type { ContactVisibility, ImportVcardResult } from '@crewhall/shared';
import { AppError } from '../../http/errors';
import type { ContactsActor } from './access';
import {
  createCompany,
  createContact,
  displayNameOf,
  searchTextOf,
  visibleTo,
  type ContactRow,
} from './contacts';
import { allPeople } from './directory';
import { buildVcard, parseVcards, type CardData, type CardOut } from './vcard';

/** vCard import and export of the address book and the directory (roadmap 15). */

export async function companyByName(
  db: DbOrTx,
  a: ContactsActor,
  name: string,
  visibility: ContactVisibility,
) {
  const [found] = await db
    .select()
    .from(contactCompanies)
    .where(and(visibleTo(a, contactCompanies), ilike(contactCompanies.name, name)));
  if (found) return found.id;
  const created = await createCompany(db, a, { name, kind: 'customer', tags: [], visibility });
  return created.id;
}

/** Existing contact for a card: same UID, else the same first e-mail. */
async function existingFor(db: DbOrTx, a: ContactsActor, card: CardData) {
  if (card.uid) {
    const [row] = await db
      .select()
      .from(contacts)
      .where(and(visibleTo(a, contacts), eq(contacts.uid, card.uid)));
    if (row) return row;
  }
  const email = card.emails[0]?.value;
  if (email) {
    const [row] = await db
      .select()
      .from(contacts)
      .where(
        and(
          visibleTo(a, contacts),
          sql`${contacts.emails} @> ${JSON.stringify([{ value: email }])}::jsonb`,
        ),
      );
    if (row) return row;
  }
  return null;
}

/** Card → contact columns (company resolved by name). */
export async function writeCard(
  db: DbOrTx,
  a: ContactsActor,
  card: CardData,
  visibility: ContactVisibility,
  target: ContactRow | null,
  opts: { davName?: string } = {},
): Promise<{ row: ContactRow; created: boolean }> {
  const companyId = card.company ? await companyByName(db, a, card.company, visibility) : null;
  const fields = {
    firstName: card.firstName,
    lastName: card.lastName,
    displayName: displayNameOf({
      displayName: card.displayName ?? (card.isCompany ? card.company : null),
      firstName: card.firstName,
      lastName: card.lastName,
    }),
    companyId,
    jobTitle: card.jobTitle,
    emails: card.emails,
    phones: card.phones,
    address: card.address,
    website: card.website,
    birthday: card.birthday,
    notes: card.notes,
    tags: card.tags,
  };
  if (target) {
    const [row] = await db
      .update(contacts)
      .set({
        ...fields,
        searchText: searchTextOf({ ...fields, company: card.company }),
        updatedAt: new Date(),
      })
      .where(eq(contacts.id, target.id))
      .returning();
    return { row: row!, created: false };
  }
  const row = await createContact(db, a, {
    ...fields,
    kind: 'customer',
    visibility,
    uid: card.uid ?? undefined,
    davName: opts.davName,
  });
  return { row, created: true };
}

export async function importVcards(
  db: DbOrTx,
  a: ContactsActor,
  text: string,
  visibility: ContactVisibility,
): Promise<ImportVcardResult> {
  const parsed = parseVcards(text);
  if (!parsed.cards.length && !parsed.errors.length) throw new AppError('contacts_vcard_invalid');
  const result: ImportVcardResult = {
    created: 0,
    updated: 0,
    skipped: parsed.errors.length,
    errors: parsed.errors.map((n) => ({ name: n, reason: 'no_name' })),
  };
  for (const card of parsed.cards) {
    try {
      const target = await existingFor(db, a, card);
      if (target && target.createdBy !== a.userId && target.visibility === 'private') {
        result.skipped++;
        continue;
      }
      // Mirrored contacts change at their account: a file must not change them behind its back.
      if (target?.accountId) {
        result.skipped++;
        result.errors.push({ name: card.displayName ?? card.company, reason: 'synced_contact' });
        continue;
      }
      const r = await writeCard(db, a, card, visibility, target);
      if (r.created) result.created++;
      else result.updated++;
    } catch {
      result.skipped++;
      result.errors.push({ name: card.displayName ?? card.company, reason: 'write_failed' });
    }
  }
  return result;
}

export async function contactCard(db: DbOrTx, row: ContactRow): Promise<CardOut> {
  const [company] = row.companyId
    ? await db
        .select({ name: contactCompanies.name })
        .from(contactCompanies)
        .where(eq(contactCompanies.id, row.companyId))
    : [];
  return {
    uid: row.uid,
    displayName: row.displayName,
    firstName: row.firstName,
    lastName: row.lastName,
    company: company?.name ?? null,
    jobTitle: row.jobTitle,
    emails: row.emails,
    phones: row.phones,
    address: row.address,
    website: row.website,
    birthday: row.birthday,
    notes: row.notes,
    tags: row.tags,
    updated: row.updatedAt,
  };
}

export async function exportContacts(db: DbOrTx, a: ContactsActor) {
  const rows = await db
    .select()
    .from(contacts)
    .where(visibleTo(a, contacts))
    .orderBy(contacts.displayName);
  const cards = await Promise.all(rows.map((r) => contactCard(db, r)));
  return cards.map(buildVcard).join('');
}

/** A directory person as a card (org name as ORG, department as its unit). */
export function personCard(
  orgName: string,
  r: Awaited<ReturnType<typeof allPeople>>[number],
): CardOut {
  const p = r.p;
  const [first, ...rest] = r.u.name.split(' ');
  return {
    uid: `crewhall-user-${r.u.id}`,
    displayName: r.u.name,
    firstName: rest.length ? (first ?? null) : r.u.name,
    lastName: rest.length ? rest.join(' ') : null,
    company: orgName,
    department: p?.department ?? null,
    jobTitle: p?.title ?? null,
    emails: [{ type: 'work', value: r.u.email }],
    phones: [
      ...(p?.phone ? [{ type: 'work' as const, value: p.phone }] : []),
      ...(p?.mobile ? [{ type: 'mobile' as const, value: p.mobile }] : []),
    ],
    address: p?.location ?? null,
    website: null,
    birthday: null,
    notes: p?.about ?? null,
    tags: p?.team ? [p.team] : [],
    updated: p?.updatedAt ?? r.u.updatedAt,
  };
}

export async function exportDirectory(db: DbOrTx, a: ContactsActor, orgName: string) {
  const rows = await allPeople(db, a);
  return rows.map((r) => buildVcard(personCard(orgName, r))).join('');
}
