import {
  DEFAULT_SECURITY_POLICY,
  IDENTITY_RAW_PATHS,
  MODULE_KEYS,
  type OrgSettings,
} from '@crewhall/shared';
import { describe, expect, it } from 'vitest';
import { ipInCidr, ipInRanges, isValidCidr } from '@/lib/identity/ip';
import {
  countModuleChanges,
  enabledModules,
  isModuleEnabled,
  isNodeTypeEnabled,
  moduleForPath,
  RAIL_MODULE_KEY,
  withModule,
} from '@/lib/identity/modules';
import {
  emptyClientForm,
  formToCreate as clientToCreate,
  formToUpdate as clientToUpdate,
  redirectUriProblem,
  secretState,
} from '@/lib/identity/oidcClients';
import {
  AD_USER_FILTER,
  cleanMappings,
  formForPreset,
  formToCreate,
  formToUpdate,
  missingFields,
  normalizeDomain,
  OPENLDAP_USER_FILTER,
  providerHealth,
} from '@/lib/identity/providers';
import { countPolicyChanges, ipMode, policyPatch, withIpMode } from '@/lib/identity/security';
import { loginPath, ssoErrorCode, ssoStartUrl } from '@/lib/identity/sso';
import { MODULES } from '@/lib/modules';

describe('module switches', () => {
  it('maps every rail entry; drive is core', () => {
    for (const m of MODULES) expect(m.id in RAIL_MODULE_KEY).toBe(true);
    expect(RAIL_MODULE_KEY.drive).toBeNull();
    expect(RAIL_MODULE_KEY.pages).toBe('wiki');
    expect(RAIL_MODULE_KEY.drawings).toBe('drawings');
    expect(RAIL_MODULE_KEY.boards).toBe('boards');
  });

  it('finds the module of a route', () => {
    expect(moduleForPath('/chat')).toBe('chat');
    expect(moduleForPath('/pages/urun')).toBe('wiki');
    expect(moduleForPath('/drawings/')).toBe('drawings');
    expect(moduleForPath('/d/123')).toBe('drawings');
    expect(moduleForPath('/b/123')).toBe('boards');
    // A page's own address belongs to the pages module too: off means off there as well.
    expect(moduleForPath('/p/onboarding-123')).toBe('wiki');
    expect(moduleForPath('/people/123')).toBeNull();
    expect(moduleForPath('/account/mcp/activity')).toBe('mcp');
    expect(moduleForPath('/account/approvals/123')).toBe('mcp');
    expect(moduleForPath('/admin/mcp')).toBe('mcp');
    expect(moduleForPath('/portal')).toBe('portal');
    expect(moduleForPath('/drive/milvasoft')).toBeNull();
    expect(moduleForPath('/account/security')).toBeNull();
    expect(moduleForPath('/chatbot')).toBeNull();
  });

  it('treats a missing list as all on', () => {
    expect(isModuleEnabled(undefined, 'vault')).toBe(true);
    expect(isModuleEnabled({}, 'vault')).toBe(true);
    expect(isModuleEnabled({ modules: ['chat'] }, 'vault')).toBe(false);
    expect(isModuleEnabled({ modules: [] }, null)).toBe(true);
    expect([...enabledModules({})]).toEqual([...MODULE_KEYS]);
  });

  it('maps Drive node types to their module', () => {
    const me = { modules: ['chat' as const] };
    expect(isNodeTypeEnabled(me, 'folder')).toBe(true);
    expect(isNodeTypeEnabled(me, 'file')).toBe(true);
    expect(isNodeTypeEnabled(me, 'page')).toBe(false);
    expect(isNodeTypeEnabled(me, 'board')).toBe(false);
    expect(isNodeTypeEnabled(me, 'drawing')).toBe(false);
    expect(isNodeTypeEnabled({ modules: ['wiki'] }, 'page')).toBe(true);
    expect(isNodeTypeEnabled(undefined, 'board')).toBe(true);
  });

  it('counts switch changes and keeps the full map', () => {
    const base: OrgSettings = {
      requireTwoFactor: false,
      defaultLocale: 'tr',
      membersCanCreateSpaces: false,
      publicLinksEnabled: true,
    };
    const off = withModule(base, 'vault', false);
    expect(off.modules).toEqual(Object.fromEntries(MODULE_KEYS.map((k) => [k, k !== 'vault'])));
    expect(countModuleChanges(base, off)).toBe(1);
    expect(countModuleChanges(base, withModule(off, 'vault', true))).toBe(0);
  });
});

describe('IP allowlist', () => {
  it('matches IPv4 and IPv6 ranges', () => {
    expect(ipInCidr('85.105.12.44', '85.105.12.0/24')).toBe(true);
    expect(ipInCidr('85.105.13.1', '85.105.12.0/24')).toBe(false);
    expect(ipInCidr('10.8.200.3', '10.8.0.0/16')).toBe(true);
    expect(ipInCidr('10.8.0.1', '10.8.0.1')).toBe(true);
    expect(ipInCidr('0.0.0.0', '0.0.0.0/0')).toBe(true);
    expect(ipInCidr('2001:db8::1', '2001:db8::/32')).toBe(true);
    expect(ipInCidr('2001:db9::1', '2001:db8::/32')).toBe(false);
    expect(ipInCidr('::ffff:10.8.0.5', '10.8.0.0/16')).toBe(true);
    expect(ipInCidr('10.8.0.5', '2001:db8::/32')).toBe(false);
    expect(ipInRanges('85.105.12.44', [{ cidr: '10.0.0.0/8' }, { cidr: '85.105.12.0/24' }])).toBe(
      true,
    );
  });

  it('validates addresses and prefixes', () => {
    expect(isValidCidr('203.0.113.0/24')).toBe(true);
    expect(isValidCidr('203.0.113.7')).toBe(true);
    expect(isValidCidr('203.0.113.0/33')).toBe(false);
    expect(isValidCidr('300.1.1.1')).toBe(false);
    expect(isValidCidr('fe80::1/64')).toBe(true);
    expect(isValidCidr('fe80::1/129')).toBe(false);
    expect(isValidCidr('ofis')).toBe(false);
  });
});

describe('security policy draft', () => {
  it('sends only changed fields, grouped by section', () => {
    const base = DEFAULT_SECURITY_POLICY;
    const draft = {
      ...base,
      password: { ...base.password, minLength: 14 },
      ipAllowlist: withIpMode(
        { ...base.ipAllowlist, ranges: [{ cidr: '10.0.0.0/8', label: 'VPN' }] },
        'all',
      ),
    };
    expect(countPolicyChanges(base, draft)).toBe(4);
    expect(policyPatch(base, draft)).toEqual({
      password: { minLength: 14 },
      ipAllowlist: { enabled: true, scope: 'all', ranges: [{ cidr: '10.0.0.0/8', label: 'VPN' }] },
    });
    expect(policyPatch(base, base)).toEqual({});
  });

  it('maps the IP segmented control', () => {
    expect(ipMode({ enabled: false, scope: 'all', ranges: [] })).toBe('off');
    expect(ipMode({ enabled: true, scope: 'admin', ranges: [] })).toBe('admin');
    expect(withIpMode({ enabled: true, scope: 'admin', ranges: [] }, 'off').enabled).toBe(false);
  });
});

describe('OIDC clients', () => {
  it('checks redirect URIs like the server', () => {
    expect(redirectUriProblem('https://app.example.com/cb', 'web')).toBeNull();
    expect(redirectUriProblem('http://localhost:5341/cb', 'web')).toBeNull();
    expect(redirectUriProblem('http://app.example.com/cb', 'web')).toBe('http');
    expect(redirectUriProblem('https://*.example.com/cb', 'web')).toBe('wildcard');
    expect(redirectUriProblem('https://app.example.com/cb#x', 'spa')).toBe('fragment');
    expect(redirectUriProblem('com.example.app:/oauth', 'native')).toBeNull();
    expect(redirectUriProblem('com.example.app:/oauth', 'web')).toBe('invalid');
    expect(redirectUriProblem('not a url', 'web')).toBe('invalid');
  });

  it('maps the form to the contract', () => {
    const form = {
      ...emptyClientForm(),
      name: ' Destek Masası ',
      scopes: ['email' as const],
      access: 'space-1',
      redirectUris: ['https://helpdesk.example.io/cb'],
    };
    expect(clientToCreate(form)).toMatchObject({
      name: 'Destek Masası',
      scopes: ['openid', 'email'],
      access: { kind: 'space', spaceId: 'space-1' },
      homepageUrl: null,
      secretMonths: 12,
    });
    expect(clientToCreate({ ...form, type: 'spa' })).not.toHaveProperty('secretMonths');
    expect(clientToUpdate({ ...form, access: 'all' }).access).toEqual({ kind: 'all' });
  });

  it('warns 30 days before the secret expires', () => {
    const now = Date.parse('2026-10-20T00:00:00Z');
    const at = (days: number) => new Date(now + days * 86_400_000).toISOString();
    expect(secretState({ secretExpiresAt: null }, now)).toEqual({ kind: 'none' });
    expect(secretState({ secretExpiresAt: at(120) }, now)).toEqual({ kind: 'ok' });
    expect(secretState({ secretExpiresAt: at(12) }, now)).toEqual({ kind: 'expiring', days: 12 });
    expect(secretState({ secretExpiresAt: at(-1) }, now)).toEqual({ kind: 'expired' });
  });
});

describe('identity provider presets', () => {
  it('prefills directory defaults', () => {
    const ad = formForPreset('active_directory');
    expect(ad.kind).toBe('ldap');
    expect(ad.ldap).toMatchObject({
      uidAttribute: 'objectGUID',
      activeDirectory: true,
      userFilter: AD_USER_FILTER,
      useMemberOf: true,
    });
    const openldap = formForPreset('openldap');
    expect(openldap.ldap).toMatchObject({
      uidAttribute: 'entryUUID',
      userFilter: OPENLDAP_USER_FILTER,
      useMemberOf: false,
      groupFilter: '(&(objectClass=groupOfNames)(member={dn}))',
    });
    expect(formForPreset('google').oidc.issuer).toBe('https://accounts.google.com');
    expect(formForPreset('entra').oidc.groupsClaim).toBe('groups');
    expect(formForPreset('saml').kind).toBe('saml');
  });

  it('maps the form to create and update bodies', () => {
    const f = {
      ...formForPreset('keycloak'),
      oidc: {
        ...formForPreset('keycloak').oidc,
        issuer: ' https://sso.example.com/realms/x ',
        clientId: 'crewhall',
      },
      secret: 's3cret',
      domains: ['example.com'],
      enforceSso: true,
      roleMappings: [
        { group: ' admins ', orgRole: 'admin' as const },
        { group: '', orgRole: 'member' as const },
        { group: 'ops', orgRole: null, spaceId: 'sp-1', spaceRole: null },
      ],
    };
    const create = formToCreate(f);
    expect(create).toMatchObject({
      kind: 'oidc',
      preset: 'keycloak',
      clientSecret: 's3cret',
      config: { issuer: 'https://sso.example.com/realms/x', prompt: null },
      roleMappings: [
        { group: 'admins', orgRole: 'admin', spaceId: null, spaceRole: null },
        { group: 'ops', orgRole: null, spaceId: 'sp-1', spaceRole: 'viewer' },
      ],
    });
    const update = formToUpdate({ ...f, secret: '' });
    expect(update).not.toHaveProperty('kind');
    expect(update).not.toHaveProperty('preset');
    expect(update).not.toHaveProperty('clientSecret');
    expect(update.enforceSso).toBe(true);

    const ldap = formToCreate({
      ...formForPreset('active_directory'),
      secret: 'bind',
      enforceSso: true,
    });
    expect(ldap).toMatchObject({ kind: 'ldap', bindPassword: 'bind', enforceSso: false });
  });

  it('lists missing required fields', () => {
    expect(missingFields(formForPreset('keycloak'), false)).toEqual([
      'issuer',
      'clientId',
      'clientSecret',
    ]);
    expect(missingFields(formForPreset('keycloak'), true)).not.toContain('clientSecret');
    expect(missingFields(formForPreset('active_directory'), false)).toEqual(['url', 'baseDn']);
    expect(cleanMappings([{ group: ' ', orgRole: 'admin' }])).toEqual([]);
  });

  it('normalizes domains and derives card health', () => {
    expect(normalizeDomain('@Example.COM ')).toBe('example.com');
    expect(normalizeDomain('localhost')).toBeNull();
    const status = {
      linkedUsers: 0,
      lastLoginAt: null,
      lastTestAt: null,
      lastTestOk: null,
      lastError: null,
      lastSyncAt: null,
      lastSyncOk: null,
      lastSync: null,
    };
    expect(providerHealth({ enabled: true, status })).toBe('untested');
    expect(providerHealth({ enabled: true, status: { ...status, lastTestOk: false } })).toBe(
      'error',
    );
    expect(providerHealth({ enabled: false, status: { ...status, lastTestOk: false } })).toBe(
      'off',
    );
    expect(providerHealth({ enabled: true, status: { ...status, linkedUsers: 3 } })).toBe(
      'connected',
    );
  });
});

describe('SSO start URL', () => {
  it('keeps relative targets on the same origin', () => {
    const url = new URL(
      ssoStartUrl(
        'p1',
        {
          callbackPath: '/mobile-login?redirect_uri=crewhall%3A%2F%2Fauth',
          errorPath: loginPath('/x'),
        },
        'http://hub.local:4110',
        'http://hub.local:4110',
      ),
    );
    expect(url.pathname).toBe(IDENTITY_RAW_PATHS.ssoStart('p1'));
    expect(url.searchParams.get('callbackURL')).toBe(
      '/mobile-login?redirect_uri=crewhall%3A%2F%2Fauth',
    );
    expect(url.searchParams.get('errorCallbackURL')).toBe('/login?redirect=%2Fx');
  });

  it('sends absolute targets when the api is on another origin', () => {
    const url = new URL(
      ssoStartUrl(
        'p1',
        { callbackPath: '/', errorPath: '/login', loginHint: 'a@example.com' },
        'https://api.example.com',
        'https://hub.example.com',
      ),
    );
    expect(url.origin).toBe('https://api.example.com');
    expect(url.searchParams.get('callbackURL')).toBe('https://hub.example.com/');
    expect(url.searchParams.get('errorCallbackURL')).toBe('https://hub.example.com/login');
    expect(url.searchParams.get('loginHint')).toBe('a@example.com');
  });

  it('maps unknown SSO error codes to the generic failure', () => {
    expect(ssoErrorCode(undefined)).toBeNull();
    expect(ssoErrorCode('sso_email_conflict')).toBe('sso_email_conflict');
    expect(ssoErrorCode('weird')).toBe('sso_login_failed');
  });
});
