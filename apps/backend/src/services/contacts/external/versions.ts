import { and, desc, eq, notInArray } from 'drizzle-orm';
import { contactVersions, type ContactVersionData, type DbOrTx } from '@crewhall/db';
import type { ContactVersion } from '@crewhall/shared';
import type { ContactRow } from './map';

/**
 * A mirrored contact's history, by the calendar's rule (calendar/external/versions.ts): the last
 * writer wins and only what was really lost is kept. `provider`: a Crewhall write found the
 * contact changed there. `crewhall`: a change there replaced what Crewhall wrote.
 */

const KEEP_PER_CONTACT = 20;

type Fields = Pick<
  ContactRow,
  | 'firstName'
  | 'lastName'
  | 'displayName'
  | 'jobTitle'
  | 'emails'
  | 'phones'
  | 'address'
  | 'website'
  | 'birthday'
  | 'notes'
  | 'tags'
>;

export function versionOf(row: Fields, company: string | null): ContactVersionData {
  return {
    firstName: row.firstName,
    lastName: row.lastName,
    displayName: row.displayName,
    company,
    jobTitle: row.jobTitle,
    emails: row.emails,
    phones: row.phones,
    address: row.address,
    website: row.website,
    birthday: row.birthday,
    notes: row.notes,
    tags: row.tags,
  };
}

/** Same content, whatever the order of the lists and however an address is capitalised. */
export function sameVersion(a: ContactVersionData, b: ContactVersionData) {
  const key = (v: ContactVersionData) =>
    JSON.stringify({
      ...v,
      emails: v.emails.map((e) => e.value.toLowerCase()).sort(),
      phones: v.phones.map((p) => `${p.type}:${p.value}`).sort(),
      tags: [...v.tags].sort(),
    });
  return key(a) === key(b);
}

export async function recordVersion(
  db: DbOrTx,
  input: {
    orgId: string;
    contactId: string;
    source: 'provider' | 'crewhall';
    data: ContactVersionData;
    etag: string | null;
  },
) {
  await db.insert(contactVersions).values(input);
  const keep = db
    .select({ id: contactVersions.id })
    .from(contactVersions)
    .where(eq(contactVersions.contactId, input.contactId))
    .orderBy(desc(contactVersions.createdAt), desc(contactVersions.id))
    .limit(KEEP_PER_CONTACT);
  await db
    .delete(contactVersions)
    .where(
      and(eq(contactVersions.contactId, input.contactId), notInArray(contactVersions.id, keep)),
    );
}

export async function listVersions(db: DbOrTx, contactId: string): Promise<ContactVersion[]> {
  const rows = await db
    .select()
    .from(contactVersions)
    .where(eq(contactVersions.contactId, contactId))
    .orderBy(desc(contactVersions.createdAt), desc(contactVersions.id));
  return rows.map((r) => ({
    id: r.id,
    overwritten: r.source,
    replacedAt: r.createdAt.toISOString(),
    ...r.data,
  }));
}
