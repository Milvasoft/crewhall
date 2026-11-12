import { z } from 'zod';
import { ProviderError } from '../../calendar/external/http';
import type { Api } from '../../calendar/external/types';
import type { ContactsClient, ExtContact, ExtContactFields } from './types';

/**
 * Personal contacts over Microsoft Graph v1.0: the default Contacts folder of the mailbox, with
 * delta for changes and the changeKey (weak ETag) for conflicts. Subfolders are not mirrored.
 */

const MAX_PAGES = 200;
const SELECT = [
  'changeKey',
  'givenName',
  'surname',
  'displayName',
  'companyName',
  'jobTitle',
  'emailAddresses',
  'businessPhones',
  'homePhones',
  'mobilePhone',
  'businessAddress',
  'homeAddress',
  'otherAddress',
  'businessHomePage',
  'birthday',
  'personalNotes',
  'categories',
].join(',');

const Str = z.string().nullable().optional();
const MAddress = z
  .object({ street: Str, city: Str, state: Str, countryOrRegion: Str, postalCode: Str })
  .nullable()
  .optional();
const MContact = z.object({
  id: z.string(),
  '@removed': z.object({ reason: z.string().optional() }).optional(),
  changeKey: Str,
  givenName: Str,
  surname: Str,
  displayName: Str,
  companyName: Str,
  jobTitle: Str,
  emailAddresses: z
    .array(z.object({ address: Str }))
    .nullable()
    .optional(),
  businessPhones: z.array(z.string()).nullable().optional(),
  homePhones: z.array(z.string()).nullable().optional(),
  mobilePhone: Str,
  businessAddress: MAddress,
  homeAddress: MAddress,
  otherAddress: MAddress,
  businessHomePage: Str,
  birthday: Str,
  personalNotes: Str,
  categories: z.array(z.string()).nullable().optional(),
});
type MContact = z.infer<typeof MContact>;

const MPage = z.object({
  value: z.array(z.unknown()).default([]),
  '@odata.nextLink': z.string().optional(),
  '@odata.deltaLink': z.string().optional(),
});

const clean = (v: string | null | undefined) => v?.trim() || null;

/** One line from a structured address: the first of business, home and other that has one. */
export function addressLine(c: Pick<MContact, 'businessAddress' | 'homeAddress' | 'otherAddress'>) {
  for (const a of [c.businessAddress, c.homeAddress, c.otherAddress]) {
    if (!a) continue;
    const place = [a.postalCode, a.city].map(clean).filter(Boolean).join(' ');
    const line = [a.street, place, a.state, a.countryOrRegion].map(clean).filter(Boolean);
    if (line.length) return line.join(', ');
  }
  return null;
}

/** Exchange keeps far-future placeholders for "no birthday"; those are not dates. */
const dateOf = (v: string | null | undefined) => {
  const d = v?.slice(0, 10) ?? '';
  return /^(1[89]|20)\d{2}-\d{2}-\d{2}$/.test(d) ? d : null;
};

function fromGraph(c: MContact): ExtContact {
  return {
    id: c.id,
    etag: c.changeKey ?? null,
    firstName: clean(c.givenName),
    lastName: clean(c.surname),
    displayName: clean(c.displayName),
    company: clean(c.companyName),
    jobTitle: clean(c.jobTitle),
    emails: (c.emailAddresses ?? []).map((e) => clean(e.address)).filter((e): e is string => !!e),
    workPhones: (c.businessPhones ?? []).map(clean).filter((p): p is string => !!p),
    homePhones: (c.homePhones ?? []).map(clean).filter((p): p is string => !!p),
    mobilePhone: clean(c.mobilePhone),
    address: addressLine(c),
    website: clean(c.businessHomePage),
    birthday: dateOf(c.birthday),
    notes: clean(c.personalNotes),
    categories: (c.categories ?? []).map(clean).filter((x): x is string => !!x),
  };
}

const NO_ADDRESS = { street: '', city: '', state: '', countryOrRegion: '', postalCode: '' };

/** Only the fields being written. A new address replaces the business one, whole. */
export function toGraph(p: Partial<ExtContactFields>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (p.firstName !== undefined) out.givenName = p.firstName ?? '';
  if (p.lastName !== undefined) out.surname = p.lastName ?? '';
  // Graph regenerates the name on later updates unless it is sent along.
  if (p.displayName !== undefined) out.displayName = p.displayName ?? '';
  if (p.company !== undefined) out.companyName = p.company ?? '';
  if (p.jobTitle !== undefined) out.jobTitle = p.jobTitle ?? '';
  if (p.emails !== undefined) {
    out.emailAddresses = p.emails.map((address) => ({ address, name: address }));
  }
  if (p.workPhones !== undefined) out.businessPhones = p.workPhones;
  if (p.homePhones !== undefined) out.homePhones = p.homePhones;
  if (p.mobilePhone !== undefined) out.mobilePhone = p.mobilePhone ?? '';
  if (p.address !== undefined) {
    out.businessAddress = p.address ? { ...NO_ADDRESS, street: p.address } : NO_ADDRESS;
    if (!p.address) {
      out.homeAddress = NO_ADDRESS;
      out.otherAddress = NO_ADDRESS;
    }
  }
  if (p.website !== undefined) out.businessHomePage = p.website ?? '';
  // Noon UTC: the date survives whichever zone the mailbox reads it in.
  if (p.birthday !== undefined) out.birthday = p.birthday ? `${p.birthday}T12:00:00Z` : null;
  if (p.notes !== undefined) out.personalNotes = p.notes ?? '';
  if (p.categories !== undefined) out.categories = p.categories;
  return out;
}

export function microsoftContacts(api: Api, me: string): ContactsClient {
  /**
   * The default folder has no documented delta of its own: its well-known name, or the folder a
   * contact sits in. A mailbox with neither has nothing to mirror yet.
   */
  const defaultFolder = async (): Promise<string | null> => {
    try {
      const f = z.object({ id: z.string() }).parse(await api(`${me}/contactFolders/contacts`));
      return f.id;
    } catch (err) {
      if (!(err instanceof ProviderError) || (err.status !== 400 && err.status !== 404)) throw err;
    }
    const page = z
      .object({ value: z.array(z.object({ parentFolderId: z.string().optional() })).default([]) })
      .parse(await api(`${me}/contacts?$top=1&$select=parentFolderId`));
    return page.value[0]?.parentFolderId ?? null;
  };

  return {
    async delta(cursor) {
      const full = !cursor;
      let url = cursor;
      if (!url) {
        const folder = await defaultFolder();
        if (!folder) return { items: [], removed: [], cursor: null, full: false };
        url = `${me}/contactFolders/${encodeURIComponent(folder)}/contacts/delta?$select=${SELECT}`;
      }
      const items: ExtContact[] = [];
      const removed: string[] = [];
      for (let i = 0; i < MAX_PAGES; i++) {
        const page = MPage.parse(await api(url, { headers: { Prefer: 'odata.maxpagesize=200' } }));
        for (const raw of page.value) {
          const c = MContact.safeParse(raw);
          if (!c.success) continue;
          if (c.data['@removed']) removed.push(c.data.id);
          else items.push(fromGraph(c.data));
        }
        if (page['@odata.deltaLink']) {
          return { items, removed, cursor: page['@odata.deltaLink'], full };
        }
        if (!page['@odata.nextLink']) break;
        url = page['@odata.nextLink'];
      }
      throw new ProviderError(500, 'delta_incomplete');
    },

    async get(id) {
      try {
        const raw = await api(`${me}/contacts/${encodeURIComponent(id)}?$select=${SELECT}`);
        return fromGraph(MContact.parse(raw));
      } catch (err) {
        if (err instanceof ProviderError && err.status === 404) return null;
        throw err;
      }
    },

    async create(input) {
      const raw = await api(`${me}/contacts`, { method: 'POST', body: toGraph(input) });
      return fromGraph(MContact.parse(raw));
    },

    async update(id, patch, opts) {
      const raw = await api(`${me}/contacts/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: toGraph(patch),
        ...(opts?.ifMatch ? { headers: { 'If-Match': `W/"${opts.ifMatch}"` } } : {}),
      });
      return fromGraph(MContact.parse(raw));
    },

    async remove(id) {
      try {
        await api(`${me}/contacts/${encodeURIComponent(id)}`, { method: 'DELETE' });
      } catch (err) {
        // Already gone there: that is what was asked for.
        if (!(err instanceof ProviderError) || err.status !== 404) throw err;
      }
    },
  };
}
