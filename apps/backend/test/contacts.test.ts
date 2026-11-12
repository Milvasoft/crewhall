import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { externalIdentities, identityProviders } from '@crewhall/db';
import { ApiError } from '@crewhall/api-client';
import { invalidateModules } from '../src/services/identity/modules';
import { applyDirectoryEntries } from '../src/services/contacts/directory-sync';
import { buildVcard, parseVcards } from '../src/services/contacts/vcard';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/** Contacts and directory (roadmap 15). */

describe('vcard', () => {
  it('reads 3.0 and 4.0 cards with groups, types and escapes', () => {
    const text = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'UID:abc-1',
      'N:Yılmaz;Ayşe;;;',
      'FN:Ayşe Yılmaz',
      'ORG:Opsiyon A.Ş.;Satın alma',
      'TITLE:Satın alma müdürü',
      'item1.EMAIL;TYPE=INTERNET,WORK:AYSE@opsiyon.com',
      'TEL;TYPE=CELL:+90 532 111 22 33',
      'NOTE:İlk satır\\nikinci\\, virgüllü',
      'CATEGORIES:VIP,Tedarik',
      'BDAY:1990-05-19',
      'END:VCARD',
      'BEGIN:VCARD',
      'VERSION:4.0',
      'KIND:org',
      'FN:Dumpapp Ltd',
      'ORG:Dumpapp Ltd',
      'END:VCARD',
      'BEGIN:VCARD',
      'VERSION:3.0',
      'END:VCARD',
    ].join('\r\n');
    const { cards, errors } = parseVcards(text);
    expect(errors).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      uid: 'abc-1',
      firstName: 'Ayşe',
      lastName: 'Yılmaz',
      company: 'Opsiyon A.Ş.',
      emails: [{ type: 'work', value: 'ayse@opsiyon.com' }],
      phones: [{ type: 'mobile', value: '+90 532 111 22 33' }],
      notes: 'İlk satır\nikinci, virgüllü',
      tags: ['VIP', 'Tedarik'],
      birthday: '1990-05-19',
    });
    expect(cards[1]).toMatchObject({ isCompany: true, displayName: 'Dumpapp Ltd' });
    const out = buildVcard({
      uid: 'abc-1',
      displayName: 'Ayşe Yılmaz',
      firstName: 'Ayşe',
      lastName: 'Yılmaz',
      company: 'Opsiyon A.Ş.',
      jobTitle: null,
      emails: cards[0]!.emails,
      phones: cards[0]!.phones,
      address: null,
      website: null,
      birthday: null,
      notes: 'a;b',
      tags: ['VIP'],
      updated: new Date('2026-10-22T00:00:00Z'),
    });
    expect(out).toContain('N:Yılmaz;Ayşe;;;');
    expect(out).toContain('NOTE:a\\;b');
    expect(parseVcards(out).cards[0]).toMatchObject({ firstName: 'Ayşe', notes: 'a;b' });
  });
});

describe('contacts module', () => {
  let app: TestApp;
  let owner: Client;
  let mert: Client;
  let ownerId: string;
  let mertId: string;
  let orgId: string;

  async function expectCode(p: Promise<unknown>, status: number, code?: string) {
    try {
      await p;
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(status);
      if (code) expect((err as ApiError).code).toBe(code);
      return;
    }
    throw new Error(`expected ${status}`);
  }

  beforeAll(async () => {
    app = await createTestApp();
    const setup = await setupWithOwner(app);
    owner = setup.owner;
    ownerId = setup.ownerId;
    orgId = setup.orgId;
    const joined = await join(app, owner, 'mert@milvasoft.com', 'member');
    mert = joined.person;
    mertId = joined.me.user.id;
    await join(app, owner, 'misafir@example.com', 'guest');
  });

  afterAll(async () => {
    await app?.close();
  });

  it('lists the org directory without guests and edits profiles by role', async () => {
    const list = await mert.api.call('listDirectory', { query: {} });
    expect(list.items.map((p) => p.user.email).sort()).toEqual([
      'bugra@milvasoft.com',
      'mert@milvasoft.com',
    ]);
    // A member edits their own profile, not the manager line, not others.
    const mine = await mert.api.call('updateDirectoryProfile', {
      params: { userId: mertId },
      body: { title: 'Backend geliştirici', department: 'Mühendislik', phone: '+90 212 000 00 00' },
    });
    expect(mine).toMatchObject({
      title: 'Backend geliştirici',
      permissions: { edit: true, editManager: false },
    });
    await expectCode(
      mert.api.call('updateDirectoryProfile', {
        params: { userId: mertId },
        body: { managerId: ownerId },
      }),
      403,
    );
    await expectCode(
      mert.api.call('updateDirectoryProfile', {
        params: { userId: ownerId },
        body: { title: 'x' },
      }),
      403,
    );
    // The admin sets the manager; a loop is refused.
    await owner.api.call('updateDirectoryProfile', {
      params: { userId: mertId },
      body: { managerId: ownerId },
    });
    await expectCode(
      owner.api.call('updateDirectoryProfile', {
        params: { userId: ownerId },
        body: { managerId: mertId },
      }),
      422,
      'directory_manager_cycle',
    );
    const chart = await owner.api.call('getOrgChart');
    expect(chart.items.find((n) => n.user.id === mertId)?.managerId).toBe(ownerId);
    expect(chart.items.find((n) => n.user.id === ownerId)).toMatchObject({
      managerId: null,
      reportCount: 1,
    });
    const search = await owner.api.call('listDirectory', { query: { q: 'mühendis' } });
    expect(search.items.map((p) => p.user.id)).toEqual([mertId]);
    const facets = await owner.api.call('getDirectoryFacets');
    expect(facets.departments).toEqual([{ value: 'Mühendislik', count: 1 }]);
  });

  it('takes profile fields from the AD/LDAP entries identity linked', async () => {
    const [provider] = await app.deps.db
      .insert(identityProviders)
      .values({
        orgId,
        kind: 'ldap',
        preset: 'active_directory',
        name: 'AD',
        enabled: true,
        config: {},
      })
      .returning();
    await app.deps.db.insert(externalIdentities).values([
      {
        orgId,
        providerId: provider!.id,
        userId: mertId,
        subject: 'mert',
        dn: 'CN=Mert,OU=Users,DC=ms,DC=local',
      },
      {
        orgId,
        providerId: provider!.id,
        userId: ownerId,
        subject: 'bugra',
        dn: 'CN=Bugra,OU=Users,DC=ms,DC=local',
      },
    ]);
    await applyDirectoryEntries(app.deps.db, provider!, [
      {
        dn: 'cn=mert, ou=users, dc=ms, dc=local',
        values: {
          title: 'Kıdemli geliştirici',
          department: 'Ar-Ge',
          managerId: 'CN=Bugra,OU=Users,DC=ms,DC=local',
        },
      },
    ]);
    const p = await mert.api.call('getDirectoryPerson', { params: { userId: mertId } });
    expect(p).toMatchObject({
      title: 'Kıdemli geliştirici',
      department: 'Ar-Ge',
      manager: { id: ownerId },
      fromDirectory: true,
    });
    expect(p.syncedFields.sort()).toEqual(['department', 'managerId', 'title']);
    await expectCode(
      mert.api.call('updateDirectoryProfile', { params: { userId: mertId }, body: { title: 'x' } }),
      409,
      'directory_field_synced',
    );
    // Fields the directory does not fill stay editable.
    await mert.api.call('updateDirectoryProfile', {
      params: { userId: mertId },
      body: { mobile: '+90 555' },
    });
  });

  it('keeps a shared address book with companies, tags, search and private entries', async () => {
    const company = await owner.api.call('createContactCompany', {
      body: { name: 'Opsiyon A.Ş.', kind: 'customer', tags: ['VIP'] },
    });
    const c = await owner.api.call('createContact', {
      body: {
        firstName: 'Ayşe',
        lastName: 'Yılmaz',
        companyId: company.id,
        emails: [{ type: 'work', value: 'ayse@opsiyon.com' }],
        phones: [{ type: 'mobile', value: '+90 532 111 22 33' }],
        tags: ['VIP', 'Satın alma', 'vip'],
      },
    });
    expect(c).toMatchObject({
      displayName: 'Ayşe Yılmaz',
      tags: ['VIP', 'Satın alma'],
      company: { name: 'Opsiyon A.Ş.' },
    });
    const secret = await mert.api.call('createContact', {
      body: { firstName: 'Gizli', lastName: 'Kişi', visibility: 'private', kind: 'supplier' },
    });
    // Search by name, phone digits, company and tag.
    for (const q of ['ayşe', '5321112233', 'opsiyon', 'satın']) {
      const r = await mert.api.call('listContacts', { query: { q } });
      expect(
        r.items.map((x) => x.id),
        q,
      ).toEqual([c.id]);
    }
    expect((await owner.api.call('listContacts', { query: {} })).items.map((x) => x.id)).toEqual([
      c.id,
    ]);
    expect(
      (await mert.api.call('listContacts', { query: { mine: 'true' } })).items.map((x) => x.id),
    ).toEqual([secret.id]);
    await expectCode(owner.api.call('getContact', { params: { contactId: secret.id } }), 404);
    // Members edit org contacts; only the creator or an admin deletes them.
    const edited = await mert.api.call('updateContact', {
      params: { contactId: c.id },
      body: { jobTitle: 'Satın alma müdürü' },
    });
    expect(edited.permissions).toEqual({ edit: true, delete: false });
    await expectCode(mert.api.call('deleteContact', { params: { contactId: c.id } }), 403);
    const tags = await owner.api.call('listContactTags');
    expect(tags.items.find((x) => x.tag === 'VIP')?.count).toBe(2);
    const companies = await owner.api.call('listContactCompanies', { query: {} });
    expect(companies.items[0]).toMatchObject({ name: 'Opsiyon A.Ş.', contactCount: 1 });
    await owner.api.call('deleteContactCompany', { params: { companyId: company.id } });
    expect(
      (await owner.api.call('getContact', { params: { contactId: c.id } })).company,
    ).toBeNull();
  });

  it('imports and exports vCards', async () => {
    const vcf = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'UID:imp-1',
      'FN:Can Demir',
      'N:Demir;Can;;;',
      'ORG:Dumpapp Ltd',
      'EMAIL:can@dumpapp.com',
      'END:VCARD',
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Ayşe Y.',
      'EMAIL:ayse@opsiyon.com',
      'END:VCARD',
    ].join('\r\n');
    const r = await owner.api.call('importContactsVcard', { body: { vcf } });
    expect(r).toMatchObject({ created: 1, updated: 1, skipped: 0 });
    const list = await owner.api.call('listContacts', { query: { q: 'can' } });
    expect(list.items[0]).toMatchObject({
      displayName: 'Can Demir',
      company: { name: 'Dumpapp Ltd' },
    });
    await expectCode(
      owner.api.call('importContactsVcard', { body: { vcf: 'nothing here' } }),
      422,
      'contacts_vcard_invalid',
    );
    const res = await owner.fetch('http://localhost:3000/api/v1/contacts/export.vcf');
    expect(res.headers.get('content-type')).toContain('text/vcard');
    const text = await res.text();
    expect(text).toContain('FN:Can Demir');
    expect(text).not.toContain('Gizli');
    const dir = await (
      await owner.fetch('http://localhost:3000/api/v1/directory/export.vcf')
    ).text();
    expect(dir).toContain('EMAIL;TYPE=INTERNET,WORK:mert@milvasoft.com');
  });

  it('refuses guests', async () => {
    const guest = new Client(app);
    await guest.signIn('misafir@example.com');
    await expectCode(guest.api.call('listDirectory', { query: {} }), 403);
    await expectCode(guest.api.call('listContacts', { query: {} }), 403);
  });

  describe('CardDAV', () => {
    let token: string;
    const dav = (
      method: string,
      path: string,
      body?: string,
      headers: Record<string, string> = {},
    ) =>
      app.app.request(`http://localhost:3000${path}`, {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`x:${token}`).toString('base64')}`,
          ...(body ? { 'Content-Type': 'application/xml' } : {}),
          ...headers,
        },
        body,
      });

    beforeAll(async () => {
      token = (
        await owner.api.call('createMcpToken', {
          body: {
            name: 'Rehber',
            scopes: ['hub:read', 'contacts:write'],
            spaceIds: null,
            expiresInDays: 30,
          },
        })
      ).value;
    });

    it('lists the address books and serves the directory read-only', async () => {
      const home = await dav(
        'PROPFIND',
        '/carddav/addressbooks/',
        '<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/"><d:prop><d:displayname/><d:resourcetype/><cs:getctag/></d:prop></d:propfind>',
        { Depth: '1' },
      );
      expect(home.status).toBe(207);
      const text = await home.text();
      for (const b of ['directory', 'shared', 'private'])
        expect(text).toContain(`/carddav/addressbooks/${b}/`);
      expect(text).toContain('<CR:addressbook/>');
      const report = await dav(
        'REPORT',
        '/carddav/addressbooks/directory/',
        '<c:addressbook-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav"><d:prop><d:getetag/><c:address-data/></d:prop></c:addressbook-query>',
        { Depth: '1' },
      );
      expect(await report.text()).toContain('FN:mert');
      const put = await dav(
        'PUT',
        '/carddav/addressbooks/directory/x.vcf',
        'BEGIN:VCARD\r\nFN:x\r\nEND:VCARD',
      );
      expect(put.status).toBe(403);
    });

    it('creates, updates and deletes a shared contact', async () => {
      const path = '/carddav/addressbooks/shared/phone-1.vcf';
      const card = (fn: string) =>
        `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:phone-uid-1\r\nFN:${fn}\r\nN:;${fn};;;\r\nEND:VCARD\r\n`;
      const created = await dav('PUT', path, card('Telefondan Kişi'), { 'If-None-Match': '*' });
      expect(created.status).toBe(201);
      const etag = created.headers.get('etag')!;
      const listed = await owner.api.call('listContacts', { query: { q: 'telefondan' } });
      expect(listed.items).toHaveLength(1);
      const stale = await dav('PUT', path, card('x'), { 'If-Match': '"stale"' });
      expect(stale.status).toBe(412);
      const updated = await dav('PUT', path, card('Telefondan Güncel'), { 'If-Match': etag });
      expect(updated.status).toBe(204);
      const got = await dav('GET', path);
      expect(await got.text()).toContain('FN:Telefondan Güncel');
      expect((await dav('DELETE', path)).status).toBe(204);
      expect((await dav('GET', path)).status).toBe(404);
    });

    it('closes with the module', async () => {
      await owner.api.call('updateOrg', { body: { settings: { modules: { contacts: false } } } });
      invalidateModules();
      await expectCode(owner.api.call('listDirectory', { query: {} }), 403, 'module_disabled');
      expect((await dav('PROPFIND', '/carddav/', undefined, { Depth: '0' })).status).toBe(403);
      await owner.api.call('updateOrg', { body: { settings: { modules: { contacts: true } } } });
      invalidateModules();
    });
  });
});
