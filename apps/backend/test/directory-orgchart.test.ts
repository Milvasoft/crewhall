import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportPKCS8, generateKeyPair } from 'jose';
import { ApiError } from '@crewhall/api-client';
import { setCalendarFetch } from '../src/services/calendar/external/http';
import { clearServiceAccountTokens } from '../src/services/calendar/external/service-account';
import { parseCsv } from '../src/services/contacts/directory-import';
import { googleValues } from '../src/services/contacts/google-directory';
import { syncGoogleDirectories } from '../src/services/contacts/google-directory';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/** Org chart (sonraki-isler): drag permissions, CSV import, Google Workspace directory. */

describe('directory CSV', () => {
  it('reads quoted fields, semicolons (Turkish Excel) and a byte order mark', () => {
    const bom = String.fromCharCode(0xfeff);
    expect(
      parseCsv(`${bom}E-posta;Unvan\r\na@x.com;"Satış; bölge"\n"b@x.com";"Çift ""tırnak"""`),
    ).toEqual([
      ['E-posta', 'Unvan'],
      ['a@x.com', 'Satış; bölge'],
      ['b@x.com', 'Çift "tırnak"'],
    ]);
    expect(parseCsv('email,title\nc@x.com,Lead\n')).toEqual([
      ['email', 'title'],
      ['c@x.com', 'Lead'],
    ]);
  });

  it('maps a Workspace user to directory fields', () => {
    expect(
      googleValues({
        primaryEmail: 'ayse@x.com',
        organizations: [
          { title: 'Eski', primary: false },
          { title: 'Mühendis', department: 'Ar-Ge', costCenter: 'Platform', primary: true },
        ],
        phones: [
          { value: '+90 212', type: 'work' },
          { value: '+90 532', type: 'mobile' },
        ],
        locations: [{ buildingId: 'İstanbul', floorName: '3' }],
        relations: [{ type: 'manager', value: 'bugra@x.com' }],
      }),
    ).toEqual({
      title: 'Mühendis',
      department: 'Ar-Ge',
      team: 'Platform',
      phone: '+90 212',
      mobile: '+90 532',
      location: 'İstanbul · 3',
      managerId: 'bugra@x.com',
    });
  });
});

describe('org chart: managers', () => {
  let app: TestApp;
  let owner: Client;
  let mert: Client;
  let ownerId: string;
  let mertId: string;
  let ayseId: string;

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
    const m = await join(app, owner, 'mert@milvasoft.com', 'member');
    mert = m.person;
    mertId = m.me.user.id;
    ayseId = (await join(app, owner, 'ayse@milvasoft.com', 'member')).me.user.id;
  });

  afterAll(async () => {
    setCalendarFetch(null);
    await app?.close();
  });

  it('tells who may move people in the chart', async () => {
    expect((await owner.api.call('getOrgChart')).permissions).toEqual({ editManager: true });
    expect((await mert.api.call('getOrgChart')).permissions).toEqual({ editManager: false });
  });

  it('imports managers and fields from CSV in order, with a dry run first', async () => {
    const csv = [
      'E-posta;Unvan;Departman;Ekip;Yönetici',
      'mert@milvasoft.com;Backend geliştirici;Mühendislik;Platform;bugra@milvasoft.com',
      'ayse@milvasoft.com;Tasarımcı;Ürün;;mert@milvasoft.com',
      'yok@milvasoft.com;X;;;',
      // Mert's manager would be Ayşe, whose manager is Mert (set two lines up): a loop.
      'bugra@milvasoft.com;Kurucu;;;ayse@milvasoft.com',
      ';;;;',
    ].join('\n');
    const dry = await owner.api.call('importDirectory', { body: { csv, dryRun: true } });
    expect(dry).toMatchObject({ dryRun: true, updated: 2, failed: 2 });
    expect(dry.rows.map((r) => [r.line, r.status, r.code])).toEqual([
      [2, 'updated', null],
      [3, 'updated', null],
      [4, 'failed', 'directory_person_unknown'],
      [5, 'failed', 'directory_manager_cycle'],
    ]);
    expect(dry.rows[0]!.fields).toEqual(['title', 'department', 'team', 'managerId']);
    // Nothing changed yet.
    let chart = await owner.api.call('getOrgChart');
    expect(chart.items.find((n) => n.user.id === mertId)?.managerId).toBeNull();

    const real = await owner.api.call('importDirectory', { body: { csv } });
    expect(real).toMatchObject({ dryRun: false, updated: 2, failed: 2 });
    chart = await owner.api.call('getOrgChart');
    expect(chart.items.find((n) => n.user.id === mertId)).toMatchObject({
      managerId: ownerId,
      team: 'Platform',
      department: 'Mühendislik',
      managerSynced: false,
    });
    expect(chart.items.find((n) => n.user.id === ayseId)?.managerId).toBe(mertId);
    // The same file again changes nothing.
    const again = await owner.api.call('importDirectory', { body: { csv } });
    expect(again).toMatchObject({ updated: 0, unchanged: 2, failed: 2 });
  });

  it('refuses CSV import to members and files without an e-mail column', async () => {
    await expectCode(
      mert.api.call('importDirectory', { body: { csv: 'email\nmert@milvasoft.com' } }),
      403,
      'forbidden',
    );
    await expectCode(
      owner.api.call('importDirectory', { body: { csv: 'ad;unvan\nMert;X' } }),
      422,
      'directory_csv_invalid',
    );
  });

  it('reads the Google Workspace directory with the service account', async () => {
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    const key = JSON.stringify({
      type: 'service_account',
      client_email: 'crewhall@proj.iam.gserviceaccount.com',
      private_key: await exportPKCS8(privateKey),
    });
    const calls: string[] = [];
    let denied = false;
    setCalendarFetch(async (input, init) => {
      const href = String(input);
      calls.push(href.split('?')[0]!);
      if (href === 'https://oauth2.googleapis.com/token') {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
        if (denied) return Response.json({ error: 'unauthorized_client' }, { status: 401 });
        return Response.json({ access_token: 'sa-token', expires_in: 3600 });
      }
      if (href.startsWith('https://admin.googleapis.com/admin/directory/v1/users')) {
        expect((init?.headers as Record<string, string>).authorization).toBe('Bearer sa-token');
        return Response.json({
          users: [
            {
              primaryEmail: 'ayse@milvasoft.com',
              organizations: [{ title: 'Kıdemli tasarımcı', department: 'Ürün', primary: true }],
              relations: [{ type: 'manager', value: 'bugra@milvasoft.com' }],
            },
            { primaryEmail: 'disarida@other.com', organizations: [{ title: 'X' }] },
          ],
        });
      }
      return new Response('unexpected', { status: 500 });
    });

    // Directory sync needs the key and the admin to act as.
    await expectCode(
      owner.api.call('updateCalendarIntegration', {
        params: { provider: 'google' },
        body: { enabled: false, directorySync: true },
      }),
      422,
      'validation_failed',
    );
    await expectCode(
      owner.api.call('updateCalendarIntegration', {
        params: { provider: 'google' },
        body: { enabled: false, serviceAccountKey: '{"type":"user"}' },
      }),
      422,
      'validation_failed',
    );
    const saved = await owner.api.call('updateCalendarIntegration', {
      params: { provider: 'google' },
      body: {
        enabled: false,
        serviceAccountKey: key,
        delegatedAdmin: 'admin@milvasoft.com',
        directorySync: true,
      },
    });
    expect(saved).toMatchObject({
      serviceAccountEmail: 'crewhall@proj.iam.gserviceaccount.com',
      delegatedAdmin: 'admin@milvasoft.com',
      directorySync: true,
    });
    expect(JSON.stringify(saved)).not.toContain('PRIVATE KEY');

    const synced = await owner.api.call('syncWorkspaceDirectory');
    expect(synced).toMatchObject({ directoryError: null });
    expect(synced.directorySyncedAt).not.toBeNull();
    const ayse = await owner.api.call('getDirectoryPerson', { params: { userId: ayseId } });
    expect(ayse).toMatchObject({
      title: 'Kıdemli tasarımcı',
      department: 'Ürün',
      manager: { id: ownerId },
    });
    expect(ayse.syncedFields.sort()).toEqual(['department', 'managerId', 'title']);
    // Synced: the chart shows it and refuses to move it.
    const chart = await owner.api.call('getOrgChart');
    expect(chart.items.find((n) => n.user.id === ayseId)?.managerSynced).toBe(true);
    await expectCode(
      owner.api.call('updateDirectoryProfile', {
        params: { userId: ayseId },
        body: { managerId: mertId },
      }),
      409,
      'directory_field_synced',
    );

    // Delegation withdrawn in the Workspace console: the error shows, nothing else breaks.
    denied = true;
    clearServiceAccountTokens();
    await syncGoogleDirectories(app.deps);
    const list = await owner.api.call('getCalendarIntegrations');
    expect(list.items.find((i) => i.provider === 'google')?.directoryError).toBe(
      'unauthorized_client',
    );
    expect(calls).toContain('https://admin.googleapis.com/admin/directory/v1/users');
  });
});
