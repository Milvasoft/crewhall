import { randomBytes } from 'node:crypto';
import { and, eq, gt, lt } from 'drizzle-orm';
import { identityAuthStates, identitySessions, type DbOrTx } from '@crewhall/db';
import type { IdpTestResult, OidcIdpConfig, SamlIdpConfig } from '@crewhall/shared';
import { SAML, ValidateInResponseTo, type Profile } from '@node-saml/node-saml';
import * as oidc from 'openid-client';
import type { Context } from 'hono';
import type { Deps } from '../../deps';
import type { Env } from '../../env';
import { AppError } from '../../http/errors';
import type { AppEnv, RequestInfo } from '../../http/types';
import { identityAudit } from './audit';
import { sha256 } from './crypto';
import type { ExternalProfile } from './provision';
import { provisionUser, userCreatorOf } from './provision';
import {
  callbackUrl,
  configOf,
  findProvider,
  samlEntityId,
  secretOf,
  type ProviderRow,
} from './providers';
import { entraGroups } from '../microsoft/entra';
import { finishBrowserSignIn } from './session';

/**
 * Inbound SSO (design: "… ile giriş yap"): OpenID Connect with openid-client (MIT) and
 * SAML 2.0 with @node-saml/node-saml (MIT). Browser routes live in routes/identity.ts.
 */

const STATE_TTL_MS = 10 * 60 * 1000;

type OidcRow = ProviderRow & { kind: 'oidc' };
type SamlRow = ProviderRow & { kind: 'saml' };

// ---- redirect targets -------------------------------------------------------------------

/** Only paths of the web app or absolute URLs on its own origins (no open redirect). */
export function safeWebTarget(env: Env, value: string | undefined, fallback: string) {
  const hub = new URL(env.HUB_URL);
  const allowed = new Set([hub.origin, ...env.WEB_ORIGINS.map((o) => new URL(o).origin)]);
  const raw = value?.trim() || fallback;
  try {
    if (raw.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('/\\')) {
      return new URL(raw, hub).href;
    }
    const url = new URL(raw);
    if (allowed.has(url.origin)) return url.href;
  } catch {
    // fall through
  }
  return new URL(fallback, hub).href;
}

export function withError(url: string, code: string) {
  const u = new URL(url);
  u.searchParams.set('ssoError', code);
  return u.href;
}

// ---- OIDC ---------------------------------------------------------------------------------

/** http issuers only for loopback hosts, or anywhere outside production (local Keycloak). */
function insecureAllowed(env: Env, issuer: string) {
  const url = new URL(issuer);
  if (url.protocol === 'https:') return false;
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  return loopback || env.NODE_ENV !== 'production';
}

const discoveryCache = new Map<string, { at: number; config: oidc.Configuration }>();
const DISCOVERY_TTL_MS = 10 * 60 * 1000;

async function oidcConfiguration(
  env: Env,
  cacheKey: string | null,
  config: OidcIdpConfig,
  secret: string | null,
) {
  const hit = cacheKey ? discoveryCache.get(cacheKey) : undefined;
  if (hit && Date.now() - hit.at < DISCOVERY_TTL_MS) return hit.config;
  const options: oidc.DiscoveryRequestOptions = {
    timeout: 8,
    ...(insecureAllowed(env, config.issuer) ? { execute: [oidc.allowInsecureRequests] } : {}),
  };
  const configuration = await oidc.discovery(
    new URL(config.issuer),
    config.clientId,
    secret ?? undefined,
    secret ? oidc.ClientSecretPost(secret) : oidc.None(),
    options,
  );
  if (cacheKey) discoveryCache.set(cacheKey, { at: Date.now(), config: configuration });
  return configuration;
}

const providerCacheKey = (row: ProviderRow) => `${row.id}:${row.updatedAt.getTime()}`;

function claimPath(claims: Record<string, unknown>, path: string): unknown {
  if (path in claims) return claims[path];
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in acc) return (acc as Record<string, unknown>)[key];
    return undefined;
  }, claims);
}

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string' && value) return [value];
  return [];
}

const MFA_AMR = new Set(['mfa', 'otp', 'hwk', 'sms', 'totp', 'fido', 'face', 'fpt', 'webauthn']);

export function idpReportedMfa(claims: Record<string, unknown>) {
  if (asList(claims.amr).some((a) => MFA_AMR.has(a.toLowerCase()))) return true;
  const acr = typeof claims.acr === 'string' ? claims.acr.toLowerCase() : '';
  return /mfa|multi|loa2|loa3|silver|gold/.test(acr) || acr === '2' || acr === '3';
}

export function profileFromClaims(
  row: Pick<ProviderRow, 'preset'>,
  config: OidcIdpConfig,
  claims: Record<string, unknown>,
): ExternalProfile {
  const sub = typeof claims.sub === 'string' ? claims.sub : '';
  // Entra: the object id is the same for every app of the tenant (and SCIM's externalId); sub is per app.
  const oid = row.preset === 'entra' && typeof claims.oid === 'string' ? claims.oid : null;
  const pick = (k: string) => (typeof claims[k] === 'string' ? (claims[k] as string) : null);
  const emailClaim = pick('email');
  const fallback = [pick('preferred_username'), pick('upn')].find((v) => v?.includes('@')) ?? null;
  const email = (emailClaim ?? fallback)?.toLowerCase() ?? null;
  // Entra ID does not send email_verified; its tenant controls the addresses.
  const verified =
    claims.email_verified === true ||
    claims.email_verified === 'true' ||
    (row.preset === 'entra' && Boolean(email));
  const name =
    pick('name') ?? ([pick('given_name'), pick('family_name')].filter(Boolean).join(' ') || null);
  return {
    subject: oid ?? sub,
    ...(oid && sub && oid !== sub ? { altSubjects: [sub] } : {}),
    email,
    emailVerified: verified,
    name,
    groups: asList(claimPath(claims, config.groupsClaim)),
    mfa: idpReportedMfa(claims),
  };
}

export async function startOidc(
  deps: Deps,
  row: OidcRow,
  target: { callbackUrl: string; errorCallbackUrl: string; loginHint?: string | undefined },
) {
  const config = configOf(row);
  const configuration = await oidcConfiguration(
    deps.env,
    providerCacheKey(row),
    config,
    secretOf(deps.env, row),
  ).catch((err: unknown) => {
    deps.logger.warn({ err, provider: row.id }, 'OIDC discovery failed');
    throw new AppError('idp_unavailable');
  });
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const verifier = oidc.randomPKCECodeVerifier();
  await pruneStates(deps.db);
  await deps.db.insert(identityAuthStates).values({
    orgId: row.orgId,
    providerId: row.id,
    stateHash: sha256(state),
    nonce,
    codeVerifier: verifier,
    callbackUrl: target.callbackUrl,
    errorCallbackUrl: target.errorCallbackUrl,
    expiresAt: new Date(Date.now() + STATE_TTL_MS),
  });
  const params: Record<string, string> = {
    redirect_uri: callbackUrl(deps.env, row)!,
    scope: config.scopes.includes('openid') ? config.scopes : `openid ${config.scopes}`,
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    state,
    nonce,
  };
  if (config.prompt) params.prompt = config.prompt;
  if (target.loginHint) params.login_hint = target.loginHint;
  return oidc.buildAuthorizationUrl(configuration, params).href;
}

async function takeState(db: DbOrTx, providerId: string, value: string) {
  const [row] = await db
    .delete(identityAuthStates)
    .where(
      and(
        eq(identityAuthStates.stateHash, sha256(value)),
        eq(identityAuthStates.providerId, providerId),
        gt(identityAuthStates.expiresAt, new Date()),
      ),
    )
    .returning();
  return row ?? null;
}

async function pruneStates(db: DbOrTx) {
  await db.delete(identityAuthStates).where(lt(identityAuthStates.expiresAt, new Date()));
}

/** The state row of a callback, found before anything else so errors go to its error target. */
export async function stateForCallback(db: DbOrTx, providerId: string, state: string | undefined) {
  if (!state) return null;
  return takeState(db, providerId, state);
}

export async function completeOidc(
  deps: Deps,
  c: Context<AppEnv>,
  row: OidcRow,
  state: typeof identityAuthStates.$inferSelect,
  req: RequestInfo,
) {
  const config = configOf(row);
  const configuration = await oidcConfiguration(
    deps.env,
    providerCacheKey(row),
    config,
    secretOf(deps.env, row),
  ).catch(() => {
    throw new AppError('idp_unavailable');
  });
  const current = new URL(callbackUrl(deps.env, row)!);
  current.search = new URL(c.req.url).search;
  let tokens: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>;
  try {
    tokens = await oidc.authorizationCodeGrant(configuration, current, {
      pkceCodeVerifier: state.codeVerifier ?? undefined,
      expectedNonce: state.nonce ?? undefined,
      expectedState: new URL(c.req.url).searchParams.get('state') ?? undefined,
      idTokenExpected: true,
    });
  } catch (err) {
    deps.logger.warn({ err, provider: row.id }, 'OIDC code exchange failed');
    throw new AppError('sso_login_failed');
  }
  const claims = (tokens.claims() ?? {}) as Record<string, unknown>;
  let merged = claims;
  // Some IdPs (Entra, Google) send groups or e-mail only from userinfo.
  if (
    (!claims.email || claimPath(claims, config.groupsClaim) === undefined) &&
    tokens.access_token
  ) {
    try {
      const info = await oidc.fetchUserInfo(configuration, tokens.access_token, String(claims.sub));
      merged = {
        ...info,
        ...claims,
        ...(claims.email ? {} : { email: info.email, email_verified: info.email_verified }),
      };
      if (claimPath(claims, config.groupsClaim) === undefined) {
        merged[config.groupsClaim] = claimPath(info as Record<string, unknown>, config.groupsClaim);
      }
    } catch (err) {
      deps.logger.debug({ err }, 'userinfo not available');
    }
  }
  const profile = profileFromClaims(row, config, merged);
  if (!profile.subject) throw new AppError('sso_login_failed', { reason: 'no_sub' });
  if (row.preset === 'entra') profile.groups = await entraGroups(deps, row, merged, profile.groups);
  const result = await provisionUser(deps, userCreatorOf(deps), row, profile, req);
  return finishBrowserSignIn(
    deps,
    c,
    {
      userId: result.userId,
      orgId: result.orgId,
      providerId: row.id,
      mfaTrusted: row.trustIdpMfa && profile.mfa === true,
      idToken: tokens.id_token ?? null,
      callbackUrl: state.callbackUrl,
      via: 'oidc',
    },
    req,
  );
}

// ---- SAML ---------------------------------------------------------------------------------

function splitCerts(value: string) {
  const pems = value.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  if (pems?.length) return pems;
  return value
    .split(/\n\s*\n/)
    .map((s) => s.replace(/\s+/g, ''))
    .filter(Boolean);
}

function samlClient(env: Env, row: Pick<ProviderRow, 'id' | 'kind'>, config: SamlIdpConfig) {
  return new SAML({
    callbackUrl: callbackUrl(env, row)!,
    entryPoint: config.entryPoint,
    issuer: samlEntityId(env, row.id),
    audience: samlEntityId(env, row.id),
    idpCert: splitCerts(config.idpCert),
    idpIssuer: config.idpIssuer,
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    // RelayState carries our own one-time state; node-saml's cache is per process.
    validateInResponseTo: ValidateInResponseTo.never,
    disableRequestedAuthnContext: true,
    identifierFormat: null,
    acceptedClockSkewMs: 60_000,
  });
}

export async function startSaml(
  deps: Deps,
  row: SamlRow,
  target: { callbackUrl: string; errorCallbackUrl: string },
) {
  const relay = randomBytes(24).toString('base64url');
  await pruneStates(deps.db);
  await deps.db.insert(identityAuthStates).values({
    orgId: row.orgId,
    providerId: row.id,
    stateHash: sha256(relay),
    callbackUrl: target.callbackUrl,
    errorCallbackUrl: target.errorCallbackUrl,
    expiresAt: new Date(Date.now() + STATE_TTL_MS),
  });
  return samlClient(deps.env, row, configOf(row)).getAuthorizeUrlAsync(relay, undefined, {});
}

function attr(profile: Profile, name: string): unknown {
  const p = profile as Record<string, unknown>;
  if (name in p) return p[name];
  const attributes = p.attributes as Record<string, unknown> | undefined;
  return attributes?.[name];
}

export async function completeSaml(
  deps: Deps,
  c: Context<AppEnv>,
  row: SamlRow,
  state: typeof identityAuthStates.$inferSelect,
  form: Record<string, string>,
  req: RequestInfo,
) {
  const config = configOf(row);
  let profile: Profile | null;
  try {
    ({ profile } = await samlClient(deps.env, row, config).validatePostResponseAsync(form));
  } catch (err) {
    deps.logger.warn({ err, provider: row.id }, 'SAML response rejected');
    throw new AppError('sso_login_failed');
  }
  if (!profile?.nameID) throw new AppError('sso_login_failed', { reason: 'no_name_id' });
  const emailValue = asList(attr(profile, config.emailAttribute))[0] ?? null;
  const email =
    (emailValue ?? (profile.nameID.includes('@') ? profile.nameID : null))?.toLowerCase() ?? null;
  const external: ExternalProfile = {
    subject: profile.nameID,
    email,
    // The IdP signed the assertion; its directory is the org's own.
    emailVerified: Boolean(email),
    name: asList(attr(profile, config.nameAttribute))[0] ?? null,
    groups: asList(attr(profile, config.groupsAttribute)),
    mfa: /MultiFactor|mfa|TimeSyncToken|X509/i.test(
      String(attr(profile, 'http://schemas.microsoft.com/claims/authnmethodsreferences') ?? ''),
    ),
  };
  const result = await provisionUser(deps, userCreatorOf(deps), row, external, req);
  return finishBrowserSignIn(
    deps,
    c,
    {
      userId: result.userId,
      orgId: result.orgId,
      providerId: row.id,
      mfaTrusted: row.trustIdpMfa && external.mfa === true,
      nameId: profile.nameID,
      sessionIndex: profile.sessionIndex ?? null,
      callbackUrl: state.callbackUrl,
      via: 'saml',
    },
    req,
  );
}

export function samlMetadata(env: Env, row: SamlRow) {
  return samlClient(env, row, configOf(row)).generateServiceProviderMetadata(null, null);
}

// ---- failures, logout, test ---------------------------------------------------------------

export async function auditFailure(
  deps: Deps,
  row: ProviderRow | null,
  code: string,
  req: RequestInfo,
) {
  await identityAudit(
    deps.db,
    {
      orgId: row?.orgId ?? null,
      actorId: null,
      action: 'identity.sso.login_failed',
      targetType: 'identity_provider',
      ...(row ? { targetId: row.id } : {}),
      meta: { code },
    },
    req,
  );
}

/** IdP end-session URL for a session that came from an IdP which asks for it (RP-initiated logout). */
export async function logoutTarget(
  deps: Deps,
  sessionId: string,
  postLogoutUrl: string | undefined,
) {
  const [link] = await deps.db
    .select()
    .from(identitySessions)
    .where(eq(identitySessions.sessionId, sessionId));
  if (!link) return null;
  const row = await findProvider(deps.db, link.providerId);
  if (!row || !row.enabled) return null;
  const after = safeWebTarget(deps.env, postLogoutUrl, '/login');
  if (row.kind === 'oidc') {
    const config = configOf(row as OidcRow);
    if (!config.endSessionOnLogout) return null;
    try {
      const configuration = await oidcConfiguration(
        deps.env,
        providerCacheKey(row),
        config,
        secretOf(deps.env, row),
      );
      if (!configuration.serverMetadata().end_session_endpoint) return null;
      const params: Record<string, string> = {
        post_logout_redirect_uri: after,
        client_id: config.clientId,
      };
      if (link.idToken) params.id_token_hint = link.idToken;
      return oidc.buildEndSessionUrl(configuration, params).href;
    } catch {
      return null;
    }
  }
  if (row.kind === 'saml') {
    const config = configOf(row as SamlRow);
    return config.endSessionOnLogout && config.logoutUrl ? config.logoutUrl : null;
  }
  return null;
}

export async function testOidc(
  env: Env,
  config: OidcIdpConfig,
  secret: string | null,
): Promise<IdpTestResult> {
  const steps: IdpTestResult['steps'] = [];
  const t0 = performance.now();
  try {
    const configuration = await oidcConfiguration(env, null, config, secret);
    const meta = configuration.serverMetadata();
    steps.push({
      key: 'discovery',
      ok: true,
      detail: meta.issuer,
      ms: Math.round(performance.now() - t0),
    });
    const t1 = performance.now();
    if (meta.jwks_uri) {
      const res = await fetch(meta.jwks_uri, { signal: AbortSignal.timeout(8000) });
      const keys = res.ok ? (((await res.json()) as { keys?: unknown[] }).keys?.length ?? 0) : 0;
      steps.push({
        key: 'jwks',
        ok: res.ok && keys > 0,
        detail: `${keys}`,
        ms: Math.round(performance.now() - t1),
      });
    }
    steps.push({
      key: 'endpoints',
      ok: Boolean(meta.authorization_endpoint && meta.token_endpoint),
      detail: meta.end_session_endpoint ? 'end_session' : null,
      ms: 0,
    });
  } catch (err) {
    steps.push({
      key: 'discovery',
      ok: false,
      detail: err instanceof Error ? err.message.slice(0, 500) : String(err),
      ms: Math.round(performance.now() - t0),
    });
  }
  return { ok: steps.every((s) => s.ok), steps, user: null };
}

export function testSaml(env: Env, config: SamlIdpConfig): IdpTestResult {
  const steps: IdpTestResult['steps'] = [];
  try {
    const certs = splitCerts(config.idpCert);
    samlClient(env, { id: '00000000-0000-0000-0000-000000000000', kind: 'saml' }, config);
    steps.push({ key: 'certificate', ok: certs.length > 0, detail: `${certs.length}`, ms: 0 });
  } catch (err) {
    steps.push({
      key: 'certificate',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
      ms: 0,
    });
  }
  return { ok: steps.every((s) => s.ok), steps, user: null };
}

export { findProvider };
