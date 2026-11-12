import { def, Empty, items, type EndpointDef } from '../endpoint-def';
import { page } from '../schemas/common';
import {
  CardDavInfo,
  CompanyQuery,
  Contact,
  ContactCompany,
  ContactQuery,
  ContactTags,
  ContactVersion,
  CreateContact,
  CreateContactCompany,
  DirectoryFacets,
  DirectoryPerson,
  DirectoryQuery,
  ImportDirectory,
  DirectoryImportResult,
  ImportVcard,
  ImportVcardResult,
  OrgChart,
  UpdateContact,
  UpdateContactCompany,
  UpdateDirectoryProfile,
} from '../schemas/contacts';

/**
 * Contacts and directory module contract (roadmap 15). Only the contacts session edits this
 * file; see docs/contracts/moduller.md. vCard files and CardDAV are outside the JSON table
 * (CONTACTS_RAW_PATHS).
 */
export const contactsEndpoints = {
  // ---- Directory (org members) -----------------------------------------------------------
  listDirectory: def({
    method: 'GET',
    path: '/api/v1/directory',
    auth: 'session',
    query: DirectoryQuery,
    response: page(DirectoryPerson),
  }),
  getDirectoryFacets: def({
    method: 'GET',
    path: '/api/v1/directory/facets',
    auth: 'session',
    response: DirectoryFacets,
  }),
  /** Everyone with their manager: the client draws the org chart. */
  getOrgChart: def({
    method: 'GET',
    path: '/api/v1/directory/chart',
    auth: 'session',
    response: OrgChart,
  }),
  /** Admins: bulk title, department, team, phone, location and manager from a CSV file. */
  importDirectory: def({
    method: 'POST',
    path: '/api/v1/directory/import',
    auth: 'session',
    body: ImportDirectory,
    response: DirectoryImportResult,
  }),
  getDirectoryPerson: def({
    method: 'GET',
    path: '/api/v1/directory/people/:userId',
    auth: 'session',
    response: DirectoryPerson,
  }),
  /** Own profile, or anyone's for admins (manager line: admins only). */
  updateDirectoryProfile: def({
    method: 'PATCH',
    path: '/api/v1/directory/people/:userId',
    auth: 'session',
    body: UpdateDirectoryProfile,
    response: DirectoryPerson,
  }),

  // ---- External contacts -----------------------------------------------------------------
  listContacts: def({
    method: 'GET',
    path: '/api/v1/contacts',
    auth: 'session',
    query: ContactQuery,
    response: page(Contact),
  }),
  createContact: def({
    method: 'POST',
    path: '/api/v1/contacts',
    auth: 'session',
    body: CreateContact,
    response: Contact,
  }),
  getContact: def({
    method: 'GET',
    path: '/api/v1/contacts/:contactId',
    auth: 'session',
    response: Contact,
  }),
  updateContact: def({
    method: 'PATCH',
    path: '/api/v1/contacts/:contactId',
    auth: 'session',
    body: UpdateContact,
    response: Contact,
  }),
  deleteContact: def({
    method: 'DELETE',
    path: '/api/v1/contacts/:contactId',
    auth: 'session',
    response: Empty,
  }),
  /** Mirrored contacts: versions lost to "the last writer wins", newest first. */
  listContactVersions: def({
    method: 'GET',
    path: '/api/v1/contacts/:contactId/versions',
    auth: 'session',
    response: items(ContactVersion),
  }),
  listContactTags: def({
    method: 'GET',
    path: '/api/v1/contact-tags',
    auth: 'session',
    response: ContactTags,
  }),
  /** Adds the cards of a .vcf; a known UID or e-mail updates the existing contact. */
  importContactsVcard: def({
    method: 'POST',
    path: '/api/v1/contacts/import',
    auth: 'session',
    body: ImportVcard,
    response: ImportVcardResult,
  }),

  listContactCompanies: def({
    method: 'GET',
    path: '/api/v1/contact-companies',
    auth: 'session',
    query: CompanyQuery,
    response: page(ContactCompany),
  }),
  createContactCompany: def({
    method: 'POST',
    path: '/api/v1/contact-companies',
    auth: 'session',
    body: CreateContactCompany,
    response: ContactCompany,
  }),
  getContactCompany: def({
    method: 'GET',
    path: '/api/v1/contact-companies/:companyId',
    auth: 'session',
    response: ContactCompany,
  }),
  updateContactCompany: def({
    method: 'PATCH',
    path: '/api/v1/contact-companies/:companyId',
    auth: 'session',
    body: UpdateContactCompany,
    response: ContactCompany,
  }),
  /** Its contacts stay, without a company. */
  deleteContactCompany: def({
    method: 'DELETE',
    path: '/api/v1/contact-companies/:companyId',
    auth: 'session',
    response: Empty,
  }),

  getCardDavInfo: def({
    method: 'GET',
    path: '/api/v1/contacts/carddav',
    auth: 'session',
    response: CardDavInfo,
  }),
} satisfies Record<string, EndpointDef>;
