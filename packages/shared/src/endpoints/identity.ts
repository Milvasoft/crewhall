import { z } from 'zod';
import { Empty, def, items, type EndpointDef } from '../endpoint-def';
import { page } from '../schemas/common';
import {
  CreateIdentityProvider,
  CreateOidcClient,
  CreatedOidcClient,
  IdentityProvider,
  IdentityReauth,
  IdentityReauthResult,
  DeviceKey,
  DeviceReauthOptions,
  DeviceReauthOptionsInput,
  DeviceReauthVerify,
  PasskeyReauthOptions,
  PasskeyReauthVerify,
  ReauthMethods,
  RegisterDeviceKey,
  IdpSyncSummary,
  IdpTestResult,
  LinkedIdentity,
  OidcAuthorizeRequest,
  OidcClient,
  OidcConsentDecision,
  OidcConsentInfo,
  OidcConsentResult,
  OidcProviderInfo,
  OidcProviderSettings,
  RotatedOidcSecret,
  SecurityPolicyView,
  SignInDiscovery,
  SignInDiscoveryRequest,
  SsoLogoutTarget,
  TestIdentityProvider,
  UpdateIdentityProvider,
  UpdateOidcClient,
  UpdateSecurityPolicy,
} from '../schemas/identity';
import { BackupOverview, BackupRun, BackupSettings } from '../schemas/backups';
import {
  ComplianceOverview,
  CompliancePolicy,
  CreateEdiscoveryExport,
  CreateLegalHold,
  DownloadLink,
  EdiscoveryExport,
  LegalHold,
} from '../schemas/compliance';

/**
 * Identity module contract: external sign-in (OIDC/SAML SSO, Active Directory/LDAP), Crewhall as an
 * OIDC provider for other apps (design 9.11-9.14) and the module switches. Owned by the platform session.
 *
 * Module switches themselves need no endpoint: `updateOrg` with `settings.modules` (owner/admin,
 * audited), `Me.modules` for clients. Browser redirects and standards endpoints (SSO start and
 * callbacks, SAML ACS/metadata, LDAP sign-in under /api/auth, the OIDC provider under /api/oidc and
 * /.well-known/openid-configuration) are listed in IDENTITY_RAW_PATHS.
 *
 * Admin endpoints need `org.update_settings` (owner, admin).
 */
export const identityEndpoints = {
  // ---- login screen ----
  /** Which way this e-mail signs in (SSO-enforced domain → redirect). Rate limited per IP. */
  discoverSignIn: def({
    method: 'POST',
    path: '/api/v1/identity/discover',
    auth: 'public',
    body: SignInDiscoveryRequest,
    response: SignInDiscovery,
  }),
  /** Call before signing out: IdP end-session URL when the session came from an IdP that wants it. */
  getSsoLogoutTarget: def({
    method: 'GET',
    path: '/api/v1/identity/logout-target',
    auth: 'session',
    query: z.object({ postLogoutUrl: z.string().max(2000).optional() }),
    response: SsoLogoutTarget,
  }),

  // ---- Yönetim › Entegrasyonlar: identity providers (inbound) ----
  listIdentityProviders: def({
    method: 'GET',
    path: '/api/v1/identity/providers',
    auth: 'session',
    response: items(IdentityProvider),
  }),
  getIdentityProvider: def({
    method: 'GET',
    path: '/api/v1/identity/providers/:providerId',
    auth: 'session',
    response: IdentityProvider,
  }),
  createIdentityProvider: def({
    method: 'POST',
    path: '/api/v1/identity/providers',
    auth: 'session',
    body: CreateIdentityProvider,
    response: IdentityProvider,
  }),
  updateIdentityProvider: def({
    method: 'PATCH',
    path: '/api/v1/identity/providers/:providerId',
    auth: 'session',
    body: UpdateIdentityProvider,
    response: IdentityProvider,
  }),
  /** Linked accounts stay; they sign in with a local password or another provider afterwards. */
  deleteIdentityProvider: def({
    method: 'DELETE',
    path: '/api/v1/identity/providers/:providerId',
    auth: 'session',
    response: Empty,
  }),
  /** "Bağlantıyı test et": discovery / bind / search, saved or unsaved values. Never signs anyone in. */
  testIdentityProvider: def({
    method: 'POST',
    path: '/api/v1/identity/providers/test',
    auth: 'session',
    body: TestIdentityProvider,
    response: IdpTestResult,
  }),
  /** LDAP: run the directory sync now (also runs hourly when syncEnabled). */
  syncIdentityProvider: def({
    method: 'POST',
    path: '/api/v1/identity/providers/:providerId/sync',
    auth: 'session',
    response: IdpSyncSummary,
  }),
  listLinkedIdentities: def({
    method: 'GET',
    path: '/api/v1/identity/providers/:providerId/users',
    auth: 'session',
    query: z.object({
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
    response: page(LinkedIdentity),
  }),

  // ---- Yönetim › Güvenlik (9.11) ----
  getSecurityPolicy: def({
    method: 'GET',
    path: '/api/v1/identity/security',
    auth: 'session',
    response: SecurityPolicyView,
  }),
  /** Needs a verification in the last 10 minutes (403 identity_reauth_required). */
  updateSecurityPolicy: def({
    method: 'PATCH',
    path: '/api/v1/identity/security',
    auth: 'session',
    body: UpdateSecurityPolicy,
    response: SecurityPolicyView,
  }),
  /** Confirms the password for sensitive admin changes; valid 10 minutes for this session. */
  identityReauth: def({
    method: 'POST',
    path: '/api/v1/identity/reauth',
    auth: 'session',
    body: IdentityReauth,
    response: IdentityReauthResult,
  }),
  /** Passkey count, device keys and the open window: what the re-verification may offer. */
  getReauthMethods: def({
    method: 'GET',
    path: '/api/v1/me/reauth',
    auth: 'session',
    response: ReauthMethods,
  }),
  /** WebAuthn options for a passkey step-up (the person's passkeys, user verification required). */
  reauthPasskeyOptions: def({
    method: 'POST',
    path: '/api/v1/me/reauth/passkey/options',
    auth: 'session',
    response: PasskeyReauthOptions,
  }),
  /** A verified passkey assertion opens the same 10-minute window as the password. */
  reauthPasskeyVerify: def({
    method: 'POST',
    path: '/api/v1/me/reauth/passkey/verify',
    auth: 'session',
    body: PasskeyReauthVerify,
    response: IdentityReauthResult,
  }),
  /** Mobile: register a biometric-protected device key; needs a verification in the last 10 minutes. */
  registerDeviceKey: def({
    method: 'POST',
    path: '/api/v1/me/devices/keys',
    auth: 'session',
    body: RegisterDeviceKey,
    response: DeviceKey,
  }),
  listDeviceKeys: def({
    method: 'GET',
    path: '/api/v1/me/devices/keys',
    auth: 'session',
    response: items(DeviceKey),
  }),
  deleteDeviceKey: def({
    method: 'DELETE',
    path: '/api/v1/me/devices/keys/:keyId',
    auth: 'session',
    response: Empty,
  }),
  /** A one-time challenge (2 minutes) for the device key to sign. */
  reauthDeviceOptions: def({
    method: 'POST',
    path: '/api/v1/me/reauth/device/options',
    auth: 'session',
    body: DeviceReauthOptionsInput,
    response: DeviceReauthOptions,
  }),
  /** A valid signature over the challenge opens the same 10-minute window as the password. */
  reauthDeviceVerify: def({
    method: 'POST',
    path: '/api/v1/me/reauth/device/verify',
    auth: 'session',
    body: DeviceReauthVerify,
    response: IdentityReauthResult,
  }),

  // ---- Yönetim › SSO uygulamaları (9.12, 9.13) ----
  getOidcProvider: def({
    method: 'GET',
    path: '/api/v1/identity/oidc',
    auth: 'session',
    response: OidcProviderInfo,
  }),
  updateOidcProviderSettings: def({
    method: 'PATCH',
    path: '/api/v1/identity/oidc/settings',
    auth: 'session',
    body: OidcProviderSettings.partial(),
    response: OidcProviderInfo,
  }),
  /** New signing key; the previous one stays in JWKS until its tokens expire. */
  rotateOidcSigningKey: def({
    method: 'POST',
    path: '/api/v1/identity/oidc/keys/rotate',
    auth: 'session',
    response: OidcProviderInfo,
  }),
  createOidcClient: def({
    method: 'POST',
    path: '/api/v1/identity/oidc/clients',
    auth: 'session',
    body: CreateOidcClient,
    response: CreatedOidcClient,
  }),
  updateOidcClient: def({
    method: 'PATCH',
    path: '/api/v1/identity/oidc/clients/:oidcClientId',
    auth: 'session',
    body: UpdateOidcClient,
    response: OidcClient,
  }),
  deleteOidcClient: def({
    method: 'DELETE',
    path: '/api/v1/identity/oidc/clients/:oidcClientId',
    auth: 'session',
    response: Empty,
  }),
  /** New secret shown once; the old one stops working immediately. Needs re-verification. */
  rotateOidcClientSecret: def({
    method: 'POST',
    path: '/api/v1/identity/oidc/clients/:oidcClientId/secret',
    auth: 'session',
    response: RotatedOidcSecret,
  }),

  // ---- OIDC consent page (/sso/consent) ----
  getOidcConsent: def({
    method: 'GET',
    path: '/api/v1/identity/oidc/consent',
    auth: 'session',
    query: OidcAuthorizeRequest,
    response: OidcConsentInfo,
  }),
  approveOidcConsent: def({
    method: 'POST',
    path: '/api/v1/identity/oidc/consent',
    auth: 'session',
    body: OidcConsentDecision,
    response: OidcConsentResult,
  }),
  denyOidcConsent: def({
    method: 'POST',
    path: '/api/v1/identity/oidc/consent/deny',
    auth: 'session',
    body: OidcConsentDecision,
    response: OidcConsentResult,
  }),
  // ---- backups (roadmap 3): install admin only ----------------------------------------
  /** Schedule, latest runs and the snapshots in the backups volume. */
  getBackups: def({
    method: 'GET',
    path: '/api/v1/admin/backups',
    auth: 'session',
    response: BackupOverview,
  }),
  updateBackupSettings: def({
    method: 'PUT',
    path: '/api/v1/admin/backups/settings',
    auth: 'session',
    body: BackupSettings,
    response: BackupOverview,
  }),
  /** "Şimdi yedek al": queues a run; 409 conflict while one is queued or running. */
  startBackup: def({
    method: 'POST',
    path: '/api/v1/admin/backups',
    auth: 'session',
    response: BackupRun,
  }),
  // ---- compliance (roadmap 25): org owners and admins ---------------------------------
  /** Retention and DLP rules, legal holds and eDiscovery exports of the org. */
  getCompliance: def({
    method: 'GET',
    path: '/api/v1/admin/compliance',
    auth: 'session',
    response: ComplianceOverview,
  }),
  updateCompliancePolicy: def({
    method: 'PUT',
    path: '/api/v1/admin/compliance/policy',
    auth: 'session',
    body: CompliancePolicy,
    response: ComplianceOverview,
  }),
  createLegalHold: def({
    method: 'POST',
    path: '/api/v1/admin/compliance/holds',
    auth: 'session',
    body: CreateLegalHold,
    response: LegalHold,
  }),
  /** Ends a hold; its content follows the normal retention and trash rules again. */
  releaseLegalHold: def({
    method: 'POST',
    path: '/api/v1/admin/compliance/holds/:holdId/release',
    auth: 'session',
    response: LegalHold,
  }),
  /** Queues an export; the archive is ready when its status is "ready". */
  createEdiscoveryExport: def({
    method: 'POST',
    path: '/api/v1/admin/compliance/exports',
    auth: 'session',
    body: CreateEdiscoveryExport,
    response: EdiscoveryExport,
  }),
  /** 5-minute download link of a ready export (audited). */
  getEdiscoveryDownload: def({
    method: 'GET',
    path: '/api/v1/admin/compliance/exports/:exportId/download',
    auth: 'session',
    response: DownloadLink,
  }),
} as const satisfies Record<string, EndpointDef>;
