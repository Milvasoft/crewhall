import { randomUUID } from 'node:crypto';
import { and, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { calendarAccounts, contactCompanies, contacts, type DbOrTx } from '@crewhall/db';
import {
  canContacts,
  type Contact,
  type ContactCompany,
  type ContactVisibility,
  type UpdateContact,
  type UpdateContactCompany,
} from '@crewhall/shared';
import type { z } from 'zod';
import type {
  CompanyQuery,
  ContactQuery,
  CreateContact,
  CreateContactCompany,
} from '@crewhall/shared';
import { AppError } from '../../http/errors';
import { usersByIds, type ContactsActor } from './access';

/**
 * External contacts and companies (roadmap 15): a shared address book of the org (customers,
 * suppliers, partners) with tags, plus private entries only their creator sees.
 */

export type ContactRow = typeof contacts.$inferSelect;
export type CompanyRow = typeof contactCompanies.$inferSelect;
type ContactIn = z.output<typeof CreateContact>;
type CompanyIn = z.output<typeof CreateContactCompany>;

const like = (q: string) => `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

/** Tag identity ignores case (I/ı and İ/i alike); the first spelling wins. */
const tagKey = (t: string) => t.toLocaleLowerCase('tr').replace(/ı/g, 'i');

export const normTags = (tags: string[]) => {
  const seen = new Map<string, string>();
  for (const t of tags.map((x) => x.trim()).filter(Boolean)) {
    if (!seen.has(tagKey(t))) seen.set(tagKey(t), t);
  }
  return [...seen.values()];
};

/** Rows the caller may see: org-wide ones and their own private ones. */
export function visibleTo(a: ContactsActor, table: typeof contacts | typeof contactCompanies): SQL {
  return and(
    eq(table.orgId, a.org.id),
    isNull(table.deletedAt),
    or(eq(table.visibility, 'org'), eq(table.createdBy, a.userId)),
  )!;
}

function requireMember(a: ContactsActor) {
  if (!canContacts('create', { orgRole: a.actor.orgRole })) throw new AppError('forbidden');
}

const rights = (
  a: ContactsActor,
  row: { createdBy: string | null; visibility: ContactVisibility },
) => {
  const input = {
    orgRole: a.actor.orgRole,
    own: row.createdBy === a.userId,
    visibility: row.visibility,
  };
  return { edit: canContacts('edit', input), delete: canContacts('delete', input) };
};

export function searchTextOf(c: {
  displayName: string;
  firstName?: string | null;
  lastName?: string | null;
  jobTitle?: string | null;
  emails: { value: string }[];
  phones: { value: string }[];
  tags: string[];
  notes?: string | null;
  company?: string | null;
}) {
  return [
    c.displayName,
    c.firstName,
    c.lastName,
    c.jobTitle,
    c.company,
    ...c.emails.map((e) => e.value),
    ...c.phones.map((p) => p.value),
    // Digits alone too, so "0532 111" finds "+90 532 111 22 33".
    ...c.phones.map((p) => p.value.replace(/\D/g, '')),
    ...c.tags,
  ]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase('tr');
}

export function displayNameOf(c: {
  displayName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}) {
  return (
    c.displayName?.trim() ||
    [c.firstName, c.lastName].filter(Boolean).join(' ').trim() ||
    '—'
  ).slice(0, 160);
}

// ---- companies ----------------------------------------------------------------------------------

async function companyCounts(db: DbOrTx, a: ContactsActor, ids: string[]) {
  if (!ids.length) return new Map<string, number>();
  const rows = await db
    .select({ id: contacts.companyId, n: sql<number>`count(*)::int` })
    .from(contacts)
    .where(and(visibleTo(a, contacts), inArray(contacts.companyId, ids)))
    .groupBy(contacts.companyId);
  return new Map(rows.map((r) => [r.id!, r.n]));
}

export async function toCompanies(
  db: DbOrTx,
  a: ContactsActor,
  rows: CompanyRow[],
): Promise<ContactCompany[]> {
  const [counts, people] = await Promise.all([
    companyCounts(
      db,
      a,
      rows.map((r) => r.id),
    ),
    usersByIds(
      db,
      rows.map((r) => r.createdBy),
    ),
  ]);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    domain: r.domain,
    website: r.website,
    email: r.email,
    phone: r.phone,
    address: r.address,
    notes: r.notes,
    tags: r.tags,
    visibility: r.visibility,
    contactCount: counts.get(r.id) ?? 0,
    createdBy: r.createdBy ? (people.get(r.createdBy) ?? null) : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    permissions: rights(a, r),
  }));
}

export async function loadCompany(db: DbOrTx, a: ContactsActor, companyId: string) {
  requireMember(a);
  const [row] = await db
    .select()
    .from(contactCompanies)
    .where(and(eq(contactCompanies.id, companyId), visibleTo(a, contactCompanies)));
  if (!row) throw new AppError('not_found');
  return row;
}

export async function listCompanies(
  db: DbOrTx,
  a: ContactsActor,
  q: z.output<typeof CompanyQuery>,
) {
  requireMember(a);
  const conds: SQL[] = [visibleTo(a, contactCompanies)];
  if (q.q?.trim()) {
    const t = like(q.q.trim());
    conds.push(
      or(
        ilike(contactCompanies.name, t),
        ilike(contactCompanies.domain, t),
        ilike(contactCompanies.email, t),
        sql`array_to_string(${contactCompanies.tags}, ' ') ilike ${t}`,
      )!,
    );
  }
  if (q.kind) conds.push(eq(contactCompanies.kind, q.kind));
  if (q.tag) conds.push(sql`${q.tag} = any(${contactCompanies.tags})`);
  const offset = Number(q.cursor ?? 0) || 0;
  const rows = await db
    .select()
    .from(contactCompanies)
    .where(and(...conds))
    .orderBy(contactCompanies.name, contactCompanies.id)
    .limit(q.limit + 1)
    .offset(offset);
  return {
    items: await toCompanies(db, a, rows.slice(0, q.limit)),
    nextCursor: rows.length > q.limit ? String(offset + q.limit) : null,
  };
}

export async function createCompany(db: DbOrTx, a: ContactsActor, input: CompanyIn) {
  requireMember(a);
  const [row] = await db
    .insert(contactCompanies)
    .values({
      orgId: a.org.id,
      name: input.name,
      kind: input.kind,
      domain: input.domain ?? null,
      website: input.website ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      address: input.address ?? null,
      notes: input.notes ?? null,
      tags: normTags(input.tags),
      visibility: input.visibility,
      createdBy: a.userId,
    })
    .returning();
  return (await toCompanies(db, a, [row!]))[0]!;
}

export async function updateCompany(
  db: DbOrTx,
  a: ContactsActor,
  companyId: string,
  patch: UpdateContactCompany,
) {
  const row = await loadCompany(db, a, companyId);
  if (!rights(a, row).edit) throw new AppError('forbidden');
  const set: Partial<CompanyRow> = {};
  for (const k of [
    'name',
    'kind',
    'domain',
    'website',
    'email',
    'phone',
    'address',
    'notes',
    'visibility',
  ] as const) {
    if (patch[k] !== undefined) (set as Record<string, unknown>)[k] = patch[k];
  }
  // Only the creator may make an org entry private (or back).
  if (patch.visibility !== undefined && row.createdBy !== a.userId) delete set.visibility;
  if (patch.tags !== undefined) set.tags = normTags(patch.tags);
  const [fresh] = await db
    .update(contactCompanies)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(contactCompanies.id, companyId))
    .returning();
  if (patch.name !== undefined) await reindexCompanyContacts(db, companyId);
  return (await toCompanies(db, a, [fresh!]))[0]!;
}

export async function deleteCompany(db: DbOrTx, a: ContactsActor, companyId: string) {
  const row = await loadCompany(db, a, companyId);
  if (!rights(a, row).delete) throw new AppError('forbidden');
  await db.update(contacts).set({ companyId: null }).where(eq(contacts.companyId, companyId));
  await db
    .update(contactCompanies)
    .set({ deletedAt: new Date() })
    .where(eq(contactCompanies.id, companyId));
}

async function reindexCompanyContacts(db: DbOrTx, companyId: string) {
  const [company] = await db
    .select()
    .from(contactCompanies)
    .where(eq(contactCompanies.id, companyId));
  const rows = await db.select().from(contacts).where(eq(contacts.companyId, companyId));
  for (const r of rows) {
    await db
      .update(contacts)
      .set({ searchText: searchTextOf({ ...r, company: company?.name ?? null }) })
      .where(eq(contacts.id, r.id));
  }
}

// ---- contacts -----------------------------------------------------------------------------------

export async function toContacts(
  db: DbOrTx,
  a: ContactsActor,
  rows: ContactRow[],
): Promise<Contact[]> {
  const companyIds = [
    ...new Set(rows.map((r) => r.companyId).filter((x): x is string => Boolean(x))),
  ];
  const accountIds = [
    ...new Set(rows.map((r) => r.accountId).filter((x): x is string => Boolean(x))),
  ];
  const [companies, people, accounts] = await Promise.all([
    companyIds.length
      ? db
          .select({ id: contactCompanies.id, name: contactCompanies.name })
          .from(contactCompanies)
          .where(and(inArray(contactCompanies.id, companyIds), visibleTo(a, contactCompanies)))
      : Promise.resolve([]),
    usersByIds(
      db,
      rows.map((r) => r.createdBy),
    ),
    accountIds.length
      ? db
          .select({
            accountId: calendarAccounts.id,
            provider: calendarAccounts.provider,
            email: calendarAccounts.email,
          })
          .from(calendarAccounts)
          .where(inArray(calendarAccounts.id, accountIds))
      : Promise.resolve([]),
  ]);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    firstName: r.firstName,
    lastName: r.lastName,
    displayName: r.displayName,
    company: companies.find((c) => c.id === r.companyId) ?? null,
    jobTitle: r.jobTitle,
    emails: r.emails,
    phones: r.phones,
    address: r.address,
    website: r.website,
    birthday: r.birthday,
    notes: r.notes,
    tags: r.tags,
    visibility: r.visibility,
    createdBy: r.createdBy ? (people.get(r.createdBy) ?? null) : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    permissions: rights(a, r),
    external: accounts.find((x) => x.accountId === r.accountId) ?? null,
  }));
}

export async function loadContact(db: DbOrTx, a: ContactsActor, contactId: string) {
  requireMember(a);
  const [row] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, contactId), visibleTo(a, contacts)));
  if (!row) throw new AppError('not_found');
  return row;
}

export async function listContacts(db: DbOrTx, a: ContactsActor, q: z.output<typeof ContactQuery>) {
  requireMember(a);
  const conds: SQL[] = [visibleTo(a, contacts)];
  const term = q.q?.trim().toLocaleLowerCase('tr');
  if (term) {
    const digits = term.replace(/\D/g, '');
    conds.push(
      or(
        ilike(contacts.searchText, like(term)),
        ...(digits.length >= 3 && digits.length === term.replace(/[\s()+-]/g, '').length
          ? [ilike(contacts.searchText, like(digits))]
          : []),
      )!,
    );
  }
  if (q.kind) conds.push(eq(contacts.kind, q.kind));
  if (q.companyId) conds.push(eq(contacts.companyId, q.companyId));
  if (q.tag) conds.push(sql`${q.tag} = any(${contacts.tags})`);
  if (q.mine)
    conds.push(and(eq(contacts.visibility, 'private'), eq(contacts.createdBy, a.userId))!);
  const offset = Number(q.cursor ?? 0) || 0;
  const rows = await db
    .select()
    .from(contacts)
    .where(and(...conds))
    .orderBy(contacts.displayName, contacts.id)
    .limit(q.limit + 1)
    .offset(offset);
  return {
    items: await toContacts(db, a, rows.slice(0, q.limit)),
    nextCursor: rows.length > q.limit ? String(offset + q.limit) : null,
  };
}

async function companyName(db: DbOrTx, a: ContactsActor, companyId: string | null | undefined) {
  if (!companyId) return null;
  return (await loadCompany(db, a, companyId)).name;
}

export async function createContact(
  db: DbOrTx,
  a: ContactsActor,
  input: ContactIn & { uid?: string; davName?: string },
) {
  requireMember(a);
  const company = await companyName(db, a, input.companyId);
  const displayName = displayNameOf(input);
  const tags = normTags(input.tags);
  const [row] = await db
    .insert(contacts)
    .values({
      orgId: a.org.id,
      uid: input.uid ?? `${randomUUID()}`,
      davName: input.davName ?? null,
      kind: input.kind,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      displayName,
      companyId: input.companyId ?? null,
      jobTitle: input.jobTitle ?? null,
      emails: input.emails,
      phones: input.phones,
      address: input.address ?? null,
      website: input.website ?? null,
      birthday: input.birthday ?? null,
      notes: input.notes ?? null,
      tags,
      visibility: input.visibility,
      searchText: searchTextOf({ ...input, displayName, tags, company }),
      createdBy: a.userId,
    })
    .returning();
  return row!;
}

export async function updateContact(
  db: DbOrTx,
  a: ContactsActor,
  contactId: string,
  patch: UpdateContact,
) {
  const row = await loadContact(db, a, contactId);
  if (!rights(a, row).edit) throw new AppError('forbidden');
  const set: Partial<ContactRow> = {};
  for (const k of [
    'kind',
    'firstName',
    'lastName',
    'companyId',
    'jobTitle',
    'emails',
    'phones',
    'address',
    'website',
    'birthday',
    'notes',
    'visibility',
  ] as const) {
    if (patch[k] !== undefined) (set as Record<string, unknown>)[k] = patch[k];
  }
  // Someone's mailbox stays theirs: a mirrored contact cannot become the org's.
  if (patch.visibility !== undefined && (row.createdBy !== a.userId || row.accountId)) {
    delete set.visibility;
  }
  if (patch.tags !== undefined) set.tags = normTags(patch.tags);
  const next = { ...row, ...set };
  if (
    patch.displayName !== undefined ||
    patch.firstName !== undefined ||
    patch.lastName !== undefined
  ) {
    set.displayName = displayNameOf({
      displayName:
        patch.displayName ??
        (patch.firstName !== undefined || patch.lastName !== undefined ? null : row.displayName),
      firstName: next.firstName,
      lastName: next.lastName,
    });
  }
  const company = await companyName(db, a, next.companyId);
  set.searchText = searchTextOf({
    ...next,
    displayName: set.displayName ?? row.displayName,
    company,
  });
  const [fresh] = await db
    .update(contacts)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(contacts.id, contactId))
    .returning();
  return fresh!;
}

export async function deleteContact(db: DbOrTx, a: ContactsActor, contactId: string) {
  const row = await loadContact(db, a, contactId);
  if (!rights(a, row).delete) throw new AppError('forbidden');
  await db.update(contacts).set({ deletedAt: new Date() }).where(eq(contacts.id, contactId));
}

export async function listTags(db: DbOrTx, a: ContactsActor) {
  requireMember(a);
  const rows = await db.execute<{ tag: string; count: number }>(sql`
    select tag, count(*)::int as count from (
      select unnest(${contacts.tags}) as tag from ${contacts} where ${visibleTo(a, contacts)}
      union all
      select unnest(${contactCompanies.tags}) as tag from ${contactCompanies} where ${visibleTo(a, contactCompanies)}
    ) t group by tag order by count(*) desc, tag limit 200`);
  return { items: rows.rows.map((r) => ({ tag: r.tag, count: Number(r.count) })) };
}

/** Latest first, for CardDAV and exports. */
export function contactsOrder() {
  return [desc(contacts.updatedAt)];
}
