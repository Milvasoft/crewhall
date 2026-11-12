import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedTestContainer } from 'testcontainers';
import { Attribute, Change } from 'ldapts';
import { and, eq } from 'drizzle-orm';
import { auditLogs } from '@crewhall/db';
import { Client, createTestApp, setupWithOwner, type TestApp } from './helpers';
import {
  LDAP_ADMIN,
  LDAP_ADMIN_PASSWORD,
  LDAP_BASE,
  seedDirectory,
  startOpenLdap,
  stopAll,
  withAdmin,
} from './identity-containers';

/** Active Directory / LDAP sign-in against a real OpenLDAP (Testcontainers). */
describe('directory (LDAP) sign-in', () => {
  let app: TestApp;
  let owner: Client;
  let orgId: string;
  let ldap: StartedTestContainer;
  let url: string;
  let providerId: string;
  let altyapiId: string;

  beforeAll(async () => {
    const started = await startOpenLdap();
    ldap = started.container;
    url = started.url;
    await seedDirectory(
      url,
      [
        {
          uid: 'ayse',
          cn: 'Ayşe Yılmaz',
          sn: 'Yılmaz',
          mail: 'ayse@crewhall.test',
          password: 'ayse-dir-pass-1',
        },
        {
          uid: 'mert',
          cn: 'Mert Kaya',
          sn: 'Kaya',
          mail: 'mert@crewhall.test',
          password: 'mert-dir-pass-1',
        },
        {
          uid: 'deniz',
          cn: 'Deniz Ak',
          sn: 'Ak',
          mail: 'deniz@crewhall.test',
          password: 'deniz-dir-pass-1',
        },
      ],
      { developers: ['ayse'], 'it-admins': ['mert'] },
    );
    app = await createTestApp();
    ({ owner, orgId } = await setupWithOwner(app));
    const spaces = await owner.api.call('listSpaces');
    altyapiId = spaces.items.find((s) => s.name === 'Altyapı')!.id;
  });
  afterAll(async () => {
    await app?.close();
    await stopAll(ldap);
  });

  const config = () => ({
    url,
    startTls: false,
    caCert: null,
    tlsVerify: true,
    bindDn: LDAP_ADMIN,
    baseDn: `ou=people,${LDAP_BASE}`,
    userFilter: '(&(objectClass=inetOrgPerson)(|(uid={username})(mail={username})))',
    emailAttribute: 'mail',
    nameAttribute: 'displayName',
    uidAttribute: 'entryUUID',
    useMemberOf: false,
    groupBaseDn: `ou=groups,${LDAP_BASE}`,
    groupFilter: '(&(objectClass=groupOfNames)(member={dn}))',
    groupNameAttribute: 'cn',
    activeDirectory: false,
    timeoutMs: 5000,
  });

  it('tests the connection before saving and looks a person up', async () => {
    const draft = {
      kind: 'ldap' as const,
      name: 'Şirket dizini',
      preset: 'openldap' as const,
      config: config(),
      bindPassword: LDAP_ADMIN_PASSWORD,
      roleMappings: [
        { group: 'it-admins', orgRole: 'admin' as const },
        { group: 'developers', spaceId: altyapiId, spaceRole: 'editor' as const },
      ],
    };
    const result = await owner.api.call('testIdentityProvider', {
      body: { draft: draft as never, username: 'ayse' },
    });
    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.key)).toEqual(['bind', 'search', 'user']);
    expect(result.user).toMatchObject({
      email: 'ayse@crewhall.test',
      name: 'Ayşe Yılmaz',
      groups: ['developers'],
      disabled: false,
    });

    const bad = await owner.api.call('testIdentityProvider', {
      body: { draft: { ...draft, bindPassword: 'wrong' } as never },
    });
    expect(bad.ok).toBe(false);
    expect(bad.steps[0]).toMatchObject({ key: 'bind', ok: false });
  });

  it('saves the directory without ever returning the bind password', async () => {
    const created = await owner.api.call('createIdentityProvider', {
      body: {
        kind: 'ldap',
        name: 'Şirket dizini',
        preset: 'openldap',
        domains: ['crewhall.test'],
        config: config(),
        bindPassword: LDAP_ADMIN_PASSWORD,
        syncEnabled: true,
        roleMappings: [
          { group: 'it-admins', orgRole: 'admin' },
          { group: 'developers', spaceId: altyapiId, spaceRole: 'editor' },
        ],
      } as never,
    });
    providerId = created.id;
    expect(created.hasSecret).toBe(true);
    expect(JSON.stringify(created)).not.toContain(LDAP_ADMIN_PASSWORD);

    const boot = await new Client(app).api.call('bootstrap');
    expect(boot.auth.ldap).toEqual({ label: 'Şirket dizini' });
    const disc = await new Client(app).api.call('discoverSignIn', {
      body: { email: 'x@crewhall.test' },
    });
    expect(disc).toMatchObject({ method: 'password', ldap: true });
  });

  it('refuses wrong and unknown credentials alike', async () => {
    const c = new Client(app);
    const wrong = await c.auth<{ code: string }>('/sign-in/ldap', {
      username: 'ayse',
      password: 'nope',
    });
    const unknown = await c.auth<{ code: string }>('/sign-in/ldap', {
      username: 'nobody',
      password: 'nope',
    });
    const empty = await c.auth<{ code: string }>('/sign-in/ldap', {
      username: 'ayse',
      password: '',
    });
    expect([wrong.status, unknown.status, empty.status]).toEqual([401, 401, 401]);
    expect(wrong.body.code).toBe('INVALID_EMAIL_OR_PASSWORD');
    expect(unknown.body.code).toBe(wrong.body.code);
  });

  it('signs a person in by user name, creates the account and maps groups to a space', async () => {
    const ayse = new Client(app);
    const res = await ayse.auth<{ token: string; user: { email: string } }>('/sign-in/ldap', {
      username: 'ayse',
      password: 'ayse-dir-pass-1',
    });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('ayse@crewhall.test');
    // Bearer clients (mobile) get the same token header as /sign-in/email.
    expect(res.headers.get('set-auth-token')).toBeTruthy();

    const me = await ayse.api.call('me');
    expect(me.memberships[0]).toMatchObject({ orgId, role: 'member' });
    const spaces = await ayse.api.call('listSpaces');
    expect(spaces.items.find((s) => s.id === altyapiId)?.myRole).toBe('editor');

    const mobile = new Client(app);
    mobile.bearer = res.headers.get('set-auth-token');
    mobile.cookies.clear();
    expect((await mobile.api.call('me')).user.email).toBe('ayse@crewhall.test');

    const rows = await app.deps.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.orgId, orgId), eq(auditLogs.action, 'identity.user.provision')));
    expect(rows).toHaveLength(1);
  });

  it('accepts the e-mail too and maps a group to the admin role', async () => {
    const mert = new Client(app);
    const res = await mert.auth('/sign-in/ldap', {
      username: 'mert@crewhall.test',
      password: 'mert-dir-pass-1',
    });
    expect(res.status).toBe(200);
    const me = await mert.api.call('me');
    expect(me.memberships[0]?.role).toBe('admin');
    // Admins need 2FA: TOTP enrolment works without a local password.
    expect(me.twoFactorRequired).toBe(true);
    const enabled = await mert.auth<{ totpURI: string }>('/two-factor/enable', {});
    expect(enabled.status).toBe(200);
  });

  it('locks the account after five wrong directory passwords', async () => {
    const c = new Client(app);
    let last = { status: 0, body: {} as { code?: string } };
    for (let i = 0; i < 5; i++) {
      last = await c.auth<{ code?: string }>('/sign-in/ldap', {
        username: 'deniz',
        password: `bad-${i}`,
      });
    }
    expect(last.status).toBe(423);
    expect(last.body.code).toBe('ACCOUNT_LOCKED');
    const right = await c.auth('/sign-in/ldap', {
      username: 'deniz',
      password: 'deniz-dir-pass-1',
    });
    expect(right.status).toBe(423);
  });

  it('syncs the directory: removed people are suspended, returning ones reactivated, roles follow groups', async () => {
    const ayse = new Client(app);
    expect(
      (await ayse.auth('/sign-in/ldap', { username: 'ayse', password: 'ayse-dir-pass-1' })).status,
    ).toBe(200);

    await withAdmin(url, async (c) => {
      await c.modify(
        `cn=developers,ou=groups,${LDAP_BASE}`,
        // groupOfNames needs one member; keep mert there.
        [
          new Change({
            operation: 'add',
            modification: new Attribute({
              type: 'member',
              values: [`uid=mert,ou=people,${LDAP_BASE}`],
            }),
          }),
          new Change({
            operation: 'delete',
            modification: new Attribute({
              type: 'member',
              values: [`uid=ayse,ou=people,${LDAP_BASE}`],
            }),
          }),
        ],
      );
      await c.del(`uid=ayse,ou=people,${LDAP_BASE}`);
    });
    const summary = await owner.api.call('syncIdentityProvider', { params: { providerId } });
    expect(summary).toMatchObject({ suspended: 1 });
    // Signed-in devices lost access at once.
    await expect(ayse.api.call('listSpaces')).rejects.toMatchObject({ status: 401 });
    const blocked = await new Client(app).auth('/sign-in/ldap', {
      username: 'ayse',
      password: 'ayse-dir-pass-1',
    });
    expect(blocked.status).toBe(401);

    await withAdmin(url, async (c) => {
      await c.add(`uid=ayse,ou=people,${LDAP_BASE}`, {
        objectClass: ['inetOrgPerson'],
        uid: 'ayse',
        cn: 'Ayşe Yılmaz',
        sn: 'Yılmaz',
        displayName: 'Ayşe Yılmaz',
        mail: 'ayse@crewhall.test',
        userPassword: 'ayse-dir-pass-1',
      });
    });
    // A re-created entry has a new entryUUID: the e-mail finds the same link row and the
    // suspension the sync made is lifted.
    const again = new Client(app);
    const back = await again.auth('/sign-in/ldap', {
      username: 'ayse',
      password: 'ayse-dir-pass-1',
    });
    expect(back.status).toBe(200);
    // Group membership is gone, so is the directory-managed space membership.
    const spaces = await again.api.call('listSpaces');
    expect(spaces.items.find((s) => s.id === altyapiId)).toBeUndefined();

    const view = await owner.api.call('getIdentityProvider', { params: { providerId } });
    expect(view.status.lastSyncOk).toBe(true);
    const users = await owner.api.call('listLinkedIdentities', {
      params: { providerId },
      query: {} as never,
    });
    expect(users.items.find((u) => u.email === 'ayse@crewhall.test')).toMatchObject({
      directoryStatus: 'active',
      memberStatus: 'active',
    });
    const second = await owner.api.call('syncIdentityProvider', { params: { providerId } });
    expect(second).toMatchObject({ suspended: 0 });
  });

  it('refuses directory sign-in when the directory is switched off', async () => {
    await owner.api.call('updateIdentityProvider', {
      params: { providerId },
      body: { enabled: false },
    });
    const res = await new Client(app).auth<{ code: string }>('/sign-in/ldap', {
      username: 'mert',
      password: 'mert-dir-pass-1',
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('LDAP_DISABLED');
    const boot = await new Client(app).api.call('bootstrap');
    expect(boot.auth.ldap).toBeNull();
  });
});
