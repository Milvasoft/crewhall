import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { calendarAccounts } from './calendar';
import { organizations } from './org';
import { citext, id, textTr, timestamps, tz } from './types';

/**
 * Contacts and directory (roadmap 15). Owned by the contacts session. People of the directory
 * are users + org_members (platform); this table only adds the profile on top. Fields filled
 * by the AD/LDAP sync are listed in `synced_fields` and are read-only in the app.
 */
export const directoryProfiles = pgTable(
  'directory_profiles',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title'),
    department: textTr('department'),
    team: textTr('team'),
    phone: text('phone'),
    mobile: text('mobile'),
    location: textTr('location'),
    about: text('about'),
    managerId: uuid('manager_id').references(() => users.id, { onDelete: 'set null' }),
    /** Month and day only ('MM-DD', no year); others see it when birthday_visible is on. */
    birthday: text('birthday'),
    birthdayVisible: boolean('birthday_visible').notNull().default(false),
    /** First working day ('YYYY-MM-DD'): work anniversaries count from it. */
    startedOn: text('started_on'),
    syncedFields: text('synced_fields')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    syncedAt: tz('synced_at'),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.userId] }),
    index('directory_profiles_manager_idx').on(t.orgId, t.managerId),
  ],
);

export interface ContactEmailData {
  type: 'work' | 'home' | 'other';
  value: string;
}
export interface ContactPhoneData {
  type: 'work' | 'mobile' | 'home' | 'fax' | 'other';
  value: string;
}

export const contactCompanies = pgTable(
  'contact_companies',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: textTr('name').notNull(),
    kind: text('kind', { enum: ['customer', 'supplier', 'partner', 'other'] })
      .notNull()
      .default('customer'),
    domain: citext('domain'),
    website: text('website'),
    email: citext('email'),
    phone: text('phone'),
    address: text('address'),
    notes: text('notes'),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    visibility: text('visibility', { enum: ['org', 'private'] })
      .notNull()
      .default('org'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    deletedAt: tz('deleted_at'),
    ...timestamps(),
  },
  (t) => [
    index('contact_companies_org_idx').on(t.orgId),
    index('contact_companies_name_trgm_idx').using('gin', sql`${t.name} gin_trgm_ops`),
  ],
);

export const contacts = pgTable(
  'contacts',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** vCard UID (kept from imports and CardDAV clients). */
    uid: text('uid').notNull(),
    /** CardDAV resource name chosen by the client on PUT; null = `<id>.vcf`. */
    davName: text('dav_name'),
    kind: text('kind', { enum: ['customer', 'supplier', 'partner', 'other'] })
      .notNull()
      .default('customer'),
    firstName: text('first_name'),
    lastName: text('last_name'),
    displayName: textTr('display_name').notNull(),
    companyId: uuid('company_id').references(() => contactCompanies.id, { onDelete: 'set null' }),
    jobTitle: text('job_title'),
    emails: jsonb('emails').$type<ContactEmailData[]>().notNull().default([]),
    phones: jsonb('phones').$type<ContactPhoneData[]>().notNull().default([]),
    address: text('address'),
    website: text('website'),
    birthday: text('birthday'),
    notes: text('notes'),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    visibility: text('visibility', { enum: ['org', 'private'] })
      .notNull()
      .default('org'),
    /** Plain text of names, e-mails, phones, company and tags for search. */
    searchText: text('search_text').notNull().default(''),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    /** Mirrored from this account's address book (always private to the account's owner). */
    accountId: uuid('account_id').references(() => calendarAccounts.id, { onDelete: 'set null' }),
    externalId: text('external_id'),
    externalEtag: text('external_etag'),
    /** The provider's version is the one written from Crewhall. */
    writtenHere: boolean('written_here').notNull().default(false),
    deletedAt: tz('deleted_at'),
    ...timestamps(),
  },
  (t) => [
    index('contacts_org_idx').on(t.orgId),
    uniqueIndex('contacts_external_uq')
      .on(t.accountId, t.externalId)
      .where(sql`${t.accountId} is not null and ${t.deletedAt} is null`),
    uniqueIndex('contacts_uid_uq')
      .on(t.orgId, t.uid)
      .where(sql`${t.deletedAt} is null`),
    uniqueIndex('contacts_dav_name_uq')
      .on(t.orgId, t.davName)
      .where(sql`${t.davName} is not null and ${t.deletedAt} is null`),
    index('contacts_company_idx').on(t.companyId),
    index('contacts_search_trgm_idx').using('gin', sql`${t.searchText} gin_trgm_ops`),
  ],
);

/** A mirrored contact as it stood before someone overwrote it. */
export interface ContactVersionData {
  firstName: string | null;
  lastName: string | null;
  displayName: string;
  company: string | null;
  jobTitle: string | null;
  emails: ContactEmailData[];
  phones: ContactPhoneData[];
  address: string | null;
  website: string | null;
  birthday: string | null;
  notes: string | null;
  tags: string[];
}

/** Versions lost when a mirrored contact changed in two places at once. */
export const contactVersions = pgTable(
  'contact_versions',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    /** Whose version this is: what the provider held, or what Crewhall had written. */
    source: text('source', { enum: ['provider', 'crewhall'] }).notNull(),
    data: jsonb('data').$type<ContactVersionData>().notNull(),
    etag: text('etag'),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [index('contact_versions_contact_idx').on(t.contactId, t.createdAt)],
);
