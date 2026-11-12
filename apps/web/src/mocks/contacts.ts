import {
  canContacts,
  type Contact,
  type ContactCompany,
  type ContactVersion,
  type DirectoryPerson,
  type EndpointName,
} from '@crewhall/shared';
import { mockCalendarAccounts } from './calendar';
import { actorOf, MockApiError, paginate, requireUser, summary, type Resolvers } from './core';
import { newId } from './db';
import { USER, type MockState, type MockUser } from './seed';

/**
 * Contacts and directory part of the contract mock (roadmap 15), in memory: directory profiles
 * on top of the mock's members, the manager line, external contacts and companies.
 */

interface Profile {
  title: string | null;
  department: string | null;
  team: string | null;
  phone: string | null;
  mobile: string | null;
  location: string | null;
  about: string | null;
  managerId: string | null;
  syncedFields: DirectoryPerson['syncedFields'];
  birthday: string | null;
  birthdayVisible: boolean;
  startedOn: string | null;
}

type MockContact = Omit<Contact, 'company' | 'createdBy' | 'permissions'> & {
  companyId: string | null;
  createdBy: string;
};
type MockCompany = Omit<ContactCompany, 'contactCount' | 'createdBy' | 'permissions'> & {
  createdBy: string;
};

interface State {
  profiles: Record<string, Partial<Profile>>;
  contacts: MockContact[];
  companies: MockCompany[];
}

/** 'MM-DD' / 'YYYY-MM-DD' some days from now, so the celebrations card has something. */
const dayFromNow = (days: number, yearsAgo = 0) => {
  const d = new Date(Date.now() + days * 86_400_000);
  d.setFullYear(d.getFullYear() - yearsAgo);
  return d.toISOString().slice(0, 10);
};

const seedProfiles = (): State['profiles'] => ({
  [USER.bugra]: { title: 'Kurucu', department: 'Yönetim', location: 'İstanbul' },
  [USER.elif]: {
    title: 'Ürün Yöneticisi',
    department: 'Ürün',
    team: 'Portal',
    managerId: USER.bugra,
  },
  [USER.mert]: {
    title: 'Backend Geliştirici',
    department: 'Mühendislik',
    team: 'Altyapı',
    managerId: USER.bugra,
    syncedFields: ['title', 'department'],
  },
  [USER.zeynep]: {
    title: 'Tasarımcı',
    department: 'Ürün',
    managerId: USER.elif,
    birthday: dayFromNow(3).slice(5),
    birthdayVisible: true,
    startedOn: dayFromNow(8, 2),
  },
});

let state: State = { profiles: seedProfiles(), contacts: [], companies: [] };

export function resetContactsMock() {
  contactVersions.clear();
  state = { profiles: seedProfiles(), contacts: [], companies: [] };
}

export function contactsMockState() {
  return state;
}

const now = () => new Date().toISOString();

function profileOf(userId: string): Profile {
  const p = state.profiles[userId] ?? {};
  return {
    title: p.title ?? null,
    department: p.department ?? null,
    team: p.team ?? null,
    phone: p.phone ?? null,
    mobile: p.mobile ?? null,
    location: p.location ?? null,
    about: p.about ?? null,
    managerId: p.managerId ?? null,
    syncedFields: p.syncedFields ?? [],
    birthday: p.birthday ?? null,
    birthdayVisible: p.birthdayVisible ?? false,
    startedOn: p.startedOn ?? null,
  };
}

function people(s: MockState) {
  return s.members
    .filter((m) => m.status === 'active' && m.role !== 'guest')
    .map((m) => ({ m, u: s.users.find((u) => u.id === m.userId)! }))
    .filter((x) => x.u)
    .sort((a, b) => a.u.name.localeCompare(b.u.name, 'tr'));
}

function toPerson(s: MockState, me: MockUser, u: MockUser): DirectoryPerson {
  const p = profileOf(u.id);
  const m = s.members.find((x) => x.userId === u.id)!;
  const manager = p.managerId ? s.users.find((x) => x.id === p.managerId) : undefined;
  const role = actorOf(s, me).orgRole;
  const showBirthday =
    u.id === me.id || canContacts('directory.manage', { orgRole: role }) || p.birthdayVisible;
  return {
    user: summary(u),
    orgRole: m.role,
    ...p,
    birthday: showBirthday ? p.birthday : null,
    manager: manager ? summary(manager) : null,
    reportCount: Object.values(state.profiles).filter((x) => x.managerId === u.id).length,
    fromDirectory: p.syncedFields.length > 0,
    joinedAt: m.joinedAt,
    permissions: {
      edit: canContacts('directory.edit', { orgRole: role, own: u.id === me.id }),
      editManager: canContacts('directory.manage', { orgRole: role }),
    },
  };
}

function rights(
  s: MockState,
  me: MockUser,
  row: { createdBy: string; visibility: 'org' | 'private' },
) {
  const input = {
    orgRole: actorOf(s, me).orgRole,
    own: row.createdBy === me.id,
    visibility: row.visibility,
  };
  return { edit: canContacts('edit', input), delete: canContacts('delete', input) };
}

const visible = <T extends { createdBy: string; visibility: 'org' | 'private' }>(
  me: MockUser,
  list: T[],
) => list.filter((x) => x.visibility === 'org' || x.createdBy === me.id);

/** Overwritten versions of mirrored contacts: there is no sync here, tests add them. */
const contactVersions = new Map<string, ContactVersion[]>();

export function addMockContactVersion(contactId: string, v: ContactVersion) {
  contactVersions.set(contactId, [v, ...(contactVersions.get(contactId) ?? [])]);
}

function toContact(s: MockState, me: MockUser, c: MockContact): Contact {
  const company = state.companies.find((x) => x.id === c.companyId);
  const by = s.users.find((u) => u.id === c.createdBy);
  return {
    ...c,
    company: company ? { id: company.id, name: company.name } : null,
    createdBy: by ? summary(by) : null,
    permissions: rights(s, me, c),
  };
}

function toCompany(s: MockState, me: MockUser, c: MockCompany): ContactCompany {
  const by = s.users.find((u) => u.id === c.createdBy);
  return {
    ...c,
    contactCount: visible(me, state.contacts).filter((x) => x.companyId === c.id).length,
    createdBy: by ? summary(by) : null,
    permissions: rights(s, me, c),
  };
}

const matches = (hay: (string | null | undefined)[], q?: string) =>
  !q || hay.filter(Boolean).join(' ').toLocaleLowerCase('tr').includes(q.toLocaleLowerCase('tr'));

export const contactsResolvers: Partial<Resolvers<EndpointName>> = {
  listDirectory: ({ s, query }) => {
    const me = requireUser(s);
    const all = people(s)
      .filter(({ u }) => {
        const p = profileOf(u.id);
        return (
          matches([u.name, u.email, p.title, p.department, p.team, p.phone, p.location], query.q) &&
          (!query.department || p.department === query.department) &&
          (!query.managerId || p.managerId === query.managerId)
        );
      })
      .map(({ u }) => toPerson(s, me, u));
    return paginate(all, query.cursor, query.limit);
  },
  getDirectoryFacets: ({ s }) => {
    requireUser(s);
    const count = (k: 'department' | 'team' | 'location') => {
      const map = new Map<string, number>();
      for (const { u } of people(s)) {
        const v = profileOf(u.id)[k];
        if (v) map.set(v, (map.get(v) ?? 0) + 1);
      }
      return [...map]
        .sort(([a], [b]) => a.localeCompare(b, 'tr'))
        .map(([value, c]) => ({ value, count: c }));
    };
    return { departments: count('department'), teams: count('team'), locations: count('location') };
  },
  getOrgChart: ({ s }) => {
    const me = requireUser(s);
    const ids = new Set(people(s).map((x) => x.u.id));
    return {
      items: people(s).map(({ u }) => {
        const p = profileOf(u.id);
        return {
          user: summary(u),
          title: p.title,
          department: p.department,
          managerId: p.managerId && ids.has(p.managerId) ? p.managerId : null,
          reportCount: Object.values(state.profiles).filter((x) => x.managerId === u.id).length,
          team: p.team,
          managerSynced: p.syncedFields.includes('managerId'),
          syncedFields: p.syncedFields,
        };
      }),
      permissions: {
        editManager: canContacts('directory.manage', { orgRole: actorOf(s, me).orgRole }),
      },
    };
  },
  importDirectory: ({ s, body }) => {
    const me = requireUser(s);
    if (!canContacts('directory.manage', { orgRole: actorOf(s, me).orgRole })) {
      throw new MockApiError('forbidden');
    }
    const lines = body.csv
      .trim()
      .split(/\r?\n/)
      .map((l) => l.split(/[;,]/).map((c) => c.trim()));
    const header = (lines[0] ?? []).map((h) => h.toLocaleLowerCase('tr').replace(/[\s-]/g, ''));
    const col = (names: string[]) => header.findIndex((h) => names.includes(h));
    const at = {
      email: col(['eposta', 'email']),
      title: col(['unvan', 'title']),
      department: col(['departman', 'department']),
      team: col(['ekip', 'team']),
      manager: col(['yönetici', 'manager']),
    };
    if (at.email < 0 || lines.length < 2) throw new MockApiError('directory_csv_invalid');
    const byEmail = new Map(people(s).map((x) => [x.u.email.toLowerCase(), x.u]));
    const backup = structuredClone(state.profiles);
    const rows = lines.slice(1).map((cells, i) => {
      const email = cells[at.email] ?? '';
      const u = byEmail.get(email.toLowerCase());
      const fail = (code: string) => ({
        line: i + 2,
        email,
        name: u?.name ?? null,
        status: 'failed' as const,
        fields: [],
        code,
      });
      if (!u) return fail('directory_person_unknown');
      const p = { ...(state.profiles[u.id] ?? {}) };
      const fields: string[] = [];
      for (const k of ['title', 'department', 'team'] as const) {
        if (at[k] < 0) continue;
        const v = cells[at[k]] || null;
        if (v !== (p[k] ?? null)) {
          p[k] = v;
          fields.push(k);
        }
      }
      if (at.manager >= 0) {
        const m = cells[at.manager] ? byEmail.get(cells[at.manager]!.toLowerCase()) : null;
        if (cells[at.manager] && !m) return fail('directory_person_unknown');
        if ((m?.id ?? null) !== (p.managerId ?? null)) {
          p.managerId = m?.id ?? null;
          fields.push('managerId');
        }
      }
      state.profiles[u.id] = p;
      return {
        line: i + 2,
        email,
        name: u.name,
        status: fields.length ? ('updated' as const) : ('unchanged' as const),
        fields,
        code: null,
      };
    });
    if (body.dryRun) state.profiles = backup;
    return {
      dryRun: Boolean(body.dryRun),
      rows,
      updated: rows.filter((r) => r.status === 'updated').length,
      unchanged: rows.filter((r) => r.status === 'unchanged').length,
      failed: rows.filter((r) => r.status === 'failed').length,
    };
  },
  getDirectoryPerson: ({ s, params }) => {
    const me = requireUser(s);
    const x = people(s).find((p) => p.u.id === params.userId);
    if (!x) throw new MockApiError('not_found');
    return toPerson(s, me, x.u);
  },
  updateDirectoryProfile: ({ s, params, body }) => {
    const me = requireUser(s);
    const x = people(s).find((p) => p.u.id === params.userId);
    if (!x) throw new MockApiError('not_found');
    const person = toPerson(s, me, x.u);
    if (!person.permissions.edit) throw new MockApiError('forbidden');
    const next = { ...(state.profiles[x.u.id] ?? {}) };
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined) continue;
      if (person.syncedFields.includes(k as never)) {
        throw new MockApiError('directory_field_synced');
      }
      if (k === 'managerId' && !person.permissions.editManager) throw new MockApiError('forbidden');
      if (k === 'birthdayVisible' && x.u.id !== me.id) throw new MockApiError('forbidden');
      (next as Record<string, unknown>)[k] = v;
    }
    state.profiles[x.u.id] = next;
    return toPerson(s, me, x.u);
  },

  listContactVersions: ({ s, params }) => {
    requireUser(s);
    return { items: contactVersions.get(params.contactId!) ?? [] };
  },
  listContacts: ({ s, query }) => {
    const me = requireUser(s);
    const list = visible(me, state.contacts)
      .filter(
        (c) =>
          matches(
            [
              c.displayName,
              c.jobTitle,
              ...c.emails.map((e) => e.value),
              ...c.phones.map((p) => p.value),
              ...c.tags,
            ],
            query.q,
          ) &&
          (!query.kind || c.kind === query.kind) &&
          (!query.tag || c.tags.includes(query.tag)) &&
          (!query.companyId || c.companyId === query.companyId),
      )
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'tr'))
      .map((c) => toContact(s, me, c));
    return paginate(list, query.cursor, query.limit);
  },
  createContact: ({ s, body }) => {
    const me = requireUser(s);
    const account = mockCalendarAccounts().find((x) => x.id === body.accountId);
    if (body.accountId && account?.contacts?.status !== 'active') {
      throw new MockApiError('contacts_account_unavailable');
    }
    const c: MockContact = {
      external: account
        ? { provider: account.provider, accountId: account.id, email: account.email }
        : null,
      id: newId(),
      kind: body.kind,
      firstName: body.firstName ?? null,
      lastName: body.lastName ?? null,
      displayName: body.displayName ?? [body.firstName, body.lastName].filter(Boolean).join(' '),
      companyId: body.companyId ?? null,
      jobTitle: body.jobTitle ?? null,
      emails: body.emails,
      phones: body.phones,
      address: body.address ?? null,
      website: body.website ?? null,
      birthday: body.birthday ?? null,
      notes: body.notes ?? null,
      tags: body.tags,
      visibility: body.visibility,
      createdBy: me.id,
      createdAt: now(),
      updatedAt: now(),
    };
    state.contacts.push(c);
    return toContact(s, me, c);
  },
  getContact: ({ s, params }) => {
    const me = requireUser(s);
    const c = visible(me, state.contacts).find((x) => x.id === params.contactId);
    if (!c) throw new MockApiError('not_found');
    return toContact(s, me, c);
  },
  updateContact: ({ s, params, body }) => {
    const me = requireUser(s);
    const c = visible(me, state.contacts).find((x) => x.id === params.contactId);
    if (!c) throw new MockApiError('not_found');
    for (const [k, v] of Object.entries(body)) {
      if (v !== undefined) (c as Record<string, unknown>)[k] = v;
    }
    if (body.firstName !== undefined || body.lastName !== undefined) {
      c.displayName = [c.firstName, c.lastName].filter(Boolean).join(' ') || c.displayName;
    }
    c.updatedAt = now();
    return toContact(s, me, c);
  },
  deleteContact: ({ s, params }) => {
    const me = requireUser(s);
    state.contacts = state.contacts.filter(
      (x) => !(x.id === params.contactId && rights(s, me, x).delete),
    );
    return {};
  },
  listContactTags: ({ s }) => {
    const me = requireUser(s);
    const map = new Map<string, number>();
    for (const x of [...visible(me, state.contacts), ...visible(me, state.companies)]) {
      for (const t of x.tags) map.set(t, (map.get(t) ?? 0) + 1);
    }
    return { items: [...map].map(([tag, count]) => ({ tag, count })) };
  },
  importContactsVcard: () => ({ created: 0, updated: 0, skipped: 0, errors: [] }),

  listContactCompanies: ({ s, query }) => {
    const me = requireUser(s);
    const list = visible(me, state.companies)
      .filter(
        (c) =>
          matches([c.name, c.domain, ...c.tags], query.q) && (!query.kind || c.kind === query.kind),
      )
      .sort((a, b) => a.name.localeCompare(b.name, 'tr'))
      .map((c) => toCompany(s, me, c));
    return paginate(list, query.cursor, query.limit);
  },
  createContactCompany: ({ s, body }) => {
    const me = requireUser(s);
    const c: MockCompany = {
      id: newId(),
      name: body.name,
      kind: body.kind,
      domain: body.domain ?? null,
      website: body.website ?? null,
      email: body.email ?? null,
      phone: body.phone ?? null,
      address: body.address ?? null,
      notes: body.notes ?? null,
      tags: body.tags,
      visibility: body.visibility,
      createdBy: me.id,
      createdAt: now(),
      updatedAt: now(),
    };
    state.companies.push(c);
    return toCompany(s, me, c);
  },
  getContactCompany: ({ s, params }) => {
    const me = requireUser(s);
    const c = visible(me, state.companies).find((x) => x.id === params.companyId);
    if (!c) throw new MockApiError('not_found');
    return toCompany(s, me, c);
  },
  updateContactCompany: ({ s, params, body }) => {
    const me = requireUser(s);
    const c = visible(me, state.companies).find((x) => x.id === params.companyId);
    if (!c) throw new MockApiError('not_found');
    for (const [k, v] of Object.entries(body)) {
      if (v !== undefined) (c as Record<string, unknown>)[k] = v;
    }
    return toCompany(s, me, c);
  },
  deleteContactCompany: ({ s, params }) => {
    requireUser(s);
    state.companies = state.companies.filter((x) => x.id !== params.companyId);
    for (const c of state.contacts) if (c.companyId === params.companyId) c.companyId = null;
    return {};
  },
  getCardDavInfo: ({ s }) => ({
    url: `${window.location.origin}/carddav/`,
    username: requireUser(s).email,
    tokensAvailable: true,
  }),
};
