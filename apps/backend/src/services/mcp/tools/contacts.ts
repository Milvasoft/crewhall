import { ContactKind, ContactVisibility } from '@crewhall/shared';
import { z } from 'zod';
import { operate } from './api';
import { defineTool, ToolError } from './types';

/**
 * Directory and contacts (Rehber): find colleagues and outside contacts, add a contact.
 * Through the contacts API as the person, so private contacts of others stay hidden.
 */

interface DirectoryPerson {
  user: { id: string; name: string; email?: string | null };
  title: string | null;
  department: string | null;
  team: string | null;
  phone: string | null;
  mobile: string | null;
  location: string | null;
  manager: { id: string; name: string } | null;
}

interface ContactOut {
  id: string;
  kind: string;
  displayName: string;
  company: { id: string; name: string } | null;
  jobTitle: string | null;
  emails: { value: string }[];
  phones: { value: string }[];
  tags: string[];
}

const contactOut = (c: ContactOut) => ({
  contact_id: c.id,
  kind: c.kind,
  name: c.displayName,
  company: c.company?.name ?? null,
  job_title: c.jobTitle,
  emails: c.emails.map((e) => e.value),
  phones: c.phones.map((p) => p.value),
  tags: c.tags,
});

export const searchDirectory = defineTool({
  name: 'search_directory',
  title: 'Search directory',
  description:
    'Finds colleagues in the org directory (name, title, department, phone, manager) and the outside contacts the person can see. Use the user_id of a colleague for invitations, assignments and shares.',
  scope: 'hub:read',
  module: 'contacts',
  write: false,
  approval: null,
  annotations: { readOnly: true, destructive: false, idempotent: true },
  input: z.object({
    query: z.string().trim().min(1).max(100),
    department: z.string().max(100).optional(),
    include_contacts: z.boolean().default(true).describe('Also search outside contacts'),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  example: { query: 'mert' },
  async run(ctx, input) {
    const people = (await operate(ctx, 'listDirectory', {
      query: {
        q: input.query,
        limit: input.limit,
        ...(input.department ? { department: input.department } : {}),
      },
    })) as { items: DirectoryPerson[] };
    const contacts = input.include_contacts
      ? ((await operate(ctx, 'listContacts', {
          query: { q: input.query, limit: input.limit },
        })) as { items: ContactOut[] })
      : { items: [] };
    return {
      data: {
        people: people.items.map((p) => ({
          user_id: p.user.id,
          name: p.user.name,
          email: p.user.email ?? null,
          title: p.title,
          department: p.department,
          team: p.team,
          phone: p.phone ?? p.mobile,
          location: p.location,
          manager: p.manager?.name ?? null,
        })),
        contacts: contacts.items.map(contactOut),
      },
      summary: `"${input.query}" · ${people.items.length + contacts.items.length}`,
    };
  },
});

export const createContact = defineTool({
  name: 'create_contact',
  title: 'Create contact',
  description:
    'Adds an outside contact (customer, supplier, partner) to the address book; private to the person unless visibility is "org".',
  scope: 'contacts:write',
  module: 'contacts',
  write: true,
  approval: null,
  annotations: { readOnly: false, destructive: false, idempotent: false },
  input: z.object({
    kind: ContactKind.default('customer'),
    first_name: z.string().trim().max(80).optional(),
    last_name: z.string().trim().max(80).optional(),
    display_name: z.string().trim().max(160).optional().describe('Defaults to first + last name'),
    job_title: z.string().trim().max(120).optional(),
    emails: z.array(z.email()).max(10).default([]),
    phones: z.array(z.string().trim().min(3).max(40)).max(10).default([]),
    notes: z.string().max(5000).optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
    visibility: ContactVisibility.default('private'),
  }),
  example: { first_name: 'Ayşe', last_name: 'Yılmaz', emails: ['ayse@example.com'] },
  async run(ctx, input) {
    if (!input.first_name && !input.last_name && !input.display_name) {
      throw new ToolError(
        'validation_failed',
        'Bir ad ver (first_name, last_name ya da display_name).',
      );
    }
    const contact = (await operate(ctx, 'createContact', {
      body: {
        kind: input.kind,
        ...(input.first_name ? { firstName: input.first_name } : {}),
        ...(input.last_name ? { lastName: input.last_name } : {}),
        ...(input.display_name ? { displayName: input.display_name } : {}),
        ...(input.job_title ? { jobTitle: input.job_title } : {}),
        emails: input.emails.map((value) => ({ type: 'work', value })),
        phones: input.phones.map((value) => ({ type: 'work', value })),
        ...(input.notes ? { notes: input.notes } : {}),
        tags: input.tags,
        visibility: input.visibility,
      },
    })) as ContactOut;
    return {
      data: contactOut(contact),
      target: { type: 'contact', id: contact.id, label: contact.displayName },
      summary: contact.displayName,
      undo: { kind: 'api_call', operation: 'deleteContact', params: { contactId: contact.id } },
    };
  },
});
