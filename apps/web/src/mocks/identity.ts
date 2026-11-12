import {
  moduleOn,
  AUTH_LOCK,
  MODULE_KEYS,
  MODULE_OF_ENDPOINT,
  OIDC_SCOPES,
  type EndpointName,
  type IdentityProvider,
  type IdpSyncSummary,
  type IdpTestResult,
  type LdapConfig,
  type LinkedIdentity,
  type ModuleKey,
  type OidcClient,
  type OidcIdpConfig,
  type OidcProviderSettings,
  type OidcScope,
  type SecurityPolicy,
  type SpaceRole,
} from '@crewhall/shared';
import { delay, http, HttpResponse, type HttpHandler } from 'msw';
import { ipInRanges } from '@/lib/identity/ip';
import { AD_USER_FILTER } from '@/lib/identity/providers';
import { memberOf, MockApiError, randomToken, requireUser, type Resolvers } from './core';
import { db, newId, save } from './db';
import { MOCK_PASSWORD, type MockState, type MockUser } from './seed';

/**
 * Identity module part of the contract mock (design 9.11-9.14): external identity providers,
 * the security policy, Crewhall as an OIDC provider and its consent screen, plus the
 * better-auth additions (LDAP sign-in, SSO start, sign-in policy) as raw MSW handlers.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();
/** The address the mock "sees" for the signed-in admin (same as the seed sessions). */
export const MOCK_CURRENT_IP = '85.105.12.44';

type StoredProvider = Omit<
  IdentityProvider,
  'hasSecret' | 'callbackUrl' | 'spMetadataUrl' | 'spEntityId'
> & {
  secret: string | null;
};
type StoredClient = Omit<OidcClient, 'access' | 'lastLoginUser'> & {
  access: { kind: 'all' } | { kind: 'space'; spaceId: string };
  lastLoginUserId: string | null;
  secret: string | null;
};

interface IdentityMockState {
  providers: StoredProvider[];
  linked: (LinkedIdentity & { providerId: string; username: string })[];
  policy: Omit<SecurityPolicy, 'twoFactor'> & {
    twoFactor: Omit<SecurityPolicy['twoFactor'], 'required'>;
  };
  verifiedAt: number;
  oidc: {
    settings: OidcProviderSettings;
    signingKey: { kid: string; alg: string; createdAt: string };
    clients: StoredClient[];
  };
  consentTokens: string[];
  grants: string[];
  /** Provider of the current session when it came from SSO (RP-initiated logout). */
  sessionProvider: string | null;
}

function domainOf(email: string): string {
  return email.split('@')[1] ?? 'example.com';
}

function seed(s: MockState): IdentityMockState {
  const byEmail = (local: string) => s.users.find((u) => u.email.startsWith(`${local}@`));
  const shared = s.spaces.filter((x) => x.kind === 'shared' && !x.archivedAt);
  const infra = shared[1] ?? shared[0];
  const product = shared[2] ?? shared[0];
  const keycloakId = newId();
  const adId = newId();
  const link = (
    providerId: string,
    local: string,
    groups: string[],
    lastLogin: number | null,
    directoryStatus: LinkedIdentity['directoryStatus'] = 'active',
  ) => {
    const u = byEmail(local);
    if (!u) return [];
    return [
      {
        providerId,
        username: local,
        userId: u.id,
        name: u.name,
        email: u.email,
        subject: providerId === adId ? `{${newId()}}` : newId(),
        groups,
        directoryStatus,
        memberStatus: memberOf(s, u.id)?.status ?? null,
        lastLoginAt: lastLogin === null ? null : ago(lastLogin),
        createdAt: ago(90 * DAY),
      },
    ];
  };
  const adGroup = (cn: string) => `CN=${cn},OU=Groups,DC=corp,DC=example,DC=com`;
  const linked = [
    ...link(keycloakId, 'mert', ['crewhall-admins', 'altyapi'], 2 * HOUR),
    ...link(keycloakId, 'zeynep', ['altyapi'], 3 * DAY),
    ...link(adId, 'elif', [adGroup('Crewhall-Users'), adGroup('Urun')], 40 * MIN),
    ...link(adId, 'can', [adGroup('Crewhall-Users')], 5 * DAY),
    ...link(adId, 'burak', [adGroup('Crewhall-Users')], 12 * DAY, 'disabled'),
  ];
  const count = (id: string) => linked.filter((l) => l.providerId === id).length;
  const keycloakConfig: OidcIdpConfig = {
    issuer: 'https://sso.example.com/realms/crewhall',
    clientId: 'crewhall',
    scopes: 'openid email profile',
    groupsClaim: 'groups',
    prompt: null,
    endSessionOnLogout: true,
  };
  const adConfig: LdapConfig = {
    url: 'ldaps://dc01.corp.example.com:636',
    startTls: false,
    caCert: null,
    tlsVerify: true,
    bindDn: 'CN=svc-crewhall,OU=Service,DC=corp,DC=example,DC=com',
    baseDn: 'OU=Users,DC=corp,DC=example,DC=com',
    userFilter: AD_USER_FILTER,
    emailAttribute: 'mail',
    nameAttribute: 'displayName',
    uidAttribute: 'objectGUID',
    useMemberOf: true,
    groupBaseDn: '',
    groupFilter: '(&(objectClass=groupOfNames)(member={dn}))',
    groupNameAttribute: 'cn',
    activeDirectory: true,
    timeoutMs: 8000,
  };
  const common = {
    enabled: true,
    enforceSso: false,
    jitProvisioning: true,
    defaultRole: 'member' as const,
    linkExistingByEmail: true,
    trustIdpMfa: false,
    syncRoles: true,
    createdAt: ago(120 * DAY),
    updatedAt: ago(9 * DAY),
  };
  const providers: StoredProvider[] = [
    {
      ...common,
      id: keycloakId,
      kind: 'oidc',
      preset: 'keycloak',
      name: 'Keycloak',
      // Partner accounts; the org's own domain keeps the password sign-in in the demo.
      domains: ['partner.example.com'],
      enforceSso: true,
      trustIdpMfa: true,
      syncEnabled: false,
      roleMappings: [
        { group: 'crewhall-admins', orgRole: 'admin', spaceId: null, spaceRole: null },
        ...(infra
          ? [{ group: 'altyapi', orgRole: null, spaceId: infra.id, spaceRole: 'editor' as const }]
          : []),
      ],
      config: keycloakConfig,
      secret: 'kc-secret',
      status: {
        linkedUsers: count(keycloakId),
        lastLoginAt: ago(2 * HOUR),
        lastTestAt: ago(3 * DAY),
        lastTestOk: true,
        lastError: null,
        lastSyncAt: null,
        lastSyncOk: null,
        lastSync: null,
      },
    },
    {
      ...common,
      id: adId,
      kind: 'ldap',
      preset: 'active_directory',
      name: 'Active Directory',
      domains: [],
      syncEnabled: true,
      roleMappings: [
        { group: adGroup('Crewhall-Users'), orgRole: 'member', spaceId: null, spaceRole: null },
        ...(product
          ? [
              {
                group: adGroup('Urun'),
                orgRole: null,
                spaceId: product.id,
                spaceRole: 'editor' as const,
              },
            ]
          : []),
      ],
      config: adConfig,
      secret: 'bind-secret',
      status: {
        linkedUsers: count(adId),
        lastLoginAt: ago(40 * MIN),
        lastTestAt: ago(DAY),
        lastTestOk: true,
        lastError: null,
        lastSyncAt: ago(38 * MIN),
        lastSyncOk: true,
        lastSync: { checked: 3, updated: 1, suspended: 1, reactivated: 0 },
      },
    },
  ];
  const user = (local: string) => byEmail(local)?.id ?? null;
  const client = (
    c: Partial<StoredClient> & Pick<StoredClient, 'clientId' | 'name'>,
  ): StoredClient => ({
    id: newId(),
    type: 'web',
    homepageUrl: null,
    logoUrl: null,
    redirectUris: [],
    postLogoutRedirectUris: [],
    scopes: ['openid', 'profile', 'email'],
    skipConsent: true,
    access: { kind: 'all' },
    guestsAllowed: false,
    enabled: true,
    secretHint: 'Wq3a',
    secretExpiresAt: ahead(240 * DAY),
    lastLoginAt: null,
    lastLoginUserId: null,
    logins7d: 0,
    createdAt: ago(200 * DAY),
    secret: `mhs_${randomToken(18)}`,
    ...c,
  });
  return {
    providers,
    linked,
    policy: {
      twoFactor: { passkeyEnabled: true, rememberDevice: false },
      password: { localLogin: true, minLength: 12, breachCheck: true },
      session: { hours: 12, rememberDays: 30 },
      ipAllowlist: {
        enabled: false,
        scope: 'admin',
        ranges: [
          { cidr: '85.105.12.0/24', label: 'Ofis' },
          { cidr: '10.8.0.0/16', label: 'WireGuard VPN' },
        ],
      },
    },
    verifiedAt: 0,
    oidc: {
      settings: { skipConsentForInternal: true, guestsAllowed: false },
      signingKey: { kid: 'k-2026-09', alg: 'RS256', createdAt: ago(41 * DAY) },
      clients: [
        client({
          clientId: 'ops-panel',
          name: 'Operasyon Paneli',
          homepageUrl: 'https://ops.example.com',
          redirectUris: ['https://ops.example.com/signin-oidc'],
          postLogoutRedirectUris: ['https://ops.example.com/signout-callback-oidc'],
          scopes: ['openid', 'profile', 'email', 'groups'],
          lastLoginAt: ago(4 * MIN),
          lastLoginUserId: user('zeynep'),
          logins7d: 142,
        }),
        client({
          clientId: 'helpdesk',
          name: 'Destek Masası',
          homepageUrl: 'https://helpdesk.example.io',
          redirectUris: ['https://helpdesk.example.io/auth/callback'],
          access: product ? { kind: 'space', spaceId: product.id } : { kind: 'all' },
          skipConsent: false,
          lastLoginAt: ago(16 * HOUR),
          lastLoginUserId: user('elif'),
          logins7d: 37,
        }),
        client({
          clientId: 'log-viewer-test',
          name: 'Log İzleme (Test)',
          homepageUrl: 'https://logs.test.example.com',
          redirectUris: [
            'https://logs.test.example.com/signin-oidc',
            'http://localhost:5341/signin-oidc',
          ],
          access: infra ? { kind: 'space', spaceId: infra.id } : { kind: 'all' },
          secretExpiresAt: ahead(12 * DAY),
          lastLoginAt: ago(3 * DAY),
          lastLoginUserId: user('mert'),
          logins7d: 9,
        }),
      ],
    },
    consentTokens: [],
    grants: [],
    sessionProvider: null,
  };
}

/** The identity part of the mock db, seeded on first use (tests read it directly). */
export function identityMockState(s: MockState = db()): IdentityMockState {
  const holder = s as MockState & { identity?: IdentityMockState };
  holder.identity ??= seed(s);
  return holder.identity;
}

// ---- module switches and bootstrap (used by contract.ts) ----

/** Enabled modules of the org for `Me.modules`. */
export function enabledModulesOf(s: MockState): ModuleKey[] {
  // Same rule as the server: drawings follow boards until they have their own switch.
  return MODULE_KEYS.filter((k) => moduleOn(s.org?.settings, k));
}

/** 403 module_disabled for endpoints of a module the org turned off. */
export function assertModuleEnabled(s: MockState, name: EndpointName): void {
  const mod = MODULE_OF_ENDPOINT[name];
  if (mod && !enabledModulesOf(s).includes(mod)) throw new MockApiError('module_disabled');
}

/** Identity fields of `bootstrap.auth`. */
export function identityBootstrapAuth(s: MockState) {
  if (!s.org) return {};
  const m = identityMockState(s);
  const enabled = m.providers.filter((p) => p.enabled);
  const ldap = enabled.find((p) => p.kind === 'ldap');
  return {
    passkey: m.policy.twoFactor.passkeyEnabled,
    password: m.policy.password.localLogin,
    ldap: ldap ? { label: `${ldap.name} hesabı` } : null,
    sso: enabled
      .filter((p) => p.kind !== 'ldap')
      .map((p) => ({ id: p.id, name: p.name, kind: p.kind as 'oidc' | 'saml' })),
  };
}

// ---- helpers ----

function requireAdmin(s: MockState): MockUser {
  const u = requireUser(s);
  const role = memberOf(s, u.id)?.role;
  if (role !== 'owner' && role !== 'admin') throw new MockApiError('forbidden');
  return u;
}

const fresh = (m: IdentityMockState) => Date.now() - m.verifiedAt < 10 * MIN;

function apiOrigin(request: Request): string {
  return new URL(request.url).origin;
}

function toProvider(request: Request, p: StoredProvider): IdentityProvider {
  const origin = apiOrigin(request);
  const { secret, ...rest } = p;
  return {
    ...rest,
    hasSecret: Boolean(secret),
    callbackUrl:
      p.kind === 'oidc'
        ? `${origin}/api/identity/sso/${p.id}/callback`
        : p.kind === 'saml'
          ? `${origin}/api/identity/saml/${p.id}/acs`
          : null,
    spMetadataUrl: p.kind === 'saml' ? `${origin}/api/identity/saml/${p.id}/metadata` : null,
    spEntityId: p.kind === 'saml' ? `${origin}/api/identity/saml/${p.id}` : null,
  };
}

function findProvider(m: IdentityMockState, id: string | undefined): StoredProvider {
  const p = m.providers.find((x) => x.id === id);
  if (!p) throw new MockApiError('not_found');
  return p;
}

function toClient(s: MockState, c: StoredClient): OidcClient {
  const rest: Partial<StoredClient> = { ...c };
  delete rest.secret;
  delete rest.lastLoginUserId;
  const { access } = c;
  const lastUser = s.users.find((u) => u.id === c.lastLoginUserId);
  return {
    ...(rest as Omit<StoredClient, 'secret' | 'lastLoginUserId' | 'access'>),
    access:
      access.kind === 'all'
        ? access
        : {
            kind: 'space',
            spaceId: access.spaceId,
            spaceName: s.spaces.find((x) => x.id === access.spaceId)?.name ?? '?',
          },
    lastLoginUser: lastUser ? { id: lastUser.id, name: lastUser.name } : null,
  };
}

function providerInfo(s: MockState, request: Request) {
  const m = identityMockState(s);
  const issuer = apiOrigin(request);
  return {
    issuer,
    discoveryUrl: `${issuer}/.well-known/openid-configuration`,
    jwksUrl: `${issuer}/api/oidc/jwks`,
    signingKey: m.oidc.signingKey,
    settings: m.oidc.settings,
    clients: m.oidc.clients.map((c) => toClient(s, c)),
  };
}

function findClient(m: IdentityMockState, id: string | undefined): StoredClient {
  const c = m.oidc.clients.find((x) => x.id === id);
  if (!c) throw new MockApiError('not_found');
  return c;
}

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

function checkRedirectUris(uris: string[]) {
  for (const uri of uris) {
    let u: URL;
    try {
      u = new URL(uri);
    } catch {
      throw new MockApiError('oidc_redirect_uri_invalid');
    }
    if (uri.includes('*') || (u.protocol === 'http:' && !LOOPBACK.includes(u.hostname))) {
      throw new MockApiError('oidc_redirect_uri_invalid');
    }
  }
}

function slug(name: string): string {
  const base = name
    .toLocaleLowerCase('tr')
    .replace(/[çğıöşü]/g, (ch) => ({ ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u' })[ch] ?? ch)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base.length >= 2 ? base : `app-${randomToken(3).toLowerCase()}`;
}

/** What the role mappings give a person with these groups (test result preview). */
function mapped(p: Pick<StoredProvider, 'roleMappings' | 'defaultRole'>, groups: string[]) {
  const rank = { guest: 0, member: 1, admin: 2 } as const;
  let orgRole: 'admin' | 'member' | 'guest' | null = null;
  const spaces: { spaceId: string; role: SpaceRole }[] = [];
  for (const m of p.roleMappings) {
    if (!groups.some((g) => g.toLowerCase() === m.group.toLowerCase())) continue;
    if (m.orgRole && (orgRole === null || rank[m.orgRole] > rank[orgRole])) orgRole = m.orgRole;
    if (m.spaceId) spaces.push({ spaceId: m.spaceId, role: m.spaceRole ?? 'viewer' });
  }
  return { orgRole: orgRole ?? p.defaultRole, spaces };
}

function startMockSession(s: MockState, u: MockUser) {
  const now = new Date().toISOString();
  const id = newId();
  s.sessions.push({
    id,
    userId: u.id,
    userAgent: typeof navigator === 'undefined' ? null : navigator.userAgent.slice(0, 120),
    ip: MOCK_CURRENT_IP,
    createdAt: now,
    lastActiveAt: now,
  });
  s.auth.sessionId = id;
  s.auth.pending2faUserId = null;
  s.auth.lastEmail = u.email;
  return id;
}

function userJson(u: MockUser) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    emailVerified: true,
    image: u.imageUrl,
    twoFactorEnabled: u.twoFactorEnabled,
    createdAt: '2024-03-12T09:00:00.000Z',
    updatedAt: new Date().toISOString(),
  };
}

// ---- resolvers ----

type IdentityName = Extract<
  EndpointName,
  | 'discoverSignIn'
  | 'getSsoLogoutTarget'
  | 'listIdentityProviders'
  | 'getIdentityProvider'
  | 'createIdentityProvider'
  | 'updateIdentityProvider'
  | 'deleteIdentityProvider'
  | 'testIdentityProvider'
  | 'syncIdentityProvider'
  | 'listLinkedIdentities'
  | 'getSecurityPolicy'
  | 'updateSecurityPolicy'
  | 'identityReauth'
  | 'getOidcProvider'
  | 'updateOidcProviderSettings'
  | 'rotateOidcSigningKey'
  | 'createOidcClient'
  | 'updateOidcClient'
  | 'deleteOidcClient'
  | 'rotateOidcClientSecret'
  | 'getOidcConsent'
  | 'approveOidcConsent'
  | 'denyOidcConsent'
>;

function securityView(s: MockState) {
  const m = identityMockState(s);
  const active = s.members.filter((x) => x.status === 'active');
  const users = active
    .map((x) => s.users.find((u) => u.id === x.userId))
    .filter((u): u is MockUser => Boolean(u));
  const enrolled = users.filter((u) => u.twoFactorEnabled || u.passkeys.length > 0);
  return {
    policy: {
      ...m.policy,
      twoFactor: { ...m.policy.twoFactor, required: Boolean(s.org?.settings.requireTwoFactor) },
    },
    status: {
      twoFactor: {
        enrolled: enrolled.length,
        total: users.length,
        pending: users
          .filter((u) => !enrolled.includes(u))
          .map((u) => ({ userId: u.id, name: u.name, email: u.email })),
      },
      currentIp: MOCK_CURRENT_IP,
      lockout: { attempts: AUTH_LOCK.maxFailures, minutes: AUTH_LOCK.lockMinutes[0] },
      needsReauth: !fresh(m),
    },
  };
}

function runTest(
  s: MockState,
  p: Pick<StoredProvider, 'kind' | 'config' | 'roleMappings' | 'defaultRole' | 'secret'>,
  username: string | undefined,
): IdpTestResult {
  const steps: IdpTestResult['steps'] = [];
  const step = (key: string, ok: boolean, detail: string | null, ms: number) => {
    steps.push({ key, ok, detail, ms });
    return ok;
  };
  if (p.kind === 'oidc') {
    const c = p.config as OidcIdpConfig;
    const reachable = !/invalid|unreachable/.test(c.issuer);
    step(
      'discovery',
      reachable,
      reachable
        ? `${c.issuer}/.well-known/openid-configuration`
        : `getaddrinfo ENOTFOUND ${new URL(c.issuer).host}`,
      reachable ? 84 : 3012,
    );
    if (reachable) step('jwks', true, '2 RSA', 41);
    return { ok: steps.every((x) => x.ok), steps, user: null };
  }
  if (p.kind === 'saml') {
    step('metadata', true, null, 12);
    step('certificate', true, 'RSA 2048 · 2027-06-30', 3);
    return { ok: true, steps, user: null };
  }
  const c = p.config as LdapConfig;
  const host = c.url.replace(/^ldaps?:\/\//i, '');
  if (!step('connect', !/invalid|unreachable/.test(host), host, 23)) {
    return { ok: false, steps, user: null };
  }
  if (c.url.startsWith('ldaps') || c.startTls) step('tls', true, 'TLS 1.3', 18);
  const bound = !c.bindDn || Boolean(p.secret);
  if (!step('bind', bound, bound ? c.bindDn || null : '49 invalidCredentials', 31)) {
    return { ok: false, steps, user: null };
  }
  step('search', true, c.baseDn, 46);
  let user: IdpTestResult['user'] = null;
  if (username) {
    const m = identityMockState(s);
    const local = username.split('@')[0]?.toLowerCase() ?? '';
    const entry = m.linked.find((l) => l.username === local);
    const u = s.users.find((x) => x.email.split('@')[0] === local);
    if (!step('user', Boolean(u), u ? null : username, 19) || !u) {
      return { ok: false, steps, user: null };
    }
    const groups = entry?.groups ?? [`CN=Crewhall-Users,OU=Groups,DC=corp,DC=example,DC=com`];
    const result = mapped(p, groups);
    user = {
      dn: `CN=${u.name},${c.baseDn}`,
      email: u.email,
      name: u.name,
      uid: entry?.subject ?? `{${u.id}}`,
      groups,
      disabled: entry?.directoryStatus === 'disabled',
      orgRole: result.orgRole,
      spaces: result.spaces,
    };
  }
  return { ok: steps.every((x) => x.ok), steps, user };
}

export const identityResolvers: Resolvers<IdentityName> = {
  discoverSignIn: ({ s, body }) => {
    const m = identityMockState(s);
    const domain = domainOf(body.email.toLowerCase());
    const enabled = m.providers.filter((p) => p.enabled && p.domains.includes(domain));
    const sso = enabled.find((p) => p.kind !== 'ldap' && p.enforceSso);
    return {
      method: sso ? 'sso' : 'password',
      provider: sso ? { id: sso.id, name: sso.name, kind: sso.kind as 'oidc' | 'saml' } : null,
      ldap: enabled.some((p) => p.kind === 'ldap'),
    };
  },

  getSsoLogoutTarget: ({ s, query }) => {
    requireUser(s);
    const m = identityMockState(s);
    const p = m.providers.find((x) => x.id === m.sessionProvider);
    if (!p || p.kind !== 'oidc' || !(p.config as OidcIdpConfig).endSessionOnLogout) {
      return { url: null };
    }
    const c = p.config as OidcIdpConfig;
    const url = new URL(`${c.issuer}/protocol/openid-connect/logout`);
    if (query.postLogoutUrl) url.searchParams.set('post_logout_redirect_uri', query.postLogoutUrl);
    url.searchParams.set('client_id', c.clientId);
    m.sessionProvider = null;
    return { url: url.toString() };
  },

  listIdentityProviders: ({ s, request }) => {
    requireAdmin(s);
    return { items: identityMockState(s).providers.map((p) => toProvider(request, p)) };
  },

  getIdentityProvider: ({ s, params, request }) => {
    requireAdmin(s);
    return toProvider(request, findProvider(identityMockState(s), params.providerId));
  },

  createIdentityProvider: ({ s, body, request }) => {
    requireAdmin(s);
    const m = identityMockState(s);
    const now = new Date().toISOString();
    const { kind, config, ...rest } = body;
    const secret =
      body.kind === 'oidc'
        ? (body.clientSecret ?? null)
        : body.kind === 'ldap'
          ? (body.bindPassword ?? null)
          : null;
    const p: StoredProvider = {
      id: newId(),
      kind,
      preset: rest.preset,
      name: rest.name,
      enabled: rest.enabled,
      domains: rest.domains,
      enforceSso: rest.enforceSso,
      jitProvisioning: rest.jitProvisioning,
      defaultRole: rest.defaultRole,
      linkExistingByEmail: rest.linkExistingByEmail,
      trustIdpMfa: rest.trustIdpMfa,
      syncRoles: rest.syncRoles,
      syncEnabled: body.kind === 'ldap' ? body.syncEnabled : false,
      roleMappings: rest.roleMappings,
      config,
      secret,
      status: {
        linkedUsers: 0,
        lastLoginAt: null,
        lastTestAt: null,
        lastTestOk: null,
        lastError: null,
        lastSyncAt: null,
        lastSyncOk: null,
        lastSync: null,
      },
      createdAt: now,
      updatedAt: now,
    };
    m.providers.push(p);
    return toProvider(request, p);
  },

  updateIdentityProvider: ({ s, params, body, request }) => {
    requireAdmin(s);
    const m = identityMockState(s);
    const p = findProvider(m, params.providerId);
    const { clientSecret, bindPassword, config, ...rest } = body;
    for (const [k, v] of Object.entries(rest)) {
      if (v !== undefined) (p as Record<string, unknown>)[k] = v;
    }
    if (config) {
      const kindOf = 'issuer' in config ? 'oidc' : 'entryPoint' in config ? 'saml' : 'ldap';
      if (kindOf !== p.kind) throw new MockApiError('idp_kind_mismatch');
      p.config = config;
    }
    if (clientSecret && p.kind === 'oidc') p.secret = clientSecret;
    if (bindPassword && p.kind === 'ldap') p.secret = bindPassword;
    p.updatedAt = new Date().toISOString();
    return toProvider(request, p);
  },

  deleteIdentityProvider: ({ s, params }) => {
    requireAdmin(s);
    const m = identityMockState(s);
    findProvider(m, params.providerId);
    m.providers = m.providers.filter((p) => p.id !== params.providerId);
    m.linked = m.linked.filter((l) => l.providerId !== params.providerId);
    return {};
  },

  testIdentityProvider: ({ s, body }) => {
    requireAdmin(s);
    const m = identityMockState(s);
    const saved = body.providerId ? findProvider(m, body.providerId) : null;
    const draft = body.draft;
    const source = draft
      ? {
          kind: draft.kind,
          config: draft.config,
          roleMappings: draft.roleMappings,
          defaultRole: draft.defaultRole,
          secret:
            (draft.kind === 'oidc'
              ? draft.clientSecret
              : draft.kind === 'ldap'
                ? draft.bindPassword
                : null) ??
            saved?.secret ??
            null,
        }
      : saved!;
    if (saved && draft && saved.kind !== draft.kind) throw new MockApiError('idp_kind_mismatch');
    const result = runTest(s, source, body.username);
    if (saved) {
      saved.status.lastTestAt = new Date().toISOString();
      saved.status.lastTestOk = result.ok;
      const failed = result.steps.find((x) => !x.ok);
      saved.status.lastError = failed ? (failed.detail ?? failed.key) : null;
    }
    return result;
  },

  syncIdentityProvider: ({ s, params }) => {
    requireAdmin(s);
    const m = identityMockState(s);
    const p = findProvider(m, params.providerId);
    if (p.kind !== 'ldap') throw new MockApiError('idp_kind_mismatch');
    const linked = m.linked.filter((l) => l.providerId === p.id);
    const summary: IdpSyncSummary = {
      checked: linked.length,
      updated: 0,
      suspended: linked.filter((l) => l.directoryStatus !== 'active' && l.memberStatus === 'active')
        .length,
      reactivated: 0,
    };
    for (const l of linked) {
      if (l.directoryStatus !== 'active') {
        const member = memberOf(s, l.userId);
        if (member && member.status === 'active') member.status = 'suspended';
        l.memberStatus = 'suspended';
      }
    }
    p.status.lastSyncAt = new Date().toISOString();
    p.status.lastSyncOk = true;
    p.status.lastSync = summary;
    return summary;
  },

  listLinkedIdentities: ({ s, params, query }) => {
    requireAdmin(s);
    const m = identityMockState(s);
    findProvider(m, params.providerId);
    const all = m.linked
      .filter((l) => l.providerId === params.providerId)
      .map(({ providerId: _p, username: _u, ...rest }) => rest);
    const start = query.cursor ? Number(query.cursor) || 0 : 0;
    const items = all.slice(start, start + query.limit);
    return {
      items,
      nextCursor: start + query.limit < all.length ? String(start + query.limit) : null,
    };
  },

  getSecurityPolicy: ({ s }) => {
    requireAdmin(s);
    return securityView(s);
  },

  updateSecurityPolicy: ({ s, body }) => {
    requireAdmin(s);
    const m = identityMockState(s);
    if (!fresh(m)) throw new MockApiError('identity_reauth_required');
    const next = {
      twoFactor: { ...m.policy.twoFactor, ...body.twoFactor },
      password: { ...m.policy.password, ...body.password },
      session: { ...m.policy.session, ...body.session },
      ipAllowlist: { ...m.policy.ipAllowlist, ...body.ipAllowlist },
    };
    if (next.ipAllowlist.enabled && !ipInRanges(MOCK_CURRENT_IP, next.ipAllowlist.ranges)) {
      throw new MockApiError('ip_allowlist_self_lockout');
    }
    const { required, ...twoFactor } = next.twoFactor as SecurityPolicy['twoFactor'];
    m.policy = { ...next, twoFactor };
    if (required !== undefined && s.org) s.org.settings.requireTwoFactor = required;
    return securityView(s);
  },

  identityReauth: ({ s, body }) => {
    const u = requireUser(s);
    if (body.password !== u.password) throw new MockApiError('identity_password_invalid');
    const m = identityMockState(s);
    m.verifiedAt = Date.now();
    return { verifiedUntil: new Date(m.verifiedAt + 10 * MIN).toISOString() };
  },

  getOidcProvider: ({ s, request }) => {
    requireAdmin(s);
    return providerInfo(s, request);
  },

  updateOidcProviderSettings: ({ s, body, request }) => {
    requireAdmin(s);
    const m = identityMockState(s);
    m.oidc.settings = { ...m.oidc.settings, ...body };
    return providerInfo(s, request);
  },

  rotateOidcSigningKey: ({ s, request }) => {
    requireAdmin(s);
    const m = identityMockState(s);
    m.oidc.signingKey = {
      kid: `k-${randomToken(4)}`,
      alg: 'RS256',
      createdAt: new Date().toISOString(),
    };
    return providerInfo(s, request);
  },

  createOidcClient: ({ s, body }) => {
    requireAdmin(s);
    const m = identityMockState(s);
    checkRedirectUris([...body.redirectUris, ...body.postLogoutRedirectUris]);
    const clientId = body.clientId ?? slug(body.name);
    if (m.oidc.clients.some((c) => c.clientId === clientId)) {
      throw new MockApiError('oidc_client_id_taken');
    }
    const confidential = body.type === 'web';
    const secret = confidential ? `mhs_${randomToken(18)}` : null;
    const c: StoredClient = {
      id: newId(),
      clientId,
      name: body.name,
      type: body.type,
      homepageUrl: body.homepageUrl,
      logoUrl: body.logoUrl,
      redirectUris: body.redirectUris,
      postLogoutRedirectUris: body.postLogoutRedirectUris,
      scopes: OIDC_SCOPES.filter((x) => x === 'openid' || body.scopes.includes(x)),
      skipConsent: body.skipConsent,
      access: body.access,
      guestsAllowed: body.guestsAllowed,
      enabled: true,
      secretHint: secret ? secret.slice(-4) : null,
      secretExpiresAt: secret ? ahead(body.secretMonths * 30 * DAY) : null,
      lastLoginAt: null,
      lastLoginUserId: null,
      logins7d: 0,
      createdAt: new Date().toISOString(),
      secret,
    };
    m.oidc.clients.push(c);
    return { client: toClient(s, c), clientSecret: secret };
  },

  updateOidcClient: ({ s, params, body }) => {
    requireAdmin(s);
    const m = identityMockState(s);
    const c = findClient(m, params.oidcClientId);
    if (body.redirectUris || body.postLogoutRedirectUris) {
      checkRedirectUris([...(body.redirectUris ?? []), ...(body.postLogoutRedirectUris ?? [])]);
    }
    for (const [k, v] of Object.entries(body)) {
      if (v !== undefined) (c as Record<string, unknown>)[k] = v;
    }
    if (body.scopes) {
      c.scopes = OIDC_SCOPES.filter((x) => x === 'openid' || body.scopes!.includes(x));
    }
    return toClient(s, c);
  },

  deleteOidcClient: ({ s, params }) => {
    requireAdmin(s);
    const m = identityMockState(s);
    findClient(m, params.oidcClientId);
    m.oidc.clients = m.oidc.clients.filter((c) => c.id !== params.oidcClientId);
    return {};
  },

  rotateOidcClientSecret: ({ s, params }) => {
    requireAdmin(s);
    const m = identityMockState(s);
    if (!fresh(m)) throw new MockApiError('identity_reauth_required');
    const c = findClient(m, params.oidcClientId);
    if (c.type !== 'web') throw new MockApiError('bad_request');
    c.secret = `mhs_${randomToken(18)}`;
    c.secretHint = c.secret.slice(-4);
    c.secretExpiresAt = ahead(365 * DAY);
    return { clientSecret: c.secret, expiresAt: c.secretExpiresAt };
  },

  getOidcConsent: ({ s, query }) => {
    const u = requireUser(s);
    const m = identityMockState(s);
    const c = m.oidc.clients.find((x) => x.clientId === query.client_id && x.enabled);
    if (!c || !c.redirectUris.includes(query.redirect_uri) || query.response_type !== 'code') {
      throw new MockApiError('oidc_consent_invalid');
    }
    const member = memberOf(s, u.id);
    if (!member || member.status !== 'active') throw new MockApiError('oidc_access_denied');
    if (member.role === 'guest' && !(c.guestsAllowed && m.oidc.settings.guestsAllowed)) {
      throw new MockApiError('oidc_access_denied');
    }
    if (
      c.access.kind === 'space' &&
      !s.spaceMembers.some(
        (x) => x.spaceId === (c.access as { spaceId: string }).spaceId && x.userId === u.id,
      )
    ) {
      throw new MockApiError('oidc_access_denied');
    }
    const requested = query.scope.split(/\s+/).filter(Boolean);
    const scopes = OIDC_SCOPES.filter(
      (x) => x === 'openid' || (requested.includes(x) && c.scopes.includes(x as OidcScope)),
    );
    const token = randomToken();
    m.consentTokens.push(token);
    const host = (() => {
      try {
        return new URL(query.redirect_uri).host;
      } catch {
        return query.redirect_uri;
      }
    })();
    return {
      client: {
        name: c.name,
        clientId: c.clientId,
        logoUrl: c.logoUrl,
        homepageUrl: c.homepageUrl,
        redirectHost: host,
      },
      user: { name: u.name, email: u.email, orgName: s.org?.name ?? '' },
      scopes: scopes.map((scope) => ({ scope, required: scope === 'openid' })),
      autoApprove:
        (m.oidc.settings.skipConsentForInternal && c.skipConsent) ||
        m.grants.includes(`${u.id}:${c.clientId}`),
      consentToken: token,
    };
  },

  approveOidcConsent: ({ s, body }) => {
    const u = requireUser(s);
    const m = identityMockState(s);
    if (!m.consentTokens.includes(body.consentToken)) {
      throw new MockApiError('oidc_consent_invalid');
    }
    m.consentTokens = m.consentTokens.filter((x) => x !== body.consentToken);
    m.grants.push(`${u.id}:${body.client_id}`);
    const c = m.oidc.clients.find((x) => x.clientId === body.client_id);
    if (c) {
      c.lastLoginAt = new Date().toISOString();
      c.lastLoginUserId = u.id;
      c.logins7d += 1;
    }
    const url = new URL(body.redirect_uri);
    url.searchParams.set('code', randomToken());
    if (body.state) url.searchParams.set('state', body.state);
    return { redirectTo: url.toString() };
  },

  denyOidcConsent: ({ s, body }) => {
    requireUser(s);
    const m = identityMockState(s);
    if (!m.consentTokens.includes(body.consentToken)) {
      throw new MockApiError('oidc_consent_invalid');
    }
    m.consentTokens = m.consentTokens.filter((x) => x !== body.consentToken);
    const url = new URL(body.redirect_uri);
    url.searchParams.set('error', 'access_denied');
    if (body.state) url.searchParams.set('state', body.state);
    return { redirectTo: url.toString() };
  },
};

// ---- better-auth additions and browser redirects (raw MSW handlers) ----

// No artificial delay under Vitest; the browser mock feels like a network.
let latency = import.meta.env.MODE === 'test' ? 0 : 300;
export function setIdentityLatency(ms: number): void {
  latency = ms;
}

function authError(status: number, code: string, message: string, extra?: Record<string, unknown>) {
  return HttpResponse.json({ code, message, ...(extra ?? {}) }, { status });
}

/** Owners keep the local password ("acil durum girişi") whatever the policy says. */
function isOwner(s: MockState, u: MockUser | undefined): boolean {
  return Boolean(u && memberOf(s, u.id)?.role === 'owner');
}

export const identityAuthHandlers: HttpHandler[] = [
  // Sign-in policy in front of the e-mail sign-in; falls through to the normal handler.
  http.post('*/api/auth/sign-in/email', async ({ request }) => {
    const s = db();
    if (!s.org) return undefined;
    const b = (await request
      .clone()
      .json()
      .catch(() => ({}))) as { email?: string };
    const email = String(b.email ?? '').toLowerCase();
    const u = s.users.find((x) => x.email === email);
    if (isOwner(s, u)) return undefined;
    const m = identityMockState(s);
    const sso = m.providers.find(
      (p) => p.enabled && p.kind !== 'ldap' && p.enforceSso && p.domains.includes(domainOf(email)),
    );
    if (sso) {
      if (latency) await delay(latency);
      return authError(403, 'SSO_REQUIRED', 'SSO required', { providerId: sso.id });
    }
    if (!m.policy.password.localLogin) {
      if (latency) await delay(latency);
      return authError(403, 'PASSWORD_LOGIN_DISABLED', 'Password sign-in is disabled');
    }
    return undefined;
  }),

  // Directory sign-in: the directory name (local part) or the e-mail, directory password.
  http.post('*/api/auth/sign-in/ldap', async ({ request }) => {
    if (latency) await delay(latency);
    const s = db();
    const m = identityMockState(s);
    const ldap = m.providers.find((p) => p.enabled && p.kind === 'ldap');
    if (!ldap) return authError(403, 'LDAP_DISABLED', 'No directory');
    const b = (await request.json().catch(() => ({}))) as { username?: string; password?: string };
    const name = String(b.username ?? '')
      .trim()
      .toLowerCase();
    const local = name.includes('@') ? name.split('@')[0] : name;
    const entry = m.linked.find((l) => l.providerId === ldap.id && l.username === local);
    const u = entry ? s.users.find((x) => x.id === entry.userId) : undefined;
    if (!u || b.password !== MOCK_PASSWORD || entry?.directoryStatus !== 'active') {
      return authError(401, 'INVALID_EMAIL_OR_PASSWORD', 'Invalid username or password');
    }
    ldap.status.lastLoginAt = new Date().toISOString();
    if (entry) entry.lastLoginAt = ldap.status.lastLoginAt;
    if (u.twoFactorEnabled) {
      s.auth.pending2faUserId = u.id;
      s.auth.lastEmail = u.email;
      save();
      return HttpResponse.json({ twoFactorRedirect: true, twoFactorMethods: ['totp'] });
    }
    const token = startMockSession(s, u);
    save();
    return HttpResponse.json({ redirect: false, token, user: userJson(u) });
  }),

  // SSO start: in the mock there is no IdP; the first linked person (else the owner) signs in.
  http.get('*/api/identity/sso/:providerId/start', async ({ request, params }) => {
    if (latency) await delay(latency);
    const s = db();
    const m = identityMockState(s);
    const url = new URL(request.url);
    const callback = url.searchParams.get('callbackURL') ?? '/';
    const errorUrl = url.searchParams.get('errorCallbackURL') ?? '/login';
    const p = m.providers.find((x) => x.id === params.providerId && x.enabled);
    const fail = (code: string) => {
      const target = new URL(errorUrl, url.origin);
      target.searchParams.set('ssoError', code);
      return HttpResponse.json({ location: target.pathname + target.search });
    };
    if (!p || p.kind === 'ldap') return fail('sso_login_failed');
    const entry = m.linked.find((l) => l.providerId === p.id);
    const u = s.users.find((x) => x.id === (entry?.userId ?? s.users[0]?.id));
    if (!u) return fail('sso_account_not_linked');
    startMockSession(s, u);
    m.sessionProvider = p.id;
    p.status.lastLoginAt = new Date().toISOString();
    save();
    return HttpResponse.json({ location: callback });
  }),
];
