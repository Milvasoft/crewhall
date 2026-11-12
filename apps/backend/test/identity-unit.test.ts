import { MODULE_KEYS } from '@crewhall/shared';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env';
import { decryptSecret, encryptSecret } from '../src/services/identity/crypto';
import { ipInRanges, isAdminArea } from '../src/services/identity/ip';
import { escapeFilterValue, fillFilter, guidToString } from '../src/services/identity/ldap';
import { disabledModuleOf, enabledModules } from '../src/services/identity/modules';
import { slugifyClientId, validRedirectUri } from '../src/services/identity/oidc-clients';
import { grantedScopes } from '../src/services/identity/oidc-provider';
import { groupMatches, resolveRoles } from '../src/services/identity/provision';
import { idpReportedMfa, profileFromClaims, safeWebTarget } from '../src/services/identity/sso';

const env = loadEnv({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://x',
  AUTH_SECRET: 'test-secret-0123456789abcdef0123456789',
  HUB_URL: 'https://hub.example.com',
  WEB_ORIGINS: 'http://localhost:4911',
});

const SPACE_1 = '00000000-0000-4000-8000-000000000001';
const SPACE_2 = '00000000-0000-4000-8000-000000000002';

describe('identity helpers', () => {
  it('escapes LDAP filter values (RFC 4515)', () => {
    expect(escapeFilterValue('a*b(c)\\d\0')).toBe('a\\2ab\\28c\\29\\5cd\\00');
    expect(fillFilter('(uid={username})', { username: '*)(uid=*' })).toBe(
      '(uid=\\2a\\29\\28uid=\\2a)',
    );
    expect(fillFilter('(uid={username})', { username: '*' }, true)).toBe('(uid=*)');
  });

  it('formats an AD objectGUID', () => {
    const buf = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    expect(guidToString(buf)).toBe('33221100-5544-7766-8899-aabbccddeeff');
  });

  it('matches groups by name and by the CN of a DN; the highest role wins', () => {
    expect(groupMatches('Developers', 'cn=developers,ou=groups,dc=x')).toBe(true);
    expect(groupMatches('developers', 'Developers')).toBe(true);
    expect(groupMatches('/it/admins', '/it/admins')).toBe(true);
    expect(groupMatches('dev', 'cn=developers,dc=x')).toBe(false);
    const roles = resolveRoles(
      [
        { group: 'staff', orgRole: 'member' },
        { group: 'admins', orgRole: 'admin' },
        { group: 'staff', spaceId: SPACE_1, spaceRole: 'viewer' },
        { group: 'admins', spaceId: SPACE_1, spaceRole: 'admin' },
        { group: 'ops', spaceId: SPACE_2, spaceRole: 'editor' },
      ],
      ['staff', 'admins'],
    );
    expect(roles.orgRole).toBe('admin');
    expect([...roles.spaces]).toEqual([[SPACE_1, 'admin']]);
    expect([...roles.managedSpaces]).toHaveLength(2);
  });

  it('reads IdP MFA from amr and acr', () => {
    expect(idpReportedMfa({ amr: ['pwd', 'mfa'] })).toBe(true);
    expect(idpReportedMfa({ amr: ['pwd', 'otp'] })).toBe(true);
    expect(idpReportedMfa({ amr: ['pwd'] })).toBe(false);
    expect(
      idpReportedMfa({ acr: 'http://schemas.openid.net/pape/policies/2007/06/multi-factor' }),
    ).toBe(true);
    expect(idpReportedMfa({ acr: '1' })).toBe(false);
  });

  it('maps OIDC claims, Entra without email_verified and nested group claims', () => {
    const cfg = {
      issuer: 'https://x',
      clientId: 'c',
      scopes: 'openid',
      groupsClaim: 'realm_access.roles',
      prompt: null,
      endSessionOnLogout: false,
    };
    const p = profileFromClaims({ preset: 'keycloak' }, cfg, {
      sub: 's1',
      email: 'A@X.TEST',
      email_verified: true,
      given_name: 'Ayşe',
      family_name: 'Y',
      realm_access: { roles: ['ops'] },
    });
    expect(p).toMatchObject({
      subject: 's1',
      email: 'a@x.test',
      emailVerified: true,
      name: 'Ayşe Y',
      groups: ['ops'],
    });
    const entra = profileFromClaims(
      { preset: 'entra' },
      { ...cfg, groupsClaim: 'groups' },
      { sub: 's2', preferred_username: 'b@corp.test', name: 'B', groups: 'single' },
    );
    expect(entra).toMatchObject({ email: 'b@corp.test', emailVerified: true, groups: ['single'] });
  });

  it('allows only web-app targets after SSO', () => {
    expect(safeWebTarget(env, '/mobil-giris?x=1', '/')).toBe(
      'https://hub.example.com/mobil-giris?x=1',
    );
    expect(safeWebTarget(env, 'http://localhost:4911/a', '/')).toBe('http://localhost:4911/a');
    expect(safeWebTarget(env, 'https://evil.example.com/', '/')).toBe('https://hub.example.com/');
    expect(safeWebTarget(env, '//evil.example.com/', '/login')).toBe(
      'https://hub.example.com/login',
    );
  });

  it('validates OIDC redirect URIs, client ids and scopes', () => {
    expect(validRedirectUri('https://app.example.com/cb', 'web')).toBe(true);
    expect(validRedirectUri('http://localhost:5000/cb', 'web')).toBe(true);
    expect(validRedirectUri('http://app.example.com/cb', 'web')).toBe(false);
    expect(validRedirectUri('https://*.example.com/cb', 'web')).toBe(false);
    expect(validRedirectUri('https://app.example.com/cb#x', 'web')).toBe(false);
    expect(validRedirectUri('com.example.app:/callback', 'native')).toBe(true);
    expect(validRedirectUri('com.example.app:/callback', 'web')).toBe(false);
    expect(validRedirectUri('javascript:alert(1)', 'native')).toBe(false);
    expect(slugifyClientId('Dumpapp Scheduler')).toBe('dumpapp-scheduler');
    expect(slugifyClientId('Şirket İçi Panel')).toBe('sirket-ici-panel');
    expect(grantedScopes({ scopes: ['openid', 'email'] }, 'openid email profile foo')).toEqual([
      'openid',
      'email',
    ]);
  });

  it('matches IP ranges and the admin area', () => {
    const ranges = [{ cidr: '85.105.12.0/24' }, { cidr: '2001:db8::/32' }, { cidr: '10.0.0.1' }];
    expect(ipInRanges('85.105.12.44', ranges)).toBe(true);
    expect(ipInRanges('::ffff:85.105.12.44', ranges)).toBe(true);
    expect(ipInRanges('2001:db8::1', ranges)).toBe(true);
    expect(ipInRanges('10.0.0.2', ranges)).toBe(false);
    expect(ipInRanges(null, ranges)).toBe(false);
    expect(isAdminArea('GET', '/api/v1/org')).toBe(false);
    expect(isAdminArea('PATCH', '/api/v1/org')).toBe(true);
    expect(isAdminArea('GET', '/api/v1/org/members')).toBe(true);
    expect(isAdminArea('GET', '/api/v1/identity/oidc/consent')).toBe(false);
    expect(isAdminArea('GET', '/api/v1/identity/oidc')).toBe(true);
  });

  it('encrypts stored secrets and lists enabled modules', () => {
    const enc = encryptSecret(env.AUTH_SECRET, 'bind-pass');
    expect(enc).not.toContain('bind-pass');
    expect(decryptSecret(env.AUTH_SECRET, enc)).toBe('bind-pass');
    expect(() => decryptSecret('another-secret-0123456789abcdefghijklmn', enc)).toThrow();
    expect(enabledModules({ modules: { meet: false } })).not.toContain('meet');
    expect(enabledModules(undefined)).toHaveLength(MODULE_KEYS.length);
    // The realtime gateway carries core events too: its ticket is never blocked.
    expect(disabledModuleOf('createWsTicket', { modules: { chat: false } })).toBeNull();
    expect(disabledModuleOf('sendMessage', { modules: { chat: false } })).toBe('chat');
  });
});
