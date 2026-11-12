import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { profileFromClaims } from '../src/services/identity/sso';
import { hasGroupOverage, policyRefusal } from '../src/services/microsoft/entra';
import { expandGroupIds } from '../src/services/microsoft/scim';
import { Client, createTestApp, setupWithOwner, SETUP_BODY, type TestApp } from './helpers';

const SCIM = '/api/scim/v2';
const ENTRA_ISSUER = 'https://login.microsoftonline.com/0f3c1d2e-1111-4a4a-9b9b-123456789abc/v2.0';

interface ScimList<T> {
  totalResults: number;
  Resources: T[];
}
interface ScimUser {
  id: string;
  userName: string;
  active: boolean;
  displayName: string;
  externalId?: string;
  groups: { value: string; display: string }[];
}

/** Entra ID provisioning against the SCIM 2.0 server, with Entra's own request shapes. */
describe('SCIM 2.0 server (Entra provisioning)', () => {
  let app: TestApp;
  let owner: Client;
  let scim: Client;
  let providerId: string;
  let altyapiId: string;
  let tokenId: string;
  let ayseId: string;

  beforeAll(async () => {
    app = await createTestApp();
    ({ owner } = await setupWithOwner(app));
    altyapiId = (await owner.api.call('listSpaces')).items.find((s) => s.name === 'Altyapı')!.id;
    const provider = await owner.api.call('createIdentityProvider', {
      body: {
        kind: 'oidc',
        preset: 'entra',
        name: 'Contoso Entra',
        domains: ['contoso.test'],
        config: { issuer: ENTRA_ISSUER, clientId: '7d1f0a52-0000-4b4b-8c8c-abcdefabcdef' },
        clientSecret: 'entra-secret-value',
        roleMappings: [
          { group: 'Crewhall Admins', orgRole: 'admin' },
          { group: 'Altyapı Ekibi', spaceId: altyapiId, spaceRole: 'editor' },
        ],
      } as never,
    });
    providerId = provider.id;
    scim = new Client(app);
  }, 300_000);
  afterAll(async () => {
    await app?.close();
  });

  const member = async (email: string) =>
    (await owner.api.call('listMembers', { query: { q: email } as never })).items.find(
      (m) => m.user.email === email,
    );

  it('needs a token and the switch', async () => {
    expect((await scim.raw('GET', `${SCIM}/Users`)).status).toBe(401);
    const created = await owner.api.call('createScimToken', {
      body: { name: 'Entra provisioning', providerId },
    });
    tokenId = created.token.id;
    expect(created.secret.startsWith('mhscim_')).toBe(true);
    expect(created.token.hint).toBe(created.secret.slice(-4));
    scim.bearer = created.secret;
    // Off until an admin switches Entra on.
    expect((await scim.raw('GET', `${SCIM}/ServiceProviderConfig`)).status).toBe(403);
    const overview = await owner.api.call('updateMicrosoftIntegration', {
      params: { integration: 'entra' },
      body: { enabled: true },
    });
    expect(overview.switches.entra).toBe(true);
    expect(overview.entra.scimUrl).toBe('http://localhost:3000/api/scim/v2');
    const config = await scim.raw<{ patch: { supported: boolean } }>(
      'GET',
      `${SCIM}/ServiceProviderConfig`,
    );
    expect(config.status).toBe(200);
    expect(config.headers.get('content-type')).toContain('application/scim+json');
    expect(config.body.patch.supported).toBe(true);
  });

  it('creates a person the way Entra does: filter first, then POST', async () => {
    const none = await scim.raw<ScimList<ScimUser>>(
      'GET',
      `${SCIM}/Users?filter=${encodeURIComponent('userName eq "ayse@contoso.test"')}`,
    );
    expect(none.body.totalResults).toBe(0);
    const created = await scim.raw<ScimUser>('POST', `${SCIM}/Users`, {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      externalId: 'a1b2c3d4-0000-4000-8000-000000000001',
      userName: 'ayse@contoso.test',
      active: true,
      displayName: 'Ayşe Yıldız',
      emails: [{ primary: true, type: 'work', value: 'ayse@contoso.test' }],
      name: { formatted: 'Ayşe Yıldız', familyName: 'Yıldız', givenName: 'Ayşe' },
    });
    expect(created.status).toBe(201);
    expect(created.headers.get('location')).toBe(
      `http://localhost:3000${SCIM}/Users/${created.body.id}`,
    );
    ayseId = created.body.id;
    expect(created.body).toMatchObject({ userName: 'ayse@contoso.test', active: true });

    const m = await member('ayse@contoso.test');
    expect(m).toMatchObject({ role: 'member', status: 'active', user: { name: 'Ayşe Yıldız' } });

    const byExternal = await scim.raw<ScimList<ScimUser>>(
      'GET',
      `${SCIM}/Users?filter=${encodeURIComponent('externalId eq "a1b2c3d4-0000-4000-8000-000000000001"')}`,
    );
    expect(byExternal.body.Resources.map((u) => u.id)).toEqual([ayseId]);
    const dup = await scim.raw<{ scimType: string }>('POST', `${SCIM}/Users`, {
      userName: 'AYSE@contoso.test',
      emails: [{ value: 'other@contoso.test' }],
    });
    expect(dup.status).toBe(409);
    expect(dup.body.scimType).toBe('uniqueness');
  });

  it('matches an existing member by e-mail instead of creating a second account', async () => {
    const found = await scim.raw<ScimList<ScimUser>>(
      'GET',
      `${SCIM}/Users?filter=${encodeURIComponent(`userName eq "${SETUP_BODY.owner.email}"`)}`,
    );
    expect(found.body.totalResults).toBe(1);
    const ownerId = found.body.Resources[0]!.id;
    // Deactivating the org owner never locks the org out.
    const off = await scim.raw<ScimUser>('PATCH', `${SCIM}/Users/${ownerId}`, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'Replace', path: 'active', value: 'False' }],
    });
    expect(off.status).toBe(200);
    expect((await member(SETUP_BODY.owner.email))!.status).toBe('active');
    expect((await owner.api.call('me')).user.email).toBe(SETUP_BODY.owner.email);
  });

  it('maps pushed groups to the org role and space roles', async () => {
    const admins = await scim.raw<{ id: string }>('POST', `${SCIM}/Groups`, {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
      displayName: 'Crewhall Admins',
      externalId: '9e0a0000-0000-4000-8000-0000000000aa',
      members: [{ value: ayseId }],
    });
    expect(admins.status).toBe(201);
    expect((await member('ayse@contoso.test'))!.role).toBe('admin');

    const infra = await scim.raw<{ id: string }>('POST', `${SCIM}/Groups`, {
      displayName: 'Altyapı Ekibi',
      externalId: '9e0a0000-0000-4000-8000-0000000000bb',
      members: [],
    });
    const added = await scim.raw('PATCH', `${SCIM}/Groups/${infra.body.id}`, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'Add', path: 'members', value: [{ value: ayseId }] }],
    });
    expect(added.status).toBe(200);
    const spaceMembers = await owner.api.call('listSpaceMembers', {
      params: { spaceId: altyapiId },
    });
    expect(spaceMembers.items.find((m) => m.user.id === ayseId)?.role).toBe('editor');

    const user = await scim.raw<ScimUser>('GET', `${SCIM}/Users/${ayseId}`);
    expect(user.body.groups.map((g) => g.display).sort()).toEqual([
      'Altyapı Ekibi',
      'Crewhall Admins',
    ]);

    // Entra removes with a filtered path.
    await scim.raw('PATCH', `${SCIM}/Groups/${admins.body.id}`, {
      Operations: [{ op: 'Remove', path: `members[value eq "${ayseId}"]` }],
    });
    expect((await member('ayse@contoso.test'))!.role).toBe('member');

    const filtered = await scim.raw<ScimList<{ id: string; members?: unknown[] }>>(
      'GET',
      `${SCIM}/Groups?excludedAttributes=members&filter=${encodeURIComponent('displayName eq "altyapı ekibi"')}`,
    );
    expect(filtered.body.Resources).toHaveLength(1);
    expect(filtered.body.Resources[0]!.members).toBeUndefined();

    // Sign-in tokens carry object ids; SCIM knows their names.
    expect(
      (
        await expandGroupIds(app.deps.db, providerId, ['9e0a0000-0000-4000-8000-0000000000bb'])
      ).sort(),
    ).toEqual(['9e0a0000-0000-4000-8000-0000000000bb', 'Altyapı Ekibi']);
  });

  it('deactivates and reactivates, and DELETE keeps the person suspended', async () => {
    const patch = (ops: unknown[]) =>
      scim.raw<ScimUser>('PATCH', `${SCIM}/Users/${ayseId}`, {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: ops,
      });
    expect((await patch([{ op: 'Replace', path: 'active', value: 'False' }])).body.active).toBe(
      false,
    );
    expect((await member('ayse@contoso.test'))!.status).toBe('suspended');

    // Path-less value object, as Entra sends for several attributes at once.
    const back = await patch([
      { op: 'replace', value: { active: true, displayName: 'Ayşe Yıldız Kaya' } },
    ]);
    expect(back.body).toMatchObject({ active: true, displayName: 'Ayşe Yıldız Kaya' });
    expect((await member('ayse@contoso.test'))!.status).toBe('active');

    // An admin's suspension is not undone by the IdP.
    await owner.api.call('updateMember', {
      params: { userId: ayseId },
      body: { status: 'suspended' },
    });
    await patch([{ op: 'Replace', path: 'active', value: true }]);
    expect((await member('ayse@contoso.test'))!.status).toBe('suspended');
    await owner.api.call('updateMember', {
      params: { userId: ayseId },
      body: { status: 'active' },
    });

    expect((await scim.raw('DELETE', `${SCIM}/Users/${ayseId}`)).status).toBe(204);
    expect((await scim.raw('GET', `${SCIM}/Users/${ayseId}`)).status).toBe(404);
    expect((await member('ayse@contoso.test'))!.status).toBe('suspended');

    const overview = await owner.api.call('getMicrosoftIntegrations');
    expect(overview.entra.provisioned).toBeGreaterThanOrEqual(1);
    expect(overview.entra.deactivated).toBeGreaterThanOrEqual(1);
  });

  it('answers unsupported filters with a SCIM error and stops after revoke', async () => {
    const bad = await scim.raw<{ scimType: string; schemas: string[] }>(
      'GET',
      `${SCIM}/Users?filter=${encodeURIComponent('userName sw "a"')}`,
    );
    expect(bad.status).toBe(400);
    expect(bad.body.scimType).toBe('invalidFilter');
    await owner.api.call('revokeScimToken', { params: { tokenId } });
    expect((await scim.raw('GET', `${SCIM}/Users`)).status).toBe(401);
  });
});

describe('Entra sign-in details', () => {
  it('uses the object id as the subject and keeps sub as an earlier one', () => {
    const profile = profileFromClaims(
      { preset: 'entra' },
      {
        issuer: ENTRA_ISSUER,
        clientId: 'x',
        scopes: 'openid',
        groupsClaim: 'groups',
        prompt: null,
        endSessionOnLogout: false,
      },
      {
        sub: 'pairwise-sub',
        oid: 'object-id',
        preferred_username: 'can@contoso.test',
        groups: ['g1'],
      },
    );
    expect(profile).toMatchObject({
      subject: 'object-id',
      altSubjects: ['pairwise-sub'],
      email: 'can@contoso.test',
      emailVerified: true,
      groups: ['g1'],
    });
  });

  it('spots group overage and conditional access refusals', () => {
    expect(hasGroupOverage({ _claim_names: { groups: 'src1' } })).toBe(true);
    expect(hasGroupOverage({ hasgroups: true })).toBe(true);
    expect(hasGroupOverage({ groups: ['a'] })).toBe(false);
    expect(
      policyRefusal(
        'access_denied',
        'AADSTS53003: Access has been blocked by Conditional Access policies.',
      ),
    ).toBe(true);
    expect(policyRefusal('access_denied', 'AADSTS50105: not assigned to a role')).toBe(true);
    expect(policyRefusal('access_denied', 'AADSTS65004: User declined to consent')).toBe(false);
    expect(policyRefusal('interaction_required', undefined)).toBe(true);
  });
});
