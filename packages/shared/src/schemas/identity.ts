import { z } from 'zod';
import { Id, Timestamp } from './common';
import { OrgRole } from './org';
import { SpaceRole } from './space';

/*
 * Identity module (design 9.11-9.14, doc 17 §2 OIDC, §4 oidc_clients): external sign-in
 * (OIDC / SAML SSO, Active Directory / LDAP), Crewhall as an OpenID Connect provider for
 * other apps, and the org security policy. Owned by the platform session.
 */

// ---------------------------------------------------------------------------------------
// Paths outside the contract table (browser redirects and standards endpoints)
// ---------------------------------------------------------------------------------------

/**
 * Raw routes of the identity module. All of them live on the api origin (behind Caddy the
 * same origin as the web app). Clients build them from the api base URL.
 */
export const IDENTITY_RAW_PATHS = {
  /**
   * GET, browser navigation: starts SSO with an external IdP. Query: `callbackURL` (a path on
   * the web app such as `/` or `/mobile-login?…`, or an absolute URL on a trusted web origin),
   * optional `errorCallbackURL` (defaults to `/login`), optional `loginHint` (e-mail).
   * Ends with a session cookie and a redirect to `callbackURL`; on failure redirects to
   * `errorCallbackURL?ssoError=<error code>`.
   */
  ssoStart: (providerId: string) => `/api/identity/sso/${providerId}/start`,
  /** OIDC redirect URI to register at the IdP. */
  ssoCallback: (providerId: string) => `/api/identity/sso/${providerId}/callback`,
  /** SAML Assertion Consumer Service (HTTP-POST binding). */
  samlAcs: (providerId: string) => `/api/identity/saml/${providerId}/acs`,
  /** SAML service provider metadata XML for the IdP administrator. */
  samlMetadata: (providerId: string) => `/api/identity/saml/${providerId}/metadata`,
  /**
   * POST, better-auth endpoint (`/api/auth/sign-in/ldap`). Body `{ username, password,
   * rememberMe? }`; `username` may be the directory user name (sAMAccountName / uid) or the
   * e-mail. Answers exactly like `/api/auth/sign-in/email`: `{ redirect, token, user }` with
   * the session cookie (and `set-auth-token` for bearer clients), `{ twoFactorRedirect: true }`
   * when the account has local TOTP, 401 `INVALID_EMAIL_OR_PASSWORD` with `remainingAttempts`,
   * 423 `ACCOUNT_LOCKED` (AuthFailureBody), 403 `LDAP_DISABLED` when no directory is enabled.
   */
  ldapSignIn: '/api/auth/sign-in/ldap',
  /** OpenID Connect discovery of Crewhall as a provider; issuer = api origin. */
  oidcDiscovery: '/.well-known/openid-configuration',
  oidcAuthorize: '/api/oidc/authorize',
  oidcToken: '/api/oidc/token',
  oidcUserinfo: '/api/oidc/userinfo',
  oidcJwks: '/api/oidc/jwks',
  oidcEndSession: '/api/oidc/logout',
  oidcRevoke: '/api/oidc/revoke',
} as const;

/** Web route of the OIDC consent page (01 layout); `/api/oidc/authorize` forwards its query here. */
export const OIDC_CONSENT_WEB_PATH = '/sso/consent';

// ---------------------------------------------------------------------------------------
// Sign-in discovery (login screen: "e-posta yazınca alan adı SSO zorunluysa yönlendirme")
// ---------------------------------------------------------------------------------------

export const SignInDiscoveryRequest = z.object({ email: z.string().trim().min(3).max(320) });
export type SignInDiscoveryRequest = z.infer<typeof SignInDiscoveryRequest>;

export const SignInDiscovery = z.object({
  /**
   * password: continue with the password field (local or directory, see `ldap`).
   * sso: this e-mail domain must sign in through `provider`; redirect there.
   */
  method: z.enum(['password', 'sso']),
  provider: z.object({ id: Id, name: z.string(), kind: z.enum(['oidc', 'saml']) }).nullable(),
  /** The domain is mapped to a directory: the password is the directory password. */
  ldap: z.boolean(),
});
export type SignInDiscovery = z.infer<typeof SignInDiscovery>;

// ---------------------------------------------------------------------------------------
// External identity providers (inbound): OIDC, SAML 2.0, Active Directory / LDAP
// ---------------------------------------------------------------------------------------

export const IdpKind = z.enum(['oidc', 'saml', 'ldap']);
export type IdpKind = z.infer<typeof IdpKind>;

/** Presets only fill defaults in the form; the server treats them as labels. */
export const IdpPreset = z.enum([
  'keycloak',
  'entra',
  'google',
  'okta',
  'oidc',
  'saml',
  'active_directory',
  'openldap',
]);
export type IdpPreset = z.infer<typeof IdpPreset>;

/** IdP group (claim value, SAML attribute value or LDAP group CN/DN) → org role and/or space. */
export const IdpRoleMapping = z
  .object({
    group: z.string().trim().min(1).max(500),
    /** Highest mapped role wins; owner can never be granted from a directory. */
    orgRole: z.enum(['admin', 'member', 'guest']).nullable().optional(),
    spaceId: Id.nullable().optional(),
    spaceRole: SpaceRole.exclude(['owner']).nullable().optional(),
  })
  .refine((m) => m.orgRole || m.spaceId, { message: 'orgRole or spaceId required' });
export type IdpRoleMapping = z.infer<typeof IdpRoleMapping>;

export const OidcIdpConfig = z.object({
  /** Issuer URL; discovery is `<issuer>/.well-known/openid-configuration`. */
  issuer: z.url().max(500),
  clientId: z.string().trim().min(1).max(300),
  scopes: z.string().trim().max(500).default('openid email profile'),
  /** Claim holding group names (Keycloak `groups`, Entra `groups`/`roles`). */
  groupsClaim: z.string().trim().max(100).default('groups'),
  /** Optional `prompt` sent to the IdP. */
  prompt: z.enum(['login', 'select_account', 'consent']).nullable().default(null),
  /** Sign out of the IdP too when the person signs out of Crewhall (RP-initiated logout). */
  endSessionOnLogout: z.boolean().default(false),
});
export type OidcIdpConfig = z.infer<typeof OidcIdpConfig>;

export const SamlIdpConfig = z.object({
  /** IdP single sign-on URL (HTTP-Redirect binding). */
  entryPoint: z.url().max(1000),
  /** IdP entity ID (Issuer of the responses). */
  idpIssuer: z.string().trim().min(1).max(500),
  /** IdP signing certificate(s), PEM or bare base64; several separated by blank lines. */
  idpCert: z.string().trim().min(20).max(20000),
  /** Attribute names; NameID is used when the e-mail attribute is missing. */
  emailAttribute: z.string().trim().max(200).default('email'),
  nameAttribute: z.string().trim().max(200).default('name'),
  groupsAttribute: z.string().trim().max(200).default('groups'),
  /** IdP single logout URL; when set and endSessionOnLogout, sign-out goes there too. */
  logoutUrl: z.url().max(1000).nullable().default(null),
  endSessionOnLogout: z.boolean().default(false),
});
export type SamlIdpConfig = z.infer<typeof SamlIdpConfig>;

export const LdapConfig = z.object({
  /** `ldap://host:389` or `ldaps://host:636`. */
  url: z
    .string()
    .trim()
    .regex(/^ldaps?:\/\/[^\s/]+(:\d+)?\/?$/i, 'ldap://host[:port] or ldaps://host[:port]'),
  startTls: z.boolean().default(false),
  /** PEM CA certificate for ldaps / StartTLS with an internal CA; null = system trust store. */
  caCert: z.string().trim().max(20000).nullable().default(null),
  /** Verify the server certificate (turn off only for testing). */
  tlsVerify: z.boolean().default(true),
  /** Service account used to search; empty = anonymous bind. */
  bindDn: z.string().trim().max(500).default(''),
  baseDn: z.string().trim().min(1).max(500),
  /**
   * Search filter for the typed name; `{username}` is replaced (escaped).
   * AD: `(&(objectClass=user)(|(sAMAccountName={username})(userPrincipalName={username})(mail={username})))`
   */
  userFilter: z.string().trim().min(3).max(1000),
  emailAttribute: z.string().trim().max(100).default('mail'),
  nameAttribute: z.string().trim().max(100).default('displayName'),
  /** Stable unique id: `objectGUID` (AD) or `entryUUID` (OpenLDAP). */
  uidAttribute: z.string().trim().max(100).default('objectGUID'),
  /** Groups from the user's `memberOf` attribute (AD, OpenLDAP memberof overlay). */
  useMemberOf: z.boolean().default(true),
  /** Otherwise a group search; `{dn}` and `{username}` are replaced. */
  groupBaseDn: z.string().trim().max(500).default(''),
  groupFilter: z.string().trim().max(1000).default('(&(objectClass=groupOfNames)(member={dn}))'),
  groupNameAttribute: z.string().trim().max(100).default('cn'),
  /** Active Directory: treat `userAccountControl` bit 2 (ACCOUNTDISABLE) as disabled. */
  activeDirectory: z.boolean().default(false),
  timeoutMs: z.number().int().min(1000).max(60000).default(8000),
});
export type LdapConfig = z.infer<typeof LdapConfig>;

/** Fields shared by every kind. */
const IdpCommon = z.object({
  name: z.string().trim().min(1).max(80),
  preset: IdpPreset,
  enabled: z.boolean().default(true),
  /** E-mail domains (without @) whose people use this provider. */
  domains: z
    .array(
      z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/),
    )
    .max(50)
    .default([]),
  /**
   * People of `domains` must use this provider: local password sign-in is refused for them.
   * Org owners keep the local password ("acil durum girişi") regardless.
   */
  enforceSso: z.boolean().default(false),
  /** Create the Crewhall account on first sign-in (JIT); otherwise an invitation must exist. */
  jitProvisioning: z.boolean().default(true),
  /** Org role for JIT accounts that match no mapping. */
  defaultRole: z.enum(['member', 'guest']).default('member'),
  /** An account with the same e-mail is linked on first sign-in (verified IdP e-mail only). */
  linkExistingByEmail: z.boolean().default(true),
  /** IdP MFA (amr/acr) satisfies the org 2FA policy; local TOTP is then not asked. */
  trustIdpMfa: z.boolean().default(false),
  /** Re-apply role mappings on every sign-in / directory sync (otherwise only at creation). */
  syncRoles: z.boolean().default(true),
  roleMappings: z.array(IdpRoleMapping).max(200).default([]),
});

export const CreateIdentityProvider = z.discriminatedUnion('kind', [
  IdpCommon.extend({
    kind: z.literal('oidc'),
    config: OidcIdpConfig,
    clientSecret: z.string().max(2000).optional(),
  }),
  IdpCommon.extend({ kind: z.literal('saml'), config: SamlIdpConfig }),
  IdpCommon.extend({
    kind: z.literal('ldap'),
    config: LdapConfig,
    bindPassword: z.string().max(2000).optional(),
    /** Hourly directory sync: suspends people removed or disabled in the directory. */
    syncEnabled: z.boolean().default(true),
  }),
]);
export type CreateIdentityProvider = z.infer<typeof CreateIdentityProvider>;
export type CreateIdentityProviderInput = z.input<typeof CreateIdentityProvider>;

/** Partial update; `config` replaces the stored config of the same kind as a whole. Secrets: omit = keep. */
export const UpdateIdentityProvider = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  enabled: z.boolean().optional(),
  domains: IdpCommon.shape.domains.optional(),
  enforceSso: z.boolean().optional(),
  jitProvisioning: z.boolean().optional(),
  defaultRole: z.enum(['member', 'guest']).optional(),
  linkExistingByEmail: z.boolean().optional(),
  trustIdpMfa: z.boolean().optional(),
  syncRoles: z.boolean().optional(),
  roleMappings: z.array(IdpRoleMapping).max(200).optional(),
  syncEnabled: z.boolean().optional(),
  config: z.union([OidcIdpConfig, SamlIdpConfig, LdapConfig]).optional(),
  clientSecret: z.string().max(2000).optional(),
  bindPassword: z.string().max(2000).optional(),
});
export type UpdateIdentityProvider = z.infer<typeof UpdateIdentityProvider>;

export const IdpSyncSummary = z.object({
  checked: z.number().int(),
  updated: z.number().int(),
  suspended: z.number().int(),
  reactivated: z.number().int(),
});
export type IdpSyncSummary = z.infer<typeof IdpSyncSummary>;

export const IdentityProvider = z.object({
  id: Id,
  kind: IdpKind,
  preset: IdpPreset,
  name: z.string(),
  enabled: z.boolean(),
  domains: z.array(z.string()),
  enforceSso: z.boolean(),
  jitProvisioning: z.boolean(),
  defaultRole: z.enum(['member', 'guest']),
  linkExistingByEmail: z.boolean(),
  trustIdpMfa: z.boolean(),
  syncRoles: z.boolean(),
  syncEnabled: z.boolean(),
  roleMappings: z.array(IdpRoleMapping),
  config: z.union([OidcIdpConfig, SamlIdpConfig, LdapConfig]),
  /** A client secret / bind password is stored (never returned). */
  hasSecret: z.boolean(),
  /** What the IdP administrator registers: OIDC redirect URI or SAML ACS URL. */
  callbackUrl: z.string().nullable(),
  /** SAML SP metadata URL and entity ID; null for other kinds. */
  spMetadataUrl: z.string().nullable(),
  spEntityId: z.string().nullable(),
  status: z.object({
    linkedUsers: z.number().int(),
    lastLoginAt: Timestamp.nullable(),
    lastTestAt: Timestamp.nullable(),
    lastTestOk: z.boolean().nullable(),
    lastError: z.string().nullable(),
    lastSyncAt: Timestamp.nullable(),
    lastSyncOk: z.boolean().nullable(),
    lastSync: IdpSyncSummary.nullable(),
  }),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type IdentityProvider = z.infer<typeof IdentityProvider>;

/** "Bağlantıyı test et": a saved provider (`providerId`) or an unsaved form (`draft`). */
export const TestIdentityProvider = z
  .object({
    providerId: Id.optional(),
    /** Unsaved form values; secrets fall back to the stored ones of `providerId`. */
    draft: CreateIdentityProvider.optional(),
    /** LDAP: also look this person up and list their groups. */
    username: z.string().trim().max(320).optional(),
  })
  .refine((v) => v.providerId || v.draft, { message: 'providerId or draft required' });
export type TestIdentityProvider = z.infer<typeof TestIdentityProvider>;

export const IdpTestResult = z.object({
  ok: z.boolean(),
  /** Steps in order, e.g. discovery, jwks / connect, starttls, bind, search, user. */
  steps: z.array(
    z.object({ key: z.string(), ok: z.boolean(), detail: z.string().nullable(), ms: z.number() }),
  ),
  /** LDAP user lookup result when `username` was given. */
  user: z
    .object({
      dn: z.string(),
      email: z.string().nullable(),
      name: z.string().nullable(),
      uid: z.string().nullable(),
      groups: z.array(z.string()),
      disabled: z.boolean(),
      /** What the mappings would give this person. */
      orgRole: OrgRole.nullable(),
      spaces: z.array(z.object({ spaceId: Id, role: SpaceRole })),
    })
    .nullable(),
});
export type IdpTestResult = z.infer<typeof IdpTestResult>;

export const LinkedIdentity = z.object({
  userId: Id,
  name: z.string(),
  email: z.string(),
  subject: z.string(),
  groups: z.array(z.string()),
  directoryStatus: z.enum(['active', 'disabled', 'missing']),
  memberStatus: z.enum(['active', 'invited', 'suspended']).nullable(),
  lastLoginAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type LinkedIdentity = z.infer<typeof LinkedIdentity>;

// ---------------------------------------------------------------------------------------
// Security policy (9.11)
// ---------------------------------------------------------------------------------------

export const IpRange = z.object({
  /** IPv4/IPv6 address or CIDR. */
  cidr: z
    .string()
    .trim()
    .max(64)
    .regex(/^[0-9a-fA-F:.]+(\/\d{1,3})?$/),
  label: z.string().trim().max(80).default(''),
});
export type IpRange = z.infer<typeof IpRange>;

export const SecurityPolicy = z.object({
  twoFactor: z.object({
    /** Mirrors OrgSettings.requireTwoFactor (owners and admins always need 2FA). */
    required: z.boolean(),
    /** Passkey sign-in offered (it satisfies password and 2FA together). */
    passkeyEnabled: z.boolean(),
    /** "Bu cihazı 30 gün hatırla" on the 2FA step. */
    rememberDevice: z.boolean(),
  }),
  password: z.object({
    /** Local e-mail + password sign-in for people who are not owners. */
    localLogin: z.boolean(),
    minLength: z.number().int().min(8).max(128),
    /** Have I Been Pwned range check (k-anonymity, the password never leaves the server). */
    breachCheck: z.boolean(),
  }),
  session: z.object({
    /** Lifetime of a session without "keep me signed in". */
    hours: z.number().int().min(1).max(720),
    /** Lifetime with "keep me signed in"; 0 = the option is not offered. */
    rememberDays: z.number().int().min(0).max(90),
  }),
  ipAllowlist: z.object({
    enabled: z.boolean(),
    /** admin: Yönetim (org settings) endpoints only; all: every signed-in request. */
    scope: z.enum(['admin', 'all']),
    ranges: z.array(IpRange).max(200),
  }),
});
export type SecurityPolicy = z.infer<typeof SecurityPolicy>;

export const DEFAULT_SECURITY_POLICY: SecurityPolicy = {
  twoFactor: { required: false, passkeyEnabled: true, rememberDevice: true },
  password: { localLogin: true, minLength: 12, breachCheck: false },
  session: { hours: 12, rememberDays: 30 },
  ipAllowlist: { enabled: false, scope: 'admin', ranges: [] },
};

export const UpdateSecurityPolicy = z.object({
  twoFactor: SecurityPolicy.shape.twoFactor.partial().optional(),
  password: SecurityPolicy.shape.password.partial().optional(),
  session: SecurityPolicy.shape.session.partial().optional(),
  ipAllowlist: SecurityPolicy.shape.ipAllowlist.partial().optional(),
});
export type UpdateSecurityPolicy = z.infer<typeof UpdateSecurityPolicy>;

export const SecurityPolicyView = z.object({
  policy: SecurityPolicy,
  status: z.object({
    twoFactor: z.object({
      enrolled: z.number().int(),
      total: z.number().int(),
      /** Active members still without TOTP or passkey. */
      pending: z.array(z.object({ userId: Id, name: z.string(), email: z.string() })),
    }),
    /** The caller's address as the server sees it (IP allowlist check). */
    currentIp: z.string().nullable(),
    lockout: z.object({ attempts: z.number().int(), minutes: z.number().int() }),
    /** Policy changes need a verification within the last 10 minutes. */
    needsReauth: z.boolean(),
  }),
});
export type SecurityPolicyView = z.infer<typeof SecurityPolicyView>;

export const IdentityReauth = z.object({ password: z.string().min(1).max(256) });
export const IdentityReauthResult = z.object({ verifiedUntil: Timestamp });

// ---------------------------------------------------------------------------------------
// Step-up without a password: passkey (web, desktop) and trusted device key (mobile,
// Face ID / fingerprint). Every method opens the same 10-minute window as the password.
// ---------------------------------------------------------------------------------------

export const DeviceKeyPlatform = z.enum(['ios', 'android', 'other']);
export type DeviceKeyPlatform = z.infer<typeof DeviceKeyPlatform>;

export const DeviceKey = z.object({
  id: Id,
  name: z.string(),
  platform: DeviceKeyPlatform,
  createdAt: Timestamp,
  lastUsedAt: Timestamp.nullable(),
});
export type DeviceKey = z.infer<typeof DeviceKey>;

/** What the re-verification dialog may offer this person, and the current window. */
export const ReauthMethods = z.object({
  password: z.boolean(),
  passkeys: z.number().int(),
  deviceKeys: z.array(DeviceKey),
  /** End of the current verification window; null when none is open. */
  verifiedUntil: Timestamp.nullable(),
});
export type ReauthMethods = z.infer<typeof ReauthMethods>;

/** WebAuthn request options (PublicKeyCredentialRequestOptionsJSON) and the challenge id. */
export const PasskeyReauthOptions = z.object({
  challengeId: Id,
  options: z.record(z.string(), z.unknown()),
});
export type PasskeyReauthOptions = z.infer<typeof PasskeyReauthOptions>;

export const PasskeyReauthVerify = z.object({
  challengeId: Id,
  /** AuthenticationResponseJSON from navigator.credentials.get (@simplewebauthn/browser). */
  response: z.record(z.string(), z.unknown()),
});

export const RegisterDeviceKey = z.object({
  name: z.string().trim().min(1).max(80),
  platform: DeviceKeyPlatform,
  /**
   * ECDSA P-256 public key, base64: SubjectPublicKeyInfo DER (Android getEncoded) or the
   * 65-byte uncompressed point (iOS SecKeyCopyExternalRepresentation).
   */
  publicKey: z.string().min(80).max(400),
});

export const DeviceReauthOptionsInput = z.object({ keyId: Id });
export const DeviceReauthOptions = z.object({
  challengeId: Id,
  /** 32 random bytes, base64url: sign these bytes (ECDSA P-256, SHA-256) with the device key. */
  challenge: z.string(),
  expiresAt: Timestamp,
});
export const DeviceReauthVerify = z.object({
  challengeId: Id,
  keyId: Id,
  /** Signature over the challenge bytes, base64: DER (X9.62) or raw r||s (64 bytes). */
  signature: z.string().min(80).max(200),
});

// ---------------------------------------------------------------------------------------
// Crewhall as OIDC provider (9.12, 9.13)
// ---------------------------------------------------------------------------------------

export const OIDC_SCOPES = ['openid', 'profile', 'email', 'groups', 'offline_access'] as const;
export const OidcScope = z.enum(OIDC_SCOPES);
export type OidcScope = z.infer<typeof OidcScope>;

/** web: confidential (secret); spa / native: public, PKCE required, no secret. */
export const OidcClientType = z.enum(['web', 'spa', 'native']);
export type OidcClientType = z.infer<typeof OidcClientType>;

/** Exact match, no wildcards; http only for localhost / 127.0.0.1; native apps may use a private scheme. */
const RedirectUri = z.string().trim().min(1).max(2000);

export const OidcClientAccess = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }),
  z.object({ kind: z.literal('space'), spaceId: Id }),
]);
export type OidcClientAccess = z.infer<typeof OidcClientAccess>;

export const CreateOidcClient = z.object({
  name: z.string().trim().min(1).max(80),
  /** Readable, unique client id; generated from the name when omitted. */
  clientId: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9._-]{1,62}$/)
    .optional(),
  type: OidcClientType.default('web'),
  homepageUrl: z.url().max(500).nullable().default(null),
  logoUrl: z.url().max(1000).nullable().default(null),
  redirectUris: z.array(RedirectUri).min(1).max(20),
  postLogoutRedirectUris: z.array(RedirectUri).max(20).default([]),
  /** `openid` is always included. */
  scopes: z.array(OidcScope).default(['openid', 'profile', 'email']),
  /** Internal app: the consent screen is skipped (when the org setting allows it). */
  skipConsent: z.boolean().default(true),
  access: OidcClientAccess.default({ kind: 'all' }),
  guestsAllowed: z.boolean().default(false),
  /** Secret lifetime for web clients. */
  secretMonths: z.number().int().min(1).max(36).default(12),
});
export type CreateOidcClient = z.infer<typeof CreateOidcClient>;
export type CreateOidcClientInput = z.input<typeof CreateOidcClient>;

export const UpdateOidcClient = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  homepageUrl: z.url().max(500).nullable().optional(),
  logoUrl: z.url().max(1000).nullable().optional(),
  redirectUris: z.array(RedirectUri).min(1).max(20).optional(),
  postLogoutRedirectUris: z.array(RedirectUri).max(20).optional(),
  scopes: z.array(OidcScope).optional(),
  skipConsent: z.boolean().optional(),
  access: OidcClientAccess.optional(),
  guestsAllowed: z.boolean().optional(),
  /** Disabled: sign-in refused, refresh tokens stop at their next use. */
  enabled: z.boolean().optional(),
});
export type UpdateOidcClient = z.infer<typeof UpdateOidcClient>;

export const OidcClient = z.object({
  id: Id,
  clientId: z.string(),
  name: z.string(),
  type: OidcClientType,
  homepageUrl: z.string().nullable(),
  logoUrl: z.string().nullable(),
  redirectUris: z.array(z.string()),
  postLogoutRedirectUris: z.array(z.string()),
  scopes: z.array(OidcScope),
  skipConsent: z.boolean(),
  access: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('all') }),
    z.object({ kind: z.literal('space'), spaceId: Id, spaceName: z.string() }),
  ]),
  guestsAllowed: z.boolean(),
  enabled: z.boolean(),
  /** Last 4 characters of the secret; null for public clients. */
  secretHint: z.string().nullable(),
  secretExpiresAt: Timestamp.nullable(),
  lastLoginAt: Timestamp.nullable(),
  lastLoginUser: z.object({ id: Id, name: z.string() }).nullable(),
  logins7d: z.number().int(),
  createdAt: Timestamp,
});
export type OidcClient = z.infer<typeof OidcClient>;

export const CreatedOidcClient = z.object({
  client: OidcClient,
  /** Shown once (9.13); null for spa / native clients. */
  clientSecret: z.string().nullable(),
});
export type CreatedOidcClient = z.infer<typeof CreatedOidcClient>;

export const RotatedOidcSecret = z.object({ clientSecret: z.string(), expiresAt: Timestamp });

export const OidcProviderSettings = z.object({
  /** Master switch for per-client skipConsent ("Kurum içi uygulamalarda izin ekranını atla"). */
  skipConsentForInternal: z.boolean(),
  /** Guests may use SSO at all; each client must allow them too. */
  guestsAllowed: z.boolean(),
});
export type OidcProviderSettings = z.infer<typeof OidcProviderSettings>;

export const OidcProviderInfo = z.object({
  issuer: z.string(),
  discoveryUrl: z.string(),
  jwksUrl: z.string(),
  signingKey: z.object({ kid: z.string(), alg: z.string(), createdAt: Timestamp }).nullable(),
  settings: OidcProviderSettings,
  clients: z.array(OidcClient),
});
export type OidcProviderInfo = z.infer<typeof OidcProviderInfo>;

/** Query of `/api/oidc/authorize`, forwarded to the consent page unchanged. */
export const OidcAuthorizeRequest = z.object({
  client_id: z.string().max(200),
  redirect_uri: z.string().max(2000),
  response_type: z.string().max(50),
  scope: z.string().max(1000),
  state: z.string().max(2000).optional(),
  nonce: z.string().max(500).optional(),
  code_challenge: z.string().max(200).optional(),
  code_challenge_method: z.string().max(10).optional(),
  prompt: z.string().max(100).optional(),
  max_age: z.string().max(20).optional(),
  login_hint: z.string().max(320).optional(),
  ui_locales: z.string().max(100).optional(),
});
export type OidcAuthorizeRequest = z.infer<typeof OidcAuthorizeRequest>;

export const OidcConsentInfo = z.object({
  client: z.object({
    name: z.string(),
    clientId: z.string(),
    logoUrl: z.string().nullable(),
    homepageUrl: z.string().nullable(),
    redirectHost: z.string(),
  }),
  user: z.object({ name: z.string(), email: z.string(), orgName: z.string() }),
  scopes: z.array(z.object({ scope: OidcScope, required: z.boolean() })),
  /** Skip the screen: approve immediately (internal app or already granted). */
  autoApprove: z.boolean(),
  consentToken: z.string(),
});
export type OidcConsentInfo = z.infer<typeof OidcConsentInfo>;

export const OidcConsentDecision = OidcAuthorizeRequest.extend({
  consentToken: z.string().max(2000),
});
export type OidcConsentDecision = z.infer<typeof OidcConsentDecision>;

export const OidcConsentResult = z.object({ redirectTo: z.string() });
export type OidcConsentResult = z.infer<typeof OidcConsentResult>;

/** Where to send the browser after signing out of Crewhall (RP-initiated logout at the IdP). */
export const SsoLogoutTarget = z.object({ url: z.string().nullable() });
export type SsoLogoutTarget = z.infer<typeof SsoLogoutTarget>;
