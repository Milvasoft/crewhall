import { z } from 'zod';
import { Id, PageQuery, Timestamp } from './common';
import { OrgRole, UserSummary } from './org';

/**
 * Contacts and directory module (roadmap 15). The org directory is the org's members (users
 * and org_members from the platform, AD/LDAP synced by identity) with a profile on top: title,
 * department, team, phones, office and the manager line that draws the org chart. External
 * contacts (customers, suppliers, partners) and their companies form a shared address book
 * with tags. Both are reachable over CardDAV (`/carddav`) and as vCard files.
 */

// ---- directory ---------------------------------------------------------------------------------

/** Profile fields a directory sync (AD/LDAP) may own; those are read-only in the app. */
export const DIRECTORY_FIELDS = [
  'title',
  'department',
  'team',
  'phone',
  'mobile',
  'location',
  'managerId',
] as const;
export const DirectoryField = z.enum(DIRECTORY_FIELDS);
export type DirectoryField = z.infer<typeof DirectoryField>;

const text = (max: number) => z.string().trim().max(max);

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
/** 'MM-DD', a real day of the year (29 February allowed). */
export const MonthDay = z
  .string()
  .regex(/^\d{2}-\d{2}$/)
  .refine((v) => {
    const [m, d] = v.split('-').map(Number) as [number, number];
    return m >= 1 && m <= 12 && d >= 1 && d <= DAYS_IN_MONTH[m - 1]!;
  });
/** 'YYYY-MM-DD', a real calendar date. */
export const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  });

export const DirectoryPerson = z.object({
  user: UserSummary,
  orgRole: OrgRole,
  title: z.string().nullable(),
  department: z.string().nullable(),
  team: z.string().nullable(),
  phone: z.string().nullable(),
  mobile: z.string().nullable(),
  location: z.string().nullable(),
  about: z.string().nullable(),
  manager: UserSummary.nullable(),
  reportCount: z.number().int(),
  /** Fields the directory sync keeps (read-only here). */
  syncedFields: z.array(DirectoryField),
  /** Linked to an AD/LDAP entry (identity directory sync). */
  fromDirectory: z.boolean(),
  joinedAt: Timestamp.nullable(),
  /**
   * 'MM-DD' (no year). Others see it only when the person turned `birthdayVisible` on; the
   * person and directory admins always do.
   */
  birthday: z.string().nullable().optional(),
  birthdayVisible: z.boolean().optional(),
  /** First working day ('YYYY-MM-DD'); work anniversaries count from it. */
  startedOn: z.string().nullable().optional(),
  permissions: z.object({ edit: z.boolean(), editManager: z.boolean() }),
});
export type DirectoryPerson = z.infer<typeof DirectoryPerson>;

export const DirectoryQuery = PageQuery.extend({
  q: z.string().max(200).optional(),
  department: z.string().max(120).optional(),
  team: z.string().max(120).optional(),
  location: z.string().max(120).optional(),
  managerId: Id.optional(),
});
export type DirectoryQuery = z.input<typeof DirectoryQuery>;

export const UpdateDirectoryProfile = z.object({
  title: text(120).nullable().optional(),
  department: text(120).nullable().optional(),
  team: text(120).nullable().optional(),
  phone: text(40).nullable().optional(),
  mobile: text(40).nullable().optional(),
  location: text(120).nullable().optional(),
  about: text(2000).nullable().optional(),
  /** Admins only (the org chart). */
  managerId: Id.nullable().optional(),
  birthday: MonthDay.nullable().optional(),
  birthdayVisible: z.boolean().optional(),
  startedOn: IsoDate.nullable().optional(),
});
export type UpdateDirectoryProfile = z.infer<typeof UpdateDirectoryProfile>;

export const OrgChartNode = z.object({
  user: UserSummary,
  title: z.string().nullable(),
  department: z.string().nullable(),
  managerId: Id.nullable(),
  reportCount: z.number().int(),
  /** Grouping by team (absent on older servers). */
  team: z.string().nullable().optional(),
  /** The manager comes from AD/LDAP or Google Workspace: not movable in the chart. */
  managerSynced: z.boolean().optional(),
  /** Fields the directory sync keeps (the table locks them). */
  syncedFields: z.array(DirectoryField).optional(),
});
export type OrgChartNode = z.infer<typeof OrgChartNode>;

export const OrgChart = z.object({
  items: z.array(OrgChartNode),
  /** Org admins move people in the chart (drag and drop, table, CSV). */
  permissions: z.object({ editManager: z.boolean() }).optional(),
});
export type OrgChart = z.infer<typeof OrgChart>;

/**
 * Bulk directory update from a CSV file (admins). Columns by header, Turkish or English:
 * e-posta/email (required), unvan/title, departman/department, ekip/team, telefon/phone,
 * cep/mobile, konum/location, yönetici/manager (the manager's e-mail; empty clears it).
 * Columns that are absent are left alone. `dryRun` checks every row and changes nothing.
 */
export const ImportDirectory = z.object({
  csv: z.string().min(1).max(1_000_000),
  dryRun: z.boolean().default(false),
});
export type ImportDirectory = z.input<typeof ImportDirectory>;

export const DirectoryImportRow = z.object({
  /** Line in the file (the header is line 1). */
  line: z.number().int(),
  email: z.string(),
  name: z.string().nullable(),
  status: z.enum(['updated', 'unchanged', 'failed']),
  /** Changed (or, in a dry run, to be changed) fields. */
  fields: z.array(z.string()),
  /** Error code (errors.<code>) of a failed row. */
  code: z.string().nullable(),
});
export type DirectoryImportRow = z.infer<typeof DirectoryImportRow>;

export const DirectoryImportResult = z.object({
  dryRun: z.boolean(),
  rows: z.array(DirectoryImportRow),
  updated: z.number().int(),
  unchanged: z.number().int(),
  failed: z.number().int(),
});
export type DirectoryImportResult = z.infer<typeof DirectoryImportResult>;

const Facet = z.object({ value: z.string(), count: z.number().int() });
export const DirectoryFacets = z.object({
  departments: z.array(Facet),
  teams: z.array(Facet),
  locations: z.array(Facet),
});
export type DirectoryFacets = z.infer<typeof DirectoryFacets>;

// ---- external contacts -------------------------------------------------------------------------

export const ContactKind = z.enum(['customer', 'supplier', 'partner', 'other']);
export type ContactKind = z.infer<typeof ContactKind>;

/** org: the whole org's address book; private: only the person who added it. */
export const ContactVisibility = z.enum(['org', 'private']);
export type ContactVisibility = z.infer<typeof ContactVisibility>;

export const ContactEmail = z.object({
  type: z.enum(['work', 'home', 'other']),
  value: z.email().max(254),
});
export const ContactPhone = z.object({
  type: z.enum(['work', 'mobile', 'home', 'fax', 'other']),
  value: z.string().trim().min(1).max(40),
});

export const Tag = z.string().trim().min(1).max(40);
const Tags = z.array(Tag).max(30);

export const ContactPermissions = z.object({ edit: z.boolean(), delete: z.boolean() });

export const ContactCompany = z.object({
  id: Id,
  name: z.string(),
  kind: ContactKind,
  domain: z.string().nullable(),
  website: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  address: z.string().nullable(),
  notes: z.string().nullable(),
  tags: z.array(z.string()),
  visibility: ContactVisibility,
  contactCount: z.number().int(),
  createdBy: UserSummary.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  permissions: ContactPermissions,
});
export type ContactCompany = z.infer<typeof ContactCompany>;

const CompanyFields = z.object({
  name: text(160).min(1),
  kind: ContactKind.default('customer'),
  domain: text(160).nullable().optional(),
  website: text(300).nullable().optional(),
  email: z.email().max(254).nullable().optional(),
  phone: text(40).nullable().optional(),
  address: text(500).nullable().optional(),
  notes: text(5000).nullable().optional(),
  tags: Tags.default([]),
  visibility: ContactVisibility.default('org'),
});
export const CreateContactCompany = CompanyFields;
export type CreateContactCompany = z.input<typeof CreateContactCompany>;
export const UpdateContactCompany = z.object({
  name: text(160).min(1).optional(),
  kind: ContactKind.optional(),
  domain: text(160).nullable().optional(),
  website: text(300).nullable().optional(),
  email: z.email().max(254).nullable().optional(),
  phone: text(40).nullable().optional(),
  address: text(500).nullable().optional(),
  notes: text(5000).nullable().optional(),
  tags: Tags.optional(),
  visibility: ContactVisibility.optional(),
});
export type UpdateContactCompany = z.infer<typeof UpdateContactCompany>;

/** A contact mirrored from a connected account's address book. */
export const ContactExternal = z.object({
  provider: z.enum(['google', 'microsoft', 'exchange']),
  accountId: Id,
  email: z.string(),
});
export type ContactExternal = z.infer<typeof ContactExternal>;

export const Contact = z.object({
  id: Id,
  kind: ContactKind,
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  displayName: z.string(),
  company: z.object({ id: Id, name: z.string() }).nullable(),
  jobTitle: z.string().nullable(),
  emails: z.array(ContactEmail),
  phones: z.array(ContactPhone),
  address: z.string().nullable(),
  website: z.string().nullable(),
  birthday: z.string().nullable(),
  notes: z.string().nullable(),
  tags: z.array(z.string()),
  visibility: ContactVisibility,
  createdBy: UserSummary.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  permissions: ContactPermissions,
  /** Comes from an account's address book: private, and changes go there too (absent on older servers). */
  external: ContactExternal.nullable().optional(),
});
export type Contact = z.infer<typeof Contact>;

/** A version lost when a mirrored contact changed in two places at once. */
export const ContactVersion = z.object({
  id: Id,
  /** Whose version was overwritten: the provider's, or the one written in Crewhall. */
  overwritten: z.enum(['provider', 'crewhall']),
  replacedAt: Timestamp,
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  displayName: z.string(),
  company: z.string().nullable(),
  jobTitle: z.string().nullable(),
  emails: z.array(ContactEmail),
  phones: z.array(ContactPhone),
  address: z.string().nullable(),
  website: z.string().nullable(),
  birthday: z.string().nullable(),
  notes: z.string().nullable(),
  tags: z.array(z.string()),
});
export type ContactVersion = z.infer<typeof ContactVersion>;

const BirthdayText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const ContactFields = z.object({
  kind: ContactKind.default('customer'),
  firstName: text(80).nullable().optional(),
  lastName: text(80).nullable().optional(),
  /** Defaults to first + last name (or the company). */
  displayName: text(160).optional(),
  companyId: Id.nullable().optional(),
  jobTitle: text(120).nullable().optional(),
  emails: z.array(ContactEmail).max(10).default([]),
  phones: z.array(ContactPhone).max(10).default([]),
  address: text(500).nullable().optional(),
  website: text(300).nullable().optional(),
  birthday: BirthdayText.nullable().optional(),
  notes: text(5000).nullable().optional(),
  tags: Tags.default([]),
  visibility: ContactVisibility.default('org'),
  /** Also add it to this connected account's address book; such a contact is private. */
  accountId: Id.nullable().optional(),
});
export const CreateContact = ContactFields.refine(
  (c) => Boolean(c.displayName || c.firstName || c.lastName),
  { message: 'a name is required', path: ['displayName'] },
);
export type CreateContact = z.input<typeof CreateContact>;

export const UpdateContact = z.object({
  kind: ContactKind.optional(),
  firstName: text(80).nullable().optional(),
  lastName: text(80).nullable().optional(),
  displayName: text(160).min(1).optional(),
  companyId: Id.nullable().optional(),
  jobTitle: text(120).nullable().optional(),
  emails: z.array(ContactEmail).max(10).optional(),
  phones: z.array(ContactPhone).max(10).optional(),
  address: text(500).nullable().optional(),
  website: text(300).nullable().optional(),
  birthday: BirthdayText.nullable().optional(),
  notes: text(5000).nullable().optional(),
  tags: Tags.optional(),
  visibility: ContactVisibility.optional(),
});
export type UpdateContact = z.infer<typeof UpdateContact>;

export const ContactQuery = PageQuery.extend({
  q: z.string().max(200).optional(),
  kind: ContactKind.optional(),
  tag: z.string().max(40).optional(),
  companyId: Id.optional(),
  /** Only the caller's private contacts. */
  mine: z.stringbool().optional(),
});
export type ContactQuery = z.input<typeof ContactQuery>;

export const CompanyQuery = PageQuery.extend({
  q: z.string().max(200).optional(),
  kind: ContactKind.optional(),
  tag: z.string().max(40).optional(),
});
export type CompanyQuery = z.input<typeof CompanyQuery>;

export const ContactTags = z.object({
  items: z.array(z.object({ tag: z.string(), count: z.number().int() })),
});

export const ImportVcard = z.object({
  vcf: z.string().min(1).max(5_000_000),
  /** Visibility of the imported contacts. */
  visibility: ContactVisibility.default('org'),
});

export const ImportVcardResult = z.object({
  created: z.number().int(),
  updated: z.number().int(),
  skipped: z.number().int(),
  errors: z.array(z.object({ name: z.string().nullable(), reason: z.string() })),
});
export type ImportVcardResult = z.infer<typeof ImportVcardResult>;

export const CardDavInfo = z.object({
  url: z.string(),
  username: z.string(),
  tokensAvailable: z.boolean(),
});
export type CardDavInfo = z.infer<typeof CardDavInfo>;

/** Non-JSON paths of the module: vCard files and CardDAV. */
export const CONTACTS_RAW_PATHS = {
  exportContacts: '/api/v1/contacts/export.vcf',
  exportDirectory: '/api/v1/directory/export.vcf',
  carddav: '/carddav',
} as const;

// ---- permissions --------------------------------------------------------------------------------

/**
 * Directory: every member reads it (guests do not), a person edits their own profile except the
 * manager line and synced fields; admins edit anyone's and set managers. External contacts: org
 * members read and add; org contacts are edited by any member and deleted by their creator or an
 * admin; private ones belong to their creator alone.
 */
export function canContacts(
  action:
    | 'directory.read'
    | 'directory.edit'
    | 'directory.manage'
    | 'read'
    | 'create'
    | 'edit'
    | 'delete',
  input: {
    orgRole: OrgRole;
    /** The caller is the directory person / the contact's creator. */
    own?: boolean;
    visibility?: ContactVisibility;
  },
): boolean {
  const admin = input.orgRole === 'owner' || input.orgRole === 'admin';
  const member = input.orgRole !== 'guest';
  switch (action) {
    case 'directory.read':
      return member;
    case 'directory.edit':
      return member && (admin || input.own === true);
    case 'directory.manage':
      return admin;
    case 'read':
    case 'edit':
      if (!member) return false;
      return input.visibility === 'private' ? input.own === true : true;
    case 'create':
      return member;
    case 'delete':
      if (!member) return false;
      return input.visibility === 'private' ? input.own === true : input.own === true || admin;
  }
}
