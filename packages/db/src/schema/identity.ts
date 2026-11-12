import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sessions, users } from './auth';
import { organizations } from './org';
import { spaces } from './space';
import { id, timestamps, tz } from './types';

/**
 * Identity module (design 9.11-9.14, doc 17 §2 and §4 oidc_clients): external identity
 * providers (OIDC, SAML, LDAP/AD) and the accounts linked to them, the org security policy,
 * and Crewhall as an OpenID Connect provider. Secrets of external providers are stored
 * encrypted with a key derived from AUTH_SECRET; client secrets, codes and refresh tokens of
 * the OIDC provider only as sha256 hashes.
 */

export const identityProviderKind = pgEnum('identity_provider_kind', ['oidc', 'saml', 'ldap']);
export const directoryStatus = pgEnum('directory_status', ['active', 'disabled', 'missing']);
export const oidcClientType = pgEnum('oidc_client_type', ['web', 'spa', 'native']);

/** Per-org security policy and OIDC provider settings; a missing row means the defaults. */
export const identityPolicies = pgTable('identity_policies', {
  orgId: uuid('org_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  /** SecurityPolicy without twoFactor.required (that lives in OrgSettings.requireTwoFactor). */
  security: jsonb('security').$type<Record<string, unknown>>().notNull().default({}),
  oidc: jsonb('oidc').$type<Record<string, unknown>>().notNull().default({}),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps(),
});

/** Inbound identity: an OIDC or SAML IdP, or an LDAP / Active Directory directory. */
export const identityProviders = pgTable(
  'identity_providers',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    kind: identityProviderKind('kind').notNull(),
    preset: text('preset').notNull(),
    name: text('name').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    /** Lower-case e-mail domains served by this provider. */
    domains: text('domains').array().notNull().default([]),
    enforceSso: boolean('enforce_sso').notNull().default(false),
    jitProvisioning: boolean('jit_provisioning').notNull().default(true),
    defaultRole: text('default_role', { enum: ['member', 'guest'] })
      .notNull()
      .default('member'),
    linkExistingByEmail: boolean('link_existing_by_email').notNull().default(true),
    trustIdpMfa: boolean('trust_idp_mfa').notNull().default(false),
    syncRoles: boolean('sync_roles').notNull().default(true),
    syncEnabled: boolean('sync_enabled').notNull().default(false),
    roleMappings: jsonb('role_mappings').$type<Record<string, unknown>[]>().notNull().default([]),
    /** Kind-specific settings (zod-validated in the service); never holds a secret. */
    config: jsonb('config').$type<Record<string, unknown>>().notNull(),
    /** Client secret / bind password, AES-256-GCM with a key derived from AUTH_SECRET. */
    secretEnc: text('secret_enc'),
    lastTestAt: tz('last_test_at'),
    lastTestOk: boolean('last_test_ok'),
    lastError: text('last_error'),
    lastSyncAt: tz('last_sync_at'),
    lastSyncOk: boolean('last_sync_ok'),
    lastSync: jsonb('last_sync').$type<Record<string, number>>(),
    position: integer('position').notNull().default(0),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [index('identity_providers_org_idx').on(t.orgId)],
);

/** A Crewhall account linked to an external identity (OIDC sub, SAML NameID, LDAP uid). */
export const externalIdentities = pgTable(
  'external_identities',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => identityProviders.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    subject: text('subject').notNull(),
    /** LDAP: the entry DN at the last sign-in or sync. */
    dn: text('dn'),
    email: text('email'),
    groups: text('groups').array().notNull().default([]),
    directoryStatus: directoryStatus('directory_status').notNull().default('active'),
    /** Set when a sync suspended the member, so a later sync may reactivate only those. */
    suspendedBySync: boolean('suspended_by_sync').notNull().default(false),
    lastLoginAt: tz('last_login_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('external_identities_subject_uq').on(t.providerId, t.subject),
    uniqueIndex('external_identities_user_uq').on(t.providerId, t.userId),
    index('external_identities_user_idx').on(t.userId),
  ],
);

/** Pending SSO sign-ins (OIDC state + nonce + PKCE verifier, SAML request id). 10 minutes. */
export const identityAuthStates = pgTable(
  'identity_auth_states',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => identityProviders.id, { onDelete: 'cascade' }),
    /** sha256 of the state value (OIDC) or the AuthnRequest id (SAML). */
    stateHash: text('state_hash').notNull().unique(),
    nonce: text('nonce'),
    codeVerifier: text('code_verifier'),
    callbackUrl: text('callback_url').notNull(),
    errorCallbackUrl: text('error_callback_url').notNull(),
    expiresAt: tz('expires_at').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [index('identity_auth_states_expires_idx').on(t.expiresAt)],
);

/** Which IdP a Crewhall session came from: id_token / SAML session for RP-initiated logout. */
export const identitySessions = pgTable('identity_sessions', {
  sessionId: uuid('session_id')
    .primaryKey()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  providerId: uuid('provider_id')
    .notNull()
    .references(() => identityProviders.id, { onDelete: 'cascade' }),
  idToken: text('id_token'),
  nameId: text('name_id'),
  sessionIndex: text('session_index'),
  /** The IdP reported MFA and the provider trusts it: satisfies the org 2FA policy. */
  mfa: boolean('mfa').notNull().default(false),
  createdAt: tz('created_at').notNull().defaultNow(),
});

// ---- Crewhall as OpenID Connect provider -------------------------------------------------

export const oidcClients = pgTable(
  'oidc_clients',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    clientId: text('client_id').notNull().unique(),
    clientSecretHash: text('client_secret_hash'),
    secretHint: text('secret_hint'),
    secretExpiresAt: tz('secret_expires_at'),
    name: text('name').notNull(),
    type: oidcClientType('type').notNull().default('web'),
    homepageUrl: text('homepage_url'),
    logoUrl: text('logo_url'),
    redirectUris: text('redirect_uris').array().notNull(),
    postLogoutRedirectUris: text('post_logout_redirect_uris').array().notNull().default([]),
    scopes: text('scopes').array().notNull(),
    skipConsent: boolean('skip_consent').notNull().default(true),
    /** null = all members; otherwise members of this space. */
    accessSpaceId: uuid('access_space_id').references(() => spaces.id, { onDelete: 'set null' }),
    guestsAllowed: boolean('guests_allowed').notNull().default(false),
    enabled: boolean('enabled').notNull().default(true),
    /** Built-in client of a Microsoft integration ('outlook', 'teams'); managed by its wizard. */
    integration: text('integration'),
    lastLoginAt: tz('last_login_at'),
    lastLoginUserId: uuid('last_login_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [index('oidc_clients_org_idx').on(t.orgId)],
);

/** Scopes a person granted to a client; the consent screen is skipped while they suffice. */
export const oidcConsents = pgTable(
  'oidc_consents',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id')
      .notNull()
      .references(() => oidcClients.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    scopes: text('scopes').array().notNull(),
    ...timestamps(),
  },
  (t) => [uniqueIndex('oidc_consents_uq').on(t.clientId, t.userId)],
);

/** Authorization codes: single use, 60 seconds, stored as sha256. */
export const oidcAuthCodes = pgTable(
  'oidc_auth_codes',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull().unique(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => oidcClients.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The Crewhall session that approved it (sid claim, end_session). */
    sessionId: uuid('session_id'),
    redirectUri: text('redirect_uri').notNull(),
    scopes: text('scopes').array().notNull(),
    nonce: text('nonce'),
    codeChallenge: text('code_challenge'),
    authTime: tz('auth_time').notNull(),
    amr: text('amr').array().notNull().default([]),
    /** Set when the code was exchanged; a second exchange revokes what it produced. */
    consumedAt: tz('consumed_at'),
    /** Refresh token issued from this code (revoked on code replay). */
    refreshTokenId: uuid('refresh_token_id'),
    expiresAt: tz('expires_at').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [index('oidc_auth_codes_expires_idx').on(t.expiresAt)],
);

/** Refresh tokens (offline_access): rotated on every use; reuse of an old one revokes the chain. */
export const oidcRefreshTokens = pgTable(
  'oidc_refresh_tokens',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id')
      .notNull()
      .references(() => oidcClients.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id'),
    tokenHash: text('token_hash').notNull().unique(),
    prevTokenHash: text('prev_token_hash'),
    scopes: text('scopes').array().notNull(),
    authTime: tz('auth_time').notNull(),
    amr: text('amr').array().notNull().default([]),
    expiresAt: tz('expires_at').notNull(),
    revokedAt: tz('revoked_at'),
    lastUsedAt: tz('last_used_at'),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('oidc_refresh_tokens_prev_idx').on(t.prevTokenHash),
    index('oidc_refresh_tokens_user_idx').on(t.userId, t.clientId),
  ],
);

/** RS256 signing keys; the newest active one signs, retired ones stay in JWKS until expiry. */
export const oidcSigningKeys = pgTable('oidc_signing_keys', {
  id: id(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  kid: text('kid').notNull().unique(),
  alg: text('alg').notNull().default('RS256'),
  publicJwk: jsonb('public_jwk').$type<Record<string, unknown>>().notNull(),
  /** PKCS#8 PEM, AES-256-GCM encrypted with a key derived from AUTH_SECRET. */
  privateKeyEnc: text('private_key_enc').notNull(),
  /** Set when a newer key took over; published in JWKS until removeAt. */
  retiredAt: tz('retired_at'),
  removeAt: tz('remove_at'),
  createdAt: tz('created_at').notNull().defaultNow(),
});

/**
 * Trusted device keys (step-up on mobile): an ECDSA P-256 key pair made in the Secure
 * Enclave / Android Keystore behind biometrics; the server keeps only the public key and
 * accepts a signed challenge as a re-verification (Face ID / fingerprint instead of password).
 */
export const deviceKeys = pgTable(
  'device_keys',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Org the key was registered in (audit); the key works in any org of the person. */
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    platform: text('platform').notNull(),
    /** SubjectPublicKeyInfo DER, base64. */
    publicKey: text('public_key').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
    lastUsedAt: tz('last_used_at'),
    revokedAt: tz('revoked_at'),
  },
  (t) => [index('device_keys_user_idx').on(t.userId)],
);

/** One-time challenges of a passkey or device-key re-verification (2 minutes, single use). */
export const reauthChallenges = pgTable(
  'reauth_challenges',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').notNull(),
    /** passkey | device */
    kind: text('kind').notNull(),
    challenge: text('challenge').notNull(),
    deviceKeyId: uuid('device_key_id').references(() => deviceKeys.id, { onDelete: 'cascade' }),
    expiresAt: tz('expires_at').notNull(),
    usedAt: tz('used_at'),
  },
  (t) => [index('reauth_challenges_user_idx').on(t.userId)],
);
