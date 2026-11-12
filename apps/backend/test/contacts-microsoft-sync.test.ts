import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '@crewhall/api-client';
import { calendarAccounts, calendarIntegrations, contacts, contactVersions } from '@crewhall/db';
import { clearAppTokens } from '../src/services/calendar/external/domain-wide';
import { setCalendarFetch } from '../src/services/calendar/external/http';
import { GRAPH } from '../src/services/calendar/external/microsoft';
import { syncAccount, syncDueAccounts } from '../src/services/calendar/external/sync';
import { sealSecret } from '../src/services/calendar/external/secrets';
import { addressLine, toGraph } from '../src/services/contacts/external/microsoft';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/** Two-way sync of Outlook contacts over Graph, on the calendar's account (sonraki-isler). */

const FOLDER = 'folder-1';

type MContact = Record<string, unknown> & { id: string; changeKey: string };

/** A mailbox's default Contacts folder that honours delta and If-Match like the real one. */
class FakeGraph {
  contacts = new Map<string, MContact>();
  version = 1;
  round = 0;
  changed = new Set<string>();
  removed = new Set<string>();
  /** The next listing says the cursor expired. */
  expireCursor = false;
  denyContacts = false;
  wellKnownFolder = true;
  ifMatch: (string | null)[] = [];
  created: Record<string, unknown>[] = [];
  tokenForms: URLSearchParams[] = [];

  reset() {
    this.contacts.clear();
    this.changed.clear();
    this.removed.clear();
    this.version = 1;
    this.round = 0;
    this.expireCursor = false;
    this.denyContacts = false;
    this.wellKnownFolder = true;
    this.ifMatch = [];
    this.created = [];
    this.tokenForms = [];
  }

  put(id: string, fields: Record<string, unknown>) {
    const current = this.contacts.get(id) ?? { id, changeKey: '' };
    this.contacts.set(id, { ...current, ...fields, changeKey: `ck-${++this.version}` });
    this.changed.add(id);
  }

  drop(id: string) {
    this.contacts.delete(id);
    this.removed.add(id);
    this.changed.delete(id);
  }

  private page(full: boolean) {
    const ids = full ? [...this.contacts.keys()] : [...this.changed];
    const value: unknown[] = ids.map((id) => this.contacts.get(id)!);
    if (!full) for (const id of this.removed) value.push({ id, '@removed': { reason: 'deleted' } });
    this.changed.clear();
    this.removed.clear();
    return {
      value,
      '@odata.deltaLink': `${GRAPH}/delta-next?round=${++this.round}`,
    };
  }

  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url.includes('/oauth2/v2.0/token')) {
      const form = new URLSearchParams(String(init?.body));
      this.tokenForms.push(form);
      const claims = Buffer.from(JSON.stringify({ email: 'mert@contoso.com' })).toString(
        'base64url',
      );
      return Response.json({
        access_token: 'token',
        expires_in: 3600,
        ...(form.get('grant_type') === 'authorization_code'
          ? { refresh_token: 'refresh-1', id_token: `e30.${claims}.x` }
          : {}),
      });
    }
    if (url.includes('/calendars') || url.includes('/calendar/')) {
      return Response.json({ value: [] });
    }
    if (this.denyContacts && /contact/i.test(url)) {
      return Response.json({ error: { code: 'ErrorAccessDenied' } }, { status: 403 });
    }
    if (url.includes('/delta-next')) {
      if (this.expireCursor) {
        this.expireCursor = false;
        return Response.json({ error: { code: 'syncStateNotFound' } }, { status: 410 });
      }
      return Response.json(this.page(false));
    }
    if (url.endsWith('/contactFolders/contacts')) {
      if (!this.wellKnownFolder) {
        return Response.json({ error: { code: 'ErrorInvalidIdMalformed' } }, { status: 400 });
      }
      return Response.json({ id: FOLDER });
    }
    if (url.includes('$top=1&$select=parentFolderId')) {
      const any = this.contacts.size > 0;
      return Response.json({ value: any ? [{ parentFolderId: FOLDER }] : [] });
    }
    if (url.includes(`/contactFolders/${FOLDER}/contacts/delta`)) {
      return Response.json(this.page(true));
    }
    const one = /\/contacts\/([^/?]+)/.exec(url)?.[1];
    if (method === 'POST' && url.endsWith('/contacts')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      this.created.push(body);
      const id = `new-${this.contacts.size + 1}`;
      this.put(id, body);
      this.changed.delete(id);
      return Response.json(this.contacts.get(id));
    }
    if (one) {
      const id = decodeURIComponent(one);
      const row = this.contacts.get(id);
      if (!row) return Response.json({ error: { code: 'ErrorItemNotFound' } }, { status: 404 });
      if (method === 'GET') return Response.json(row);
      if (method === 'DELETE') {
        this.drop(id);
        this.removed.delete(id);
        return new Response(null, { status: 204 });
      }
      const cond = headers['If-Match'] ?? null;
      this.ifMatch.push(cond);
      if (cond && cond !== `W/"${row.changeKey}"`) {
        return Response.json({ error: { code: 'ErrorIrresolvableConflict' } }, { status: 412 });
      }
      this.put(id, JSON.parse(String(init?.body)) as Record<string, unknown>);
      this.changed.delete(id);
      return Response.json(this.contacts.get(id));
    }
    return new Response(`unexpected ${method} ${url}`, { status: 500 });
  };
}

describe('Outlook contacts sync', () => {
  const graph = new FakeGraph();
  let app: TestApp;
  let owner: Client;
  let mert: Client;
  let accountId: string;

  const sync = () => syncAccount(app.deps, accountId);
  const list = async (who: Client = owner) =>
    (await who.api.call('listContacts', { query: { limit: 100 } })).items;
  const byName = async (name: string) => (await list()).find((c) => c.displayName === name)!;
  const state = async () =>
    (await owner.api.call('listCalendarAccounts')).items.find((a) => a.id === accountId)!.contacts;

  const anna = {
    givenName: 'Anna',
    surname: 'Yılmaz',
    displayName: 'Anna Yılmaz',
    companyName: 'Contoso',
    jobTitle: 'Satın alma',
    emailAddresses: [{ address: 'anna@contoso.com' }, { address: '/O=EXCHANGE/CN=ANNA' }],
    businessPhones: ['+90 212 000 00 00'],
    homePhones: [],
    mobilePhone: '+90 532 000 00 00',
    businessAddress: { street: 'Büyükdere 1', city: 'İstanbul', postalCode: '34000' },
    businessHomePage: 'https://contoso.com',
    birthday: '1990-05-17T11:00:00Z',
    personalNotes: 'Kuzey bölgesi',
    categories: ['Müşteri'],
  };

  beforeAll(async () => {
    setCalendarFetch(graph.fetch);
    clearAppTokens();
    app = await createTestApp();
    ({ owner } = await setupWithOwner(app));
    mert = (await join(app, owner, 'mert@milvasoft.com', 'member')).person;
    await owner.api.call('updateCalendarIntegration', {
      params: { provider: 'microsoft' },
      body: {
        enabled: true,
        clientId: 'm-client',
        clientSecret: 'm-secret',
        tenant: 'contoso-tenant-id',
        domainWide: true,
        contactsSync: true,
      },
    });
    await syncDueAccounts(app.deps);
    accountId = (await owner.api.call('listCalendarAccounts')).items[0]!.id;
  });

  beforeEach(async () => {
    graph.reset();
    await app.deps.db.delete(contactVersions);
    await app.deps.db.delete(contacts);
    await app.deps.db
      .update(calendarAccounts)
      .set({ contactsState: null, busyOnly: false, delegated: true, contactsGranted: false })
      .where(eq(calendarAccounts.id, accountId));
    await app.deps.db
      .update(calendarIntegrations)
      .set({ contactsSync: true })
      .where(eq(calendarIntegrations.provider, 'microsoft'));
  });

  afterAll(async () => {
    setCalendarFetch(null);
    await app?.close();
  });

  it("brings the folder in as the owner's private contacts", async () => {
    graph.put('m-1', anna);
    await sync();
    const c = await byName('Anna Yılmaz');
    expect(c).toMatchObject({
      visibility: 'private',
      kind: 'other',
      firstName: 'Anna',
      lastName: 'Yılmaz',
      jobTitle: 'Satın alma',
      company: { name: 'Contoso' },
      // An address that is no e-mail (Exchange's internal form) stays out.
      emails: [{ type: 'work', value: 'anna@contoso.com' }],
      phones: [
        { type: 'work', value: '+90 212 000 00 00' },
        { type: 'mobile', value: '+90 532 000 00 00' },
      ],
      address: 'Büyükdere 1, 34000 İstanbul',
      website: 'https://contoso.com',
      birthday: '1990-05-17',
      notes: 'Kuzey bölgesi',
      tags: ['Müşteri'],
      external: { provider: 'microsoft', accountId },
    });
    expect((await state())!).toMatchObject({ status: 'active', count: 1, lastError: null });
    // Someone's mailbox stays theirs.
    expect((await list(mert)).find((x) => x.displayName === 'Anna Yılmaz')).toBeUndefined();
    await expect(
      mert.api.call('getContact', { params: { contactId: c.id } }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('follows changes and deletions, and finds the folder through a contact as well', async () => {
    graph.wellKnownFolder = false;
    graph.put('m-1', anna);
    graph.put('m-2', { displayName: 'Bora', emailAddresses: [] });
    await sync();
    expect(await list()).toHaveLength(2);
    graph.put('m-1', { jobTitle: 'Müdür' });
    graph.drop('m-2');
    await sync();
    const items = await list();
    expect(items.map((c) => c.displayName)).toEqual(['Anna Yılmaz']);
    expect(items[0]!.jobTitle).toBe('Müdür');
    // A provider-only change: nothing of Crewhall's was lost.
    const { items: versions } = await owner.api.call('listContactVersions', {
      params: { contactId: items[0]!.id },
    });
    expect(versions).toEqual([]);
  });

  it('starts over when the cursor expires, dropping what is gone', async () => {
    graph.put('m-1', anna);
    graph.put('m-2', { displayName: 'Bora' });
    await sync();
    graph.expireCursor = true;
    graph.contacts.delete('m-2');
    await sync();
    expect((await list()).map((c) => c.displayName)).toEqual(['Anna Yılmaz']);
    expect((await state())!.status).toBe('active');
  });

  it('writes edits on the known version and keeps nothing when nobody else changed it', async () => {
    graph.put('m-1', anna);
    await sync();
    const c = await byName('Anna Yılmaz');
    const saved = await owner.api.call('updateContact', {
      params: { contactId: c.id },
      body: { jobTitle: 'Direktör', visibility: 'org' },
    });
    expect(graph.ifMatch.at(-1)).toMatch(/^W\/"ck-\d+"$/);
    expect(graph.contacts.get('m-1')).toMatchObject({
      jobTitle: 'Direktör',
      displayName: 'Anna Yılmaz',
    });
    expect(saved.jobTitle).toBe('Direktör');
    // Mirrored contacts cannot become the org's.
    expect(saved.visibility).toBe('private');
    await sync();
    const { items } = await owner.api.call('listContactVersions', { params: { contactId: c.id } });
    expect(items).toEqual([]);
  });

  it('keeps what the provider held when a Crewhall write overwrites it', async () => {
    graph.put('m-1', anna);
    await sync();
    const c = await byName('Anna Yılmaz');
    graph.put('m-1', { personalNotes: 'Outlook tarafında yazıldı' });
    const saved = await owner.api.call('updateContact', {
      params: { contactId: c.id },
      body: { jobTitle: 'Direktör' },
    });
    expect(graph.ifMatch.slice(-2)).toEqual([expect.any(String), null]);
    // The row ends up as the provider stored it: their notes and our title.
    expect(saved).toMatchObject({ jobTitle: 'Direktör', notes: 'Outlook tarafında yazıldı' });
    const { items } = await owner.api.call('listContactVersions', { params: { contactId: c.id } });
    expect(items).toEqual([
      expect.objectContaining({
        overwritten: 'provider',
        notes: 'Outlook tarafında yazıldı',
        jobTitle: 'Satın alma',
      }),
    ]);
  });

  it('keeps the version written from Crewhall when the provider replaces it, once', async () => {
    graph.put('m-1', anna);
    await sync();
    const c = await byName('Anna Yılmaz');
    await owner.api.call('updateContact', {
      params: { contactId: c.id },
      body: { jobTitle: 'Crewhall unvanı' },
    });
    graph.put('m-1', { jobTitle: 'Outlook unvanı' });
    await sync();
    const versions = () => owner.api.call('listContactVersions', { params: { contactId: c.id } });
    expect((await versions()).items).toEqual([
      expect.objectContaining({ overwritten: 'crewhall', jobTitle: 'Crewhall unvanı' }),
    ]);
    graph.put('m-1', { jobTitle: 'Yine Outlook' });
    await sync();
    expect((await versions()).items).toHaveLength(1);
  });

  it("keeps fax and what has no room there through the provider's version", async () => {
    graph.put('m-1', anna);
    await sync();
    const c = await byName('Anna Yılmaz');
    await owner.api.call('updateContact', {
      params: { contactId: c.id },
      body: {
        kind: 'partner',
        phones: [
          { type: 'work', value: '1' },
          { type: 'work', value: '2' },
          { type: 'work', value: '3' },
          { type: 'mobile', value: '4' },
          { type: 'fax', value: '5' },
        ],
        emails: [
          { type: 'home', value: 'a@x.com' },
          { type: 'work', value: 'b@x.com' },
          { type: 'work', value: 'c@x.com' },
          { type: 'other', value: 'd@x.com' },
        ],
      },
    });
    const sent = graph.contacts.get('m-1')!;
    expect(sent.businessPhones).toEqual(['1', '2']);
    expect(sent.emailAddresses).toHaveLength(3);
    graph.put('m-1', { jobTitle: 'Yeni' });
    await sync();
    const fresh = await owner.api.call('getContact', { params: { contactId: c.id } });
    expect(fresh.kind).toBe('partner');
    expect(fresh.phones.map((p) => p.value).sort()).toEqual(['1', '2', '3', '4', '5']);
    expect(fresh.emails.map((e) => e.value).sort()).toEqual([
      'a@x.com',
      'b@x.com',
      'c@x.com',
      'd@x.com',
    ]);
    expect(fresh.emails.find((e) => e.value === 'a@x.com')!.type).toBe('home');
  });

  it('adds a new contact to the chosen account and deletes it there too', async () => {
    await sync();
    const made = await owner.api.call('createContact', {
      body: {
        firstName: 'Cem',
        lastName: 'Kaya',
        visibility: 'org',
        emails: [{ type: 'work', value: 'cem@x.com' }],
        accountId,
      },
    });
    expect(made).toMatchObject({ visibility: 'private', external: { accountId } });
    expect(graph.created[0]).toMatchObject({ givenName: 'Cem', surname: 'Kaya' });
    await sync();
    expect((await list()).filter((c) => c.displayName === 'Cem Kaya')).toHaveLength(1);
    await owner.api.call('deleteContact', { params: { contactId: made.id } });
    expect(graph.contacts.size).toBe(0);
    expect(await list()).toEqual([]);
    // A contact without an account stays here only.
    await owner.api.call('createContact', { body: { firstName: 'Yerel' } });
    expect(graph.created).toHaveLength(1);
  });

  it("refuses an account that does not sync, or someone else's", async () => {
    await expect(
      mert.api.call('createContact', { body: { firstName: 'X', accountId } }),
    ).rejects.toBeInstanceOf(ApiError);
    await app.deps.db
      .update(calendarIntegrations)
      .set({ contactsSync: false })
      .where(eq(calendarIntegrations.provider, 'microsoft'));
    await expect(
      owner.api.call('createContact', { body: { firstName: 'X', accountId } }),
    ).rejects.toMatchObject({ code: 'contacts_account_unavailable' });
    expect(await list()).toEqual([]);
  });

  it('leaves nothing behind when the provider refuses a write', async () => {
    graph.put('m-1', anna);
    await sync();
    const c = await byName('Anna Yılmaz');
    graph.denyContacts = true;
    await expect(
      owner.api.call('updateContact', { params: { contactId: c.id }, body: { jobTitle: 'Yok' } }),
    ).rejects.toMatchObject({ code: 'calendar_external_failed' });
    await expect(
      owner.api.call('deleteContact', { params: { contactId: c.id } }),
    ).rejects.toMatchObject({ code: 'calendar_external_failed' });
    const now = await owner.api.call('getContact', { params: { contactId: c.id } });
    expect(now.jobTitle).toBe('Satın alma');
  });

  it('a refused address book asks for consent and leaves the calendar alone', async () => {
    graph.denyContacts = true;
    await sync();
    const a = (await owner.api.call('listCalendarAccounts')).items[0]!;
    expect(a.contacts).toMatchObject({ status: 'needs_consent' });
    expect(a.status).toBe('active');
  });

  it('a person who connected without the permission is not called and connects again', async () => {
    await app.deps.db
      .update(calendarAccounts)
      .set({
        delegated: false,
        refreshTokenEnc: sealSecret(app.deps.env.AUTH_SECRET, 'refresh'),
        accessTokenEnc: sealSecret(app.deps.env.AUTH_SECRET, 'access'),
        accessExpiresAt: new Date(Date.now() + 3_600_000),
      })
      .where(eq(calendarAccounts.id, accountId));
    graph.put('m-1', anna);
    await sync();
    expect((await state())!.status).toBe('needs_consent');
    expect(await list()).toEqual([]);
  });

  it('connecting asks for the address book only when the org syncs it', async () => {
    const authorize = async () => {
      const res = await mert.fetch('http://localhost:3000/api/calendar/oauth/microsoft/start', {
        redirect: 'manual',
      });
      return new URL(res.headers.get('location')!);
    };
    const asked = await authorize();
    expect(asked.searchParams.get('scope')).toContain('Contacts.ReadWrite');
    graph.put('m-1', anna);
    await mert.fetch(
      `http://localhost:3000/api/calendar/oauth/callback?code=c-1&state=${encodeURIComponent(asked.searchParams.get('state')!)}`,
      { redirect: 'manual' },
    );
    expect(graph.tokenForms.at(-1)!.get('scope')).toContain('Contacts.ReadWrite');
    const { items } = await mert.api.call('listCalendarAccounts');
    const connected = items.find((a) => a.email === 'mert@contoso.com')!;
    await syncAccount(app.deps, connected.id);
    const after = (await mert.api.call('listCalendarAccounts')).items.find(
      (a) => a.id === connected.id,
    )!;
    expect(after.contacts).toMatchObject({ status: 'active', count: 1 });
    expect((await list(mert)).map((c) => c.displayName)).toEqual(['Anna Yılmaz']);
    await mert.api.call('deleteCalendarAccount', { params: { accountId: connected.id } });
    // The mirror leaves with the account; the mailbox keeps it.
    expect(await list(mert)).toEqual([]);
    expect(graph.contacts.size).toBe(1);

    await app.deps.db
      .update(calendarIntegrations)
      .set({ contactsSync: false })
      .where(eq(calendarIntegrations.provider, 'microsoft'));
    expect((await authorize()).searchParams.get('scope')).not.toContain('Contacts.ReadWrite');
  });

  it('a refresh asks only for what was granted, so older accounts keep working', async () => {
    const expired = (contactsGranted: boolean) =>
      app.deps.db
        .update(calendarAccounts)
        .set({
          delegated: false,
          contactsGranted,
          refreshTokenEnc: sealSecret(app.deps.env.AUTH_SECRET, 'refresh'),
          accessTokenEnc: null,
          accessExpiresAt: null,
        })
        .where(eq(calendarAccounts.id, accountId));
    await expired(false);
    await sync();
    const old = graph.tokenForms.find((f) => f.get('grant_type') === 'refresh_token')!;
    expect(old.get('scope')).toContain('Calendars.ReadWrite');
    expect(old.get('scope')).not.toContain('Contacts.ReadWrite');

    graph.tokenForms = [];
    await expired(true);
    await sync();
    expect(
      graph.tokenForms.find((f) => f.get('grant_type') === 'refresh_token')!.get('scope'),
    ).toContain('Contacts.ReadWrite');
  });

  it('busy-only and switching the sync off take the mirror away; the provider keeps it', async () => {
    graph.put('m-1', anna);
    await sync();
    expect(await list()).toHaveLength(1);
    await app.deps.db
      .update(calendarAccounts)
      .set({ busyOnly: true })
      .where(eq(calendarAccounts.id, accountId));
    await sync();
    expect(await list()).toEqual([]);
    expect(await state()).toBeNull();
    expect(graph.contacts.size).toBe(1);

    // Back on: everything comes back from a full listing.
    await app.deps.db
      .update(calendarAccounts)
      .set({ busyOnly: false })
      .where(eq(calendarAccounts.id, accountId));
    await sync();
    expect(await list()).toHaveLength(1);

    await owner.api.call('updateCalendarIntegration', {
      params: { provider: 'microsoft' },
      body: { enabled: true, contactsSync: false },
    });
    await sync();
    expect(await list()).toEqual([]);
    await owner.api.call('updateCalendarIntegration', {
      params: { provider: 'microsoft' },
      body: { enabled: true, contactsSync: true },
    });
  });

  it('a vCard import does not change a mirrored contact behind its back', async () => {
    graph.put('m-1', anna);
    await sync();
    const res = await owner.api.call('importContactsVcard', {
      body: {
        vcf: 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Başka\r\nEMAIL:anna@contoso.com\r\nEND:VCARD\r\n',
        visibility: 'private',
      },
    });
    expect(res).toMatchObject({ created: 0, updated: 0, skipped: 1 });
    expect((await byName('Anna Yılmaz')).displayName).toBe('Anna Yılmaz');
  });

  it('maps addresses and fields to Graph', () => {
    expect(
      addressLine({
        businessAddress: { street: ' ', city: null },
        homeAddress: { street: 'Ev 1', city: 'Ankara', countryOrRegion: 'Türkiye' },
      }),
    ).toBe('Ev 1, Ankara, Türkiye');
    expect(toGraph({ jobTitle: null, birthday: '1990-05-17' })).toEqual({
      jobTitle: '',
      birthday: '1990-05-17T12:00:00Z',
    });
    const cleared = toGraph({ address: null });
    expect(cleared.homeAddress).toEqual(cleared.businessAddress);
  });
});
