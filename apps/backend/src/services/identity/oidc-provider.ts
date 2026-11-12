import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
  oidcAuthCodes,
  oidcClients,
  oidcConsents,
  oidcRefreshTokens,
  orgMembers,
  organizations,
  passkeys,
  sessions,
  spaceMembers,
  spaces,
  users,
  type DbOrTx,
} from '@crewhall/db';
import {
  IDENTITY_RAW_PATHS,
  OIDC_CONSENT_WEB_PATH,
  OIDC_SCOPES,
  type OidcAuthorizeRequest,
  type OidcConsentInfo,
  type OidcScope,
  paths,
} from '@crewhall/shared';
import { resolveLocale } from '@crewhall/i18n';
import { SignJWT, decodeProtectedHeader, jwtVerify, type JWTPayload } from 'jose';
import type { Context } from 'hono';
import { deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import type { Deps } from '../../deps';
import type { Env } from '../../env';
import { clientIp } from '../../http/client-ip';
import { AppError } from '../../http/errors';
import type { AppEnv, AuthSession, AuthUser, MemberRow, OrgRow } from '../../http/types';
import { needsTwoFactorEnrolment, sessionHasTrustedMfa } from '../membership';
import { take } from '../mcp/rate-limit';
import { identityAudit } from './audit';
import {
  OIDC_PREFIX,
  newSecret,
  pkceMatches,
  safeEqual,
  sha256,
  signValue,
  verifySigned,
} from './crypto';
import { ensureKey, privateKeyOf, publicKeyFor } from './oidc-keys';
import { oidcSettings } from './policy';

/**
 * Crewhall as an OpenID Connect provider (design 9.12-9.13, doc 17 §2 "Dış uygulama → api"):
 * authorization code + PKCE, RS256 id_token and JWT access tokens, userinfo, rotating refresh
 * tokens (offline_access), RP-initiated logout. The person signs in to Crewhall itself, so the
 * org's 2FA policy applies before any code is issued.
 */

export const ACCESS_TOKEN_SECONDS = 15 * 60;
export const ID_TOKEN_SECONDS = 60 * 60;
const CODE_TTL_MS = 60_000;
const REFRESH_DAYS = 30;
const CONSENT_TOKEN_TTL_MS = 10 * 60 * 1000;

export const issuerOf = (env: Env) => env.API_URL.replace(/\/+$/, '');

export function discoveryDocument(env: Env) {
  const iss = issuerOf(env);
  return {
    issuer: iss,
    authorization_endpoint: `${iss}${IDENTITY_RAW_PATHS.oidcAuthorize}`,
    token_endpoint: `${iss}${IDENTITY_RAW_PATHS.oidcToken}`,
    userinfo_endpoint: `${iss}${IDENTITY_RAW_PATHS.oidcUserinfo}`,
    jwks_uri: `${iss}${IDENTITY_RAW_PATHS.oidcJwks}`,
    end_session_endpoint: `${iss}${IDENTITY_RAW_PATHS.oidcEndSession}`,
    revocation_endpoint: `${iss}${IDENTITY_RAW_PATHS.oidcRevoke}`,
    scopes_supported: [...OIDC_SCOPES],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    revocation_endpoint_auth_methods_supported: [
      'client_secret_basic',
      'client_secret_post',
      'none',
    ],
    code_challenge_methods_supported: ['S256'],
    prompt_values_supported: ['none', 'consent'],
    claims_supported: [
      'sub',
      'iss',
      'aud',
      'exp',
      'iat',
      'auth_time',
      'nonce',
      'sid',
      'amr',
      'email',
      'email_verified',
      'name',
      'preferred_username',
      'picture',
      'locale',
      'org',
      'org_id',
      'roles',
      'groups',
    ],
    claims_parameter_supported: false,
    request_parameter_supported: false,
    request_uri_parameter_supported: false,
    authorization_response_iss_parameter_supported: true,
    frontchannel_logout_supported: false,
    backchannel_logout_supported: false,
  };
}

type ClientRow = typeof oidcClients.$inferSelect;

const isPublic = (client: Pick<ClientRow, 'type'>) => client.type !== 'web';

export async function clientByClientId(db: DbOrTx, clientId: string) {
  const [row] = await db.select().from(oidcClients).where(eq(oidcClients.clientId, clientId));
  return row ?? null;
}

// ---- authorization request ---------------------------------------------------------------

type Problem =
  | 'unknown_client'
  | 'bad_redirect_uri'
  | 'unsupported_response_type'
  | 'invalid_scope'
  | 'pkce_required'
  | 'invalid_request'
  | 'client_disabled';

const UNSAFE: Problem[] = ['unknown_client', 'bad_redirect_uri'];

const OAUTH_ERROR: Record<Problem, string> = {
  unknown_client: 'invalid_client',
  bad_redirect_uri: 'invalid_request',
  unsupported_response_type: 'unsupported_response_type',
  invalid_scope: 'invalid_scope',
  pkce_required: 'invalid_request',
  invalid_request: 'invalid_request',
  client_disabled: 'unauthorized_client',
};

export function grantedScopes(
  client: Pick<ClientRow, 'scopes'>,
  scope: string | undefined,
): OidcScope[] {
  const requested = new Set((scope ?? '').split(/\s+/).filter(Boolean));
  return OIDC_SCOPES.filter(
    (s) => requested.has(s) && (s === 'openid' || client.scopes.includes(s)),
  );
}

export async function checkAuthorize(
  db: DbOrTx,
  q: Partial<OidcAuthorizeRequest>,
): Promise<{ client: ClientRow | null; problem: Problem | null; scopes: OidcScope[] }> {
  const client = q.client_id ? await clientByClientId(db, q.client_id) : null;
  if (!client) return { client: null, problem: 'unknown_client', scopes: [] };
  if (!q.redirect_uri || !client.redirectUris.includes(q.redirect_uri)) {
    return { client, problem: 'bad_redirect_uri', scopes: [] };
  }
  if (!client.enabled) return { client, problem: 'client_disabled', scopes: [] };
  if (q.response_type !== 'code')
    return { client, problem: 'unsupported_response_type', scopes: [] };
  const scopes = grantedScopes(client, q.scope);
  if (!scopes.includes('openid')) return { client, problem: 'invalid_scope', scopes };
  if (q.code_challenge) {
    if (q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge)) {
      return { client, problem: 'invalid_request', scopes };
    }
  } else if (isPublic(client)) {
    return { client, problem: 'pkce_required', scopes };
  }
  return { client, problem: null, scopes };
}

function withParams(uri: string, params: Record<string, string | undefined>) {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  return url.href;
}

function errorPage(c: Context<AppEnv>, problem: string) {
  const locale = resolveLocale(c.req.header('accept-language'));
  const message =
    locale === 'tr'
      ? 'Giriş isteği geçersiz: uygulama ya da geri dönüş adresi tanınmıyor. Uygulamaya dönüp yeniden dene.'
      : 'Invalid sign-in request: unknown application or redirect address. Go back to the application and try again.';
  c.header('Cache-Control', 'no-store');
  return c.html(
    `<!doctype html><html lang="${locale}"><meta charset="utf-8"><title>Crewhall</title><body style="font-family:system-ui;padding:40px;max-width:560px"><h1 style="font-size:20px">${problem}</h1><p>${message}</p></body></html>`,
    400,
  );
}

interface Person {
  user: AuthUser;
  session: AuthSession;
  org: OrgRow;
  member: MemberRow;
}

async function personFor(deps: Deps, client: ClientRow, user: AuthUser, session: AuthSession) {
  const [row] = await deps.db
    .select({ org: organizations, member: orgMembers })
    .from(orgMembers)
    .innerJoin(organizations, eq(organizations.id, orgMembers.organizationId))
    .where(
      and(
        eq(orgMembers.userId, user.id),
        eq(orgMembers.organizationId, client.orgId),
        eq(orgMembers.status, 'active'),
      ),
    );
  return row ? { user, session, org: row.org, member: row.member } : null;
}

/** Who may sign in to this client (9.12: all members or one space; guests only when allowed). */
async function accessAllowed(deps: Deps, client: ClientRow, person: Person) {
  if (person.member.role === 'guest') {
    const settings = await oidcSettings(deps.db, client.orgId);
    if (!settings.guestsAllowed || !client.guestsAllowed) return false;
  }
  if (client.accessSpaceId) {
    const [row] = await deps.db
      .select({ role: spaceMembers.role })
      .from(spaceMembers)
      .where(
        and(
          eq(spaceMembers.spaceId, client.accessSpaceId),
          eq(spaceMembers.userId, person.user.id),
        ),
      );
    if (!row) return false;
  }
  return true;
}

async function consentCovers(deps: Deps, client: ClientRow, userId: string, scopes: OidcScope[]) {
  const settings = await oidcSettings(deps.db, client.orgId);
  if (settings.skipConsentForInternal && client.skipConsent) return true;
  const [row] = await deps.db
    .select({ scopes: oidcConsents.scopes })
    .from(oidcConsents)
    .where(and(eq(oidcConsents.clientId, client.id), eq(oidcConsents.userId, userId)));
  return Boolean(row && scopes.every((s) => row.scopes.includes(s)));
}

async function amrOf(deps: Deps, user: AuthUser, session: AuthSession) {
  if (await sessionHasTrustedMfa(deps.db, session.id)) return ['mfa'];
  const [pk] = await deps.db
    .select({ id: passkeys.id })
    .from(passkeys)
    .where(eq(passkeys.userId, user.id))
    .limit(1);
  return user.twoFactorEnabled || pk ? ['pwd', 'mfa'] : ['pwd'];
}

async function issueCode(
  deps: Deps,
  client: ClientRow,
  person: Person,
  q: OidcAuthorizeRequest,
  scopes: OidcScope[],
) {
  const code = newSecret(OIDC_PREFIX.code, 40);
  await deps.db.insert(oidcAuthCodes).values({
    orgId: client.orgId,
    codeHash: sha256(code),
    clientId: client.id,
    userId: person.user.id,
    sessionId: person.session.id,
    redirectUri: q.redirect_uri,
    scopes,
    nonce: q.nonce ?? null,
    codeChallenge: q.code_challenge ?? null,
    authTime: new Date(person.session.createdAt),
    amr: await amrOf(deps, person.user, person.session),
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });
  return withParams(q.redirect_uri, { code, state: q.state, iss: issuerOf(deps.env) });
}

/**
 * GET /api/oidc/authorize: silent approval when a Crewhall session exists and nothing needs the
 * person (consent given or skipped, access allowed, 2FA policy met); otherwise the web consent
 * page (/sso/consent), which signs in first when needed.
 */
export async function handleAuthorize(c: Context<AppEnv>, deps: Deps) {
  const q = c.req.query() as Partial<OidcAuthorizeRequest> & Record<string, string>;
  const check = await checkAuthorize(deps.db, q);
  if (check.problem && UNSAFE.includes(check.problem)) return errorPage(c, check.problem);
  if (check.problem) {
    return c.redirect(
      withParams(q.redirect_uri!, {
        error: OAUTH_ERROR[check.problem],
        error_description: check.problem,
        state: q.state,
        iss: issuerOf(deps.env),
      }),
      302,
    );
  }
  const client = check.client!;
  const request = q as OidcAuthorizeRequest;
  const prompt = new Set((q.prompt ?? '').split(/\s+/).filter(Boolean));
  const fail = (error: string) =>
    c.redirect(
      withParams(request.redirect_uri, { error, state: q.state, iss: issuerOf(deps.env) }),
      302,
    );

  const auth = await deps.auth.api.getSession({ headers: c.req.raw.headers });
  if (auth && !prompt.has('consent') && !prompt.has('login')) {
    const person = await personFor(
      deps,
      client,
      auth.user as AuthUser,
      auth.session as AuthSession,
    );
    if (person) {
      const allowed = await accessAllowed(deps, client, person);
      if (!allowed) return prompt.has('none') ? fail('access_denied') : toConsentPage(c, deps, q);
      const needs2fa = await needsTwoFactorEnrolment(
        deps.db,
        person.org,
        person.member,
        person.user,
        person.session.id,
      );
      if (!needs2fa && (await consentCovers(deps, client, person.user.id, check.scopes))) {
        const target = await issueCode(deps, client, person, request, check.scopes);
        await recordLogin(deps, client, person, c);
        return c.redirect(target, 302);
      }
      if (prompt.has('none')) return fail(needs2fa ? 'interaction_required' : 'consent_required');
    } else if (prompt.has('none')) {
      return fail('access_denied');
    }
  } else if (prompt.has('none')) {
    return fail('login_required');
  }
  return toConsentPage(c, deps, q);
}

function toConsentPage(c: Context<AppEnv>, deps: Deps, q: Record<string, string>) {
  const target = new URL(OIDC_CONSENT_WEB_PATH, deps.env.HUB_URL);
  for (const [k, v] of Object.entries(q)) target.searchParams.set(k, v);
  return c.redirect(target.href, 302);
}

async function recordLogin(
  deps: Deps,
  client: ClientRow,
  person: Person,
  c: Context<AppEnv> | null,
) {
  await deps.db
    .update(oidcClients)
    .set({ lastLoginAt: new Date(), lastLoginUserId: person.user.id })
    .where(eq(oidcClients.id, client.id));
  await identityAudit(
    deps.db,
    {
      orgId: client.orgId,
      actorId: person.user.id,
      action: 'oidc.login',
      targetType: 'oidc_client',
      targetId: client.id,
      meta: { client: client.name, clientId: client.clientId },
    },
    c ? { ip: clientIp(c), userAgent: c.req.header('user-agent') ?? null } : null,
  );
}

// ---- consent page (contract endpoints) ---------------------------------------------------

export interface ConsentCtx {
  deps: Deps;
  org: OrgRow;
  member: MemberRow;
  user: AuthUser;
  session: AuthSession;
}

function requestHash(q: OidcAuthorizeRequest) {
  return sha256(
    [
      q.client_id,
      q.redirect_uri,
      q.scope,
      q.state ?? '',
      q.nonce ?? '',
      q.code_challenge ?? '',
    ].join('\n'),
  );
}

const consentPayload = (ctx: ConsentCtx, q: OidcAuthorizeRequest) =>
  `oidc-consent|${ctx.session.id}|${ctx.user.id}|${requestHash(q)}`;

async function validConsent(ctx: ConsentCtx, q: OidcAuthorizeRequest) {
  const check = await checkAuthorize(ctx.deps.db, q);
  if (check.problem) throw new AppError('oidc_consent_invalid', { reason: check.problem });
  const client = check.client!;
  if (client.orgId !== ctx.org.id)
    throw new AppError('oidc_access_denied', { reason: 'other_org' });
  const person: Person = { user: ctx.user, session: ctx.session, org: ctx.org, member: ctx.member };
  if (!(await accessAllowed(ctx.deps, client, person))) throw new AppError('oidc_access_denied');
  return { client, scopes: check.scopes, person };
}

export async function getConsent(
  ctx: ConsentCtx,
  q: OidcAuthorizeRequest,
): Promise<OidcConsentInfo> {
  const { client, scopes } = await validConsent(ctx, q);
  return {
    client: {
      name: client.name,
      clientId: client.clientId,
      logoUrl: client.logoUrl,
      homepageUrl: client.homepageUrl,
      redirectHost: new URL(q.redirect_uri).host,
    },
    user: { name: ctx.user.name, email: ctx.user.email, orgName: ctx.org.branding.orgName },
    scopes: scopes.map((scope) => ({ scope, required: scope === 'openid' })),
    autoApprove: await consentCovers(ctx.deps, client, ctx.user.id, scopes),
    consentToken: signValue(ctx.deps.env.AUTH_SECRET, consentPayload(ctx, q), CONSENT_TOKEN_TTL_MS),
  };
}

function checkConsentToken(ctx: ConsentCtx, q: OidcAuthorizeRequest, token: string) {
  const payload = verifySigned(ctx.deps.env.AUTH_SECRET, token);
  if (!payload || !safeEqual(payload, consentPayload(ctx, q))) {
    throw new AppError('oidc_consent_invalid', { reason: 'consent_token' });
  }
}

function checkOrigin(ctx: ConsentCtx, origin: string | undefined) {
  if (!origin) return;
  const allowed = [ctx.deps.env.HUB_URL, ...ctx.deps.env.WEB_ORIGINS].map((o) => new URL(o).origin);
  if (!allowed.includes(origin)) throw new AppError('forbidden', { reason: 'origin' });
}

export async function approveConsent(
  ctx: ConsentCtx,
  input: OidcAuthorizeRequest & { consentToken: string },
  origin: string | undefined,
  c: Context<AppEnv>,
) {
  checkOrigin(ctx, origin);
  checkConsentToken(ctx, input, input.consentToken);
  const { client, scopes, person } = await validConsent(ctx, input);
  await ctx.deps.db
    .insert(oidcConsents)
    .values({ orgId: client.orgId, clientId: client.id, userId: ctx.user.id, scopes })
    .onConflictDoUpdate({
      target: [oidcConsents.clientId, oidcConsents.userId],
      set: {
        scopes: sql`(select array_agg(distinct s) from unnest(${oidcConsents.scopes} || ${sql.param(scopes)}::text[]) s)`,
      },
    });
  await identityAudit(ctx.deps.db, {
    orgId: client.orgId,
    actorId: ctx.user.id,
    action: 'oidc.consent',
    targetType: 'oidc_client',
    targetId: client.id,
    meta: { scopes },
  });
  const redirectTo = await issueCode(ctx.deps, client, person, input, scopes);
  await recordLogin(ctx.deps, client, person, c);
  return { redirectTo };
}

export async function denyConsent(
  ctx: ConsentCtx,
  input: OidcAuthorizeRequest & { consentToken: string },
  origin: string | undefined,
) {
  checkOrigin(ctx, origin);
  checkConsentToken(ctx, input, input.consentToken);
  const check = await checkAuthorize(ctx.deps.db, input);
  if (check.problem) throw new AppError('oidc_consent_invalid', { reason: check.problem });
  return {
    redirectTo: withParams(input.redirect_uri, {
      error: 'access_denied',
      state: input.state,
      iss: issuerOf(ctx.deps.env),
    }),
  };
}

// ---- token endpoint ------------------------------------------------------------------------

const oauthJson = (c: Context<AppEnv>, status: number, body: object) => {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  return c.json(body, status as 200);
};
const oauthError = (c: Context<AppEnv>, status: number, error: string, description?: string) =>
  oauthJson(c, status, { error, ...(description ? { error_description: description } : {}) });

async function limited(c: Context<AppEnv>, deps: Deps, kind: string, perMinute: number) {
  const ip = clientIp(c);
  if (!ip) return null;
  const r = await take(deps.db, `ip:${ip}`, { kind, perMinute });
  if (r.allowed) return null;
  c.header('Retry-After', String(r.retryAfter));
  return oauthError(c, 429, 'slow_down', 'Too many requests');
}

async function readForm(c: Context<AppEnv>): Promise<Record<string, string>> {
  const type = c.req.header('content-type') ?? '';
  if (type.includes('application/json')) {
    const json = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(json).filter((e): e is [string, string] => typeof e[1] === 'string'),
    );
  }
  return Object.fromEntries(new URLSearchParams(await c.req.text()));
}

/** client_secret_basic, client_secret_post, or none (public clients). */
async function authenticateClient(
  c: Context<AppEnv>,
  db: DbOrTx,
  form: Record<string, string>,
): Promise<ClientRow | null> {
  let clientId = form.client_id;
  let secret = form.client_secret;
  const header = c.req.header('authorization');
  if (header?.toLowerCase().startsWith('basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    if (i > 0) {
      clientId = decodeURIComponent(decoded.slice(0, i));
      secret = decodeURIComponent(decoded.slice(i + 1));
    }
  }
  if (!clientId) return null;
  const client = await clientByClientId(db, clientId);
  if (!client) return null;
  if (isPublic(client)) return client;
  if (!secret || !client.clientSecretHash || !safeEqual(sha256(secret), client.clientSecretHash))
    return null;
  if (client.secretExpiresAt && client.secretExpiresAt < new Date()) return null;
  return client;
}

async function userClaims(
  db: DbOrTx,
  client: ClientRow,
  userId: string,
  scopes: string[],
): Promise<Record<string, unknown> | null> {
  const [row] = await db
    .select({ user: users, member: orgMembers, org: organizations })
    .from(users)
    .innerJoin(
      orgMembers,
      and(eq(orgMembers.userId, users.id), eq(orgMembers.organizationId, client.orgId)),
    )
    .innerJoin(organizations, eq(organizations.id, orgMembers.organizationId))
    .where(and(eq(users.id, userId), eq(orgMembers.status, 'active')));
  if (!row) return null;
  const claims: Record<string, unknown> = { sub: row.user.id };
  if (scopes.includes('email')) {
    claims.email = row.user.email;
    claims.email_verified = row.user.emailVerified;
  }
  if (scopes.includes('profile')) {
    claims.name = row.user.name;
    claims.preferred_username = row.user.email;
    if (row.user.image) claims.picture = row.user.image;
    claims.locale = resolveLocale(row.user.locale);
    claims.org = row.org.slug;
    claims.org_id = row.org.id;
    claims.roles = [row.member.role];
  }
  if (scopes.includes('groups')) {
    const list = await db
      .select({ slug: spaces.slug })
      .from(spaceMembers)
      .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
      .where(
        and(
          eq(spaceMembers.userId, userId),
          eq(spaces.orgId, client.orgId),
          eq(spaces.kind, 'shared'),
          isNull(spaces.archivedAt),
        ),
      )
      .orderBy(asc(spaces.slug));
    claims.groups = list.map((s) => s.slug);
    claims.roles = [row.member.role];
    claims.org = row.org.slug;
  }
  return claims;
}

const atHash = (accessToken: string) =>
  createHash('sha256').update(accessToken).digest().subarray(0, 16).toString('base64url');

/**
 * Identity claims repeated in the access token, for APIs that see only that token. Each one is
 * present only when the granted scopes produced it. `groups` stays out because it can grow large.
 */
const ACCESS_TOKEN_CLAIMS = ['email', 'name', 'preferred_username', 'roles'] as const;

async function signTokens(
  deps: Deps,
  client: ClientRow,
  input: {
    userId: string;
    scopes: string[];
    authTime: Date;
    amr: string[];
    nonce?: string | null;
    sessionId?: string | null;
  },
  claims: Record<string, unknown>,
) {
  const key = await ensureKey(deps.db, deps.env, client.orgId);
  const priv = privateKeyOf(deps.env, key);
  const iss = issuerOf(deps.env);
  const now = Math.floor(Date.now() / 1000);
  const accessToken = await new SignJWT({
    ...Object.fromEntries(
      ACCESS_TOKEN_CLAIMS.filter((name) => claims[name] !== undefined).map((name) => [
        name,
        claims[name],
      ]),
    ),
    scope: input.scopes.join(' '),
    client_id: client.clientId,
    ...(input.sessionId ? { sid: input.sessionId } : {}),
  })
    .setProtectedHeader({ alg: 'RS256', kid: key.kid, typ: 'at+jwt' })
    .setIssuer(iss)
    .setSubject(input.userId)
    .setAudience(client.clientId)
    .setIssuedAt(now)
    .setExpirationTime(now + ACCESS_TOKEN_SECONDS)
    .setJti(randomUUID())
    .sign(priv);
  const idToken = await new SignJWT({
    ...claims,
    auth_time: Math.floor(input.authTime.getTime() / 1000),
    amr: input.amr,
    at_hash: atHash(accessToken),
    azp: client.clientId,
    ...(input.nonce ? { nonce: input.nonce } : {}),
    ...(input.sessionId ? { sid: input.sessionId } : {}),
  })
    .setProtectedHeader({ alg: 'RS256', kid: key.kid, typ: 'JWT' })
    .setIssuer(iss)
    .setSubject(input.userId)
    .setAudience(client.clientId)
    .setIssuedAt(now)
    .setExpirationTime(now + ID_TOKEN_SECONDS)
    .sign(priv);
  return { accessToken, idToken };
}

async function issueRefresh(
  db: DbOrTx,
  client: ClientRow,
  input: {
    userId: string;
    scopes: string[];
    authTime: Date;
    amr: string[];
    sessionId: string | null;
  },
  prevHash: string | null,
) {
  const token = newSecret(OIDC_PREFIX.refresh, 48);
  const [row] = await db
    .insert(oidcRefreshTokens)
    .values({
      orgId: client.orgId,
      clientId: client.id,
      userId: input.userId,
      sessionId: input.sessionId,
      tokenHash: sha256(token),
      prevTokenHash: prevHash,
      scopes: input.scopes,
      authTime: input.authTime,
      amr: input.amr,
      expiresAt: new Date(Date.now() + REFRESH_DAYS * 24 * 60 * 60 * 1000),
    })
    .returning({ id: oidcRefreshTokens.id });
  return { token, id: row!.id };
}

const TokenRequest = z.discriminatedUnion('grant_type', [
  z.object({
    grant_type: z.literal('authorization_code'),
    code: z.string().min(1).max(200),
    redirect_uri: z.string().min(1).max(2000),
    code_verifier: z.string().max(200).optional(),
  }),
  z.object({
    grant_type: z.literal('refresh_token'),
    refresh_token: z.string().min(1).max(200),
    scope: z.string().max(1000).optional(),
  }),
]);

export async function stillAllowed(deps: Pick<Deps, 'db'>, client: ClientRow, userId: string) {
  if (!client.enabled) return false;
  const [row] = await deps.db
    .select({ member: orgMembers, user: users })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.userId))
    .where(
      and(
        eq(orgMembers.userId, userId),
        eq(orgMembers.organizationId, client.orgId),
        eq(orgMembers.status, 'active'),
      ),
    );
  if (!row) return false;
  if (row.member.role === 'guest') {
    const settings = await oidcSettings(deps.db, client.orgId);
    if (!settings.guestsAllowed || !client.guestsAllowed) return false;
  }
  if (client.accessSpaceId) {
    const [m] = await deps.db
      .select({ role: spaceMembers.role })
      .from(spaceMembers)
      .where(and(eq(spaceMembers.spaceId, client.accessSpaceId), eq(spaceMembers.userId, userId)));
    if (!m) return false;
  }
  return true;
}

export async function handleToken(c: Context<AppEnv>, deps: Deps) {
  const slow = await limited(c, deps, 'oidc_token', 60);
  if (slow) return slow;
  const form = await readForm(c);
  const client = await authenticateClient(c, deps.db, form);
  if (!client) return oauthError(c, 401, 'invalid_client');
  if (!client.enabled) return oauthError(c, 400, 'unauthorized_client');
  const parsed = TokenRequest.safeParse(form);
  if (!parsed.success) {
    const unsupported = parsed.error.issues.some((i) => i.path[0] === 'grant_type');
    return oauthError(c, 400, unsupported ? 'unsupported_grant_type' : 'invalid_request');
  }
  const body = parsed.data;
  const { db } = deps;

  if (body.grant_type === 'authorization_code') {
    const hash = sha256(body.code);
    const [code] = await db
      .update(oidcAuthCodes)
      .set({ consumedAt: new Date() })
      .where(and(eq(oidcAuthCodes.codeHash, hash), isNull(oidcAuthCodes.consumedAt)))
      .returning();
    if (!code) {
      // Replayed code: revoke what it produced (RFC 6749 §4.1.2).
      const [used] = await db.select().from(oidcAuthCodes).where(eq(oidcAuthCodes.codeHash, hash));
      if (used?.refreshTokenId) {
        await db
          .update(oidcRefreshTokens)
          .set({ revokedAt: new Date() })
          .where(eq(oidcRefreshTokens.id, used.refreshTokenId));
      }
      return oauthError(c, 400, 'invalid_grant');
    }
    if (
      code.expiresAt <= new Date() ||
      code.clientId !== client.id ||
      code.redirectUri !== body.redirect_uri ||
      (code.codeChallenge
        ? !body.code_verifier || !pkceMatches(body.code_verifier, code.codeChallenge)
        : isPublic(client))
    ) {
      return oauthError(c, 400, 'invalid_grant');
    }
    if (!(await stillAllowed(deps, client, code.userId)))
      return oauthError(c, 400, 'invalid_grant');
    const claims = await userClaims(db, client, code.userId, code.scopes);
    if (!claims) return oauthError(c, 400, 'invalid_grant');
    const tokens = await signTokens(
      deps,
      client,
      {
        userId: code.userId,
        scopes: code.scopes,
        authTime: code.authTime,
        amr: code.amr,
        nonce: code.nonce,
        sessionId: code.sessionId,
      },
      claims,
    );
    let refresh: string | undefined;
    if (code.scopes.includes('offline_access')) {
      const r = await issueRefresh(
        db,
        client,
        {
          userId: code.userId,
          scopes: code.scopes,
          authTime: code.authTime,
          amr: code.amr,
          sessionId: code.sessionId,
        },
        null,
      );
      refresh = r.token;
      await db
        .update(oidcAuthCodes)
        .set({ refreshTokenId: r.id })
        .where(eq(oidcAuthCodes.id, code.id));
    }
    return oauthJson(c, 200, {
      access_token: tokens.accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_SECONDS,
      id_token: tokens.idToken,
      scope: code.scopes.join(' '),
      ...(refresh ? { refresh_token: refresh } : {}),
    });
  }

  // refresh_token: rotate on every use; an old token coming back revokes the chain.
  const hash = sha256(body.refresh_token);
  const [current] = await db
    .select()
    .from(oidcRefreshTokens)
    .where(and(eq(oidcRefreshTokens.tokenHash, hash), eq(oidcRefreshTokens.clientId, client.id)));
  if (!current) return oauthError(c, 400, 'invalid_grant');
  if (current.revokedAt) {
    const [reused] = await db
      .select()
      .from(oidcRefreshTokens)
      .where(
        and(eq(oidcRefreshTokens.prevTokenHash, hash), eq(oidcRefreshTokens.clientId, client.id)),
      );
    if (reused) {
      await db
        .update(oidcRefreshTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(oidcRefreshTokens.userId, reused.userId),
            eq(oidcRefreshTokens.clientId, client.id),
            isNull(oidcRefreshTokens.revokedAt),
          ),
        );
      await identityAudit(db, {
        orgId: client.orgId,
        actorId: null,
        action: 'oidc.refresh_reuse',
        targetType: 'oidc_client',
        targetId: client.id,
        meta: { userId: reused.userId },
      });
    }
    return oauthError(c, 400, 'invalid_grant');
  }
  if (current.expiresAt <= new Date()) return oauthError(c, 400, 'invalid_grant');
  // Disabled client, suspended member or lost access: the session ends at this refresh (9.12).
  if (!(await stillAllowed(deps, client, current.userId))) {
    await db
      .update(oidcRefreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(oidcRefreshTokens.id, current.id));
    return oauthError(c, 400, 'invalid_grant');
  }
  const narrowed = body.scope
    ? current.scopes.filter((s) => body.scope!.split(/\s+/).includes(s))
    : current.scopes;
  const [rotated] = await db
    .update(oidcRefreshTokens)
    .set({ revokedAt: new Date(), lastUsedAt: new Date() })
    .where(and(eq(oidcRefreshTokens.id, current.id), isNull(oidcRefreshTokens.revokedAt)))
    .returning();
  if (!rotated) return oauthError(c, 400, 'invalid_grant');
  const claims = await userClaims(db, client, current.userId, narrowed);
  if (!claims) return oauthError(c, 400, 'invalid_grant');
  const input = {
    userId: current.userId,
    scopes: narrowed,
    authTime: current.authTime,
    amr: current.amr,
    sessionId: current.sessionId,
  };
  const tokens = await signTokens(deps, client, input, claims);
  const next = await issueRefresh(db, client, { ...input, scopes: current.scopes }, hash);
  return oauthJson(c, 200, {
    access_token: tokens.accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_SECONDS,
    id_token: tokens.idToken,
    scope: narrowed.join(' '),
    refresh_token: next.token,
  });
}

// ---- userinfo, revoke, logout --------------------------------------------------------------

export async function verifyOwnJwt(
  deps: Deps,
  token: string,
  opts: { allowExpired?: boolean } = {},
) {
  const { kid } = decodeProtectedHeader(token);
  if (!kid) return null;
  const key = await publicKeyFor(deps.db, kid);
  if (!key) return null;
  try {
    const { payload, protectedHeader } = await jwtVerify(token, key, {
      issuer: issuerOf(deps.env),
      algorithms: ['RS256'],
      ...(opts.allowExpired ? { currentDate: new Date(0) } : {}),
    });
    return { payload, typ: protectedHeader.typ };
  } catch {
    return null;
  }
}

export async function handleUserinfo(c: Context<AppEnv>, deps: Deps) {
  c.header('Cache-Control', 'no-store');
  const header = c.req.header('authorization') ?? '';
  let token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  if (!token && c.req.method === 'POST') token = (await readForm(c)).access_token ?? '';
  const unauthorized = () => {
    c.header('WWW-Authenticate', 'Bearer error="invalid_token"');
    return c.json({ error: 'invalid_token' }, 401);
  };
  if (!token) return unauthorized();
  const verified = await verifyOwnJwt(deps, token).catch(() => null);
  if (!verified || verified.typ !== 'at+jwt') return unauthorized();
  const payload = verified.payload as JWTPayload & { client_id?: string; scope?: string };
  const client = payload.client_id ? await clientByClientId(deps.db, payload.client_id) : null;
  if (!client || !payload.sub || !(await stillAllowed(deps, client, payload.sub)))
    return unauthorized();
  const claims = await userClaims(deps.db, client, payload.sub, (payload.scope ?? '').split(' '));
  if (!claims) return unauthorized();
  return c.json(claims);
}

export async function handleRevoke(c: Context<AppEnv>, deps: Deps) {
  const slow = await limited(c, deps, 'oidc_token', 60);
  if (slow) return slow;
  const form = await readForm(c);
  const client = await authenticateClient(c, deps.db, form);
  if (!client) return oauthError(c, 401, 'invalid_client');
  const token = form.token ?? '';
  if (token.startsWith(OIDC_PREFIX.refresh)) {
    await deps.db
      .update(oidcRefreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(oidcRefreshTokens.tokenHash, sha256(token)),
          eq(oidcRefreshTokens.clientId, client.id),
        ),
      );
  }
  // Access tokens are short-lived JWTs; RFC 7009 allows answering 200 without revoking them.
  return oauthJson(c, 200, {});
}

/**
 * RP-initiated logout (OpenID Connect RP-Initiated Logout 1.0): ends the Crewhall browser
 * session of the same person and the client's refresh tokens of that session, then returns
 * to a registered post_logout_redirect_uri (or the web login page).
 */
export async function handleEndSession(c: Context<AppEnv>, deps: Deps) {
  const q = c.req.method === 'POST' ? await readForm(c) : c.req.query();
  const hint = q.id_token_hint
    ? await verifyOwnJwt(deps, q.id_token_hint, { allowExpired: true })
    : null;
  const aud = hint?.payload.aud;
  const clientId = q.client_id ?? (Array.isArray(aud) ? aud[0] : aud);
  const client = clientId ? await clientByClientId(deps.db, clientId) : null;
  const subject = hint?.payload.sub ?? null;

  const auth = await deps.auth.api.getSession({ headers: c.req.raw.headers });
  if (auth && (!subject || subject === auth.user.id)) {
    await deps.db.delete(sessions).where(eq(sessions.id, auth.session.id));
    const ctx = await deps.auth.$context;
    deleteCookie(c, ctx.authCookies.sessionToken.name, { path: '/' });
    if (client) {
      await deps.db
        .update(oidcRefreshTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(oidcRefreshTokens.clientId, client.id),
            eq(oidcRefreshTokens.sessionId, auth.session.id),
            isNull(oidcRefreshTokens.revokedAt),
          ),
        );
      await identityAudit(deps.db, {
        orgId: client.orgId,
        actorId: auth.user.id,
        action: 'oidc.logout',
        targetType: 'oidc_client',
        targetId: client.id,
      });
    }
  }
  const post = q.post_logout_redirect_uri;
  if (post && client && client.postLogoutRedirectUris.includes(post)) {
    return c.redirect(withParams(post, { state: q.state }), 302);
  }
  return c.redirect(new URL(paths.login(), deps.env.HUB_URL).href, 302);
}

/** Logins per client in the last 7 days (9.12 "Son 7 gün SSO girişleri"). */
export async function loginCounts(db: DbOrTx, orgId: string, clientIds: string[]) {
  if (!clientIds.length) return new Map<string, number>();
  const rows = await db.execute<{ target_id: string; n: number }>(
    sql`select target_id, count(*)::int as n from audit_logs
        where org_id = ${orgId} and action = 'oidc.login' and at > now() - interval '7 days'
        group by target_id`,
  );
  return new Map(rows.rows.map((r) => [r.target_id, r.n]));
}
