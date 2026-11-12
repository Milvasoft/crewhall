import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  mcpAccessTokens,
  mcpAuthCodes,
  mcpGrants,
  orgMembers,
  users,
  type DbOrTx,
} from '@crewhall/db';
import {
  MCP_ALWAYS_APPROVED_SCOPES,
  MCP_LIMITS,
  MCP_REQUIRED_SCOPE,
  MCP_SCOPES,
  type ConsentDecision,
  type ConsentDuration,
  type ConsentInfo,
  type ConsentRequest,
  type ConsentResult,
  type McpScope,
  paths,
} from '@crewhall/shared';
import { resolveLocale } from '@crewhall/i18n';
import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps';
import type { Env } from '../../env';
import { clientIp } from '../../http/client-ip';
import { AppError } from '../../http/errors';
import type { AppEnv, AuthSession, AuthUser, OrgRow, MemberRow } from '../../http/types';
import { mailBrandForOrg } from '../brand';
import { listMySpaces } from '../spaces';
import { mcpAudit } from './audit';
import {
  RegistrationError,
  RegistrationRequest,
  clientByClientId,
  redirectHost,
  redirectUriMatches,
  registerClient,
  type ClientRow,
} from './clients';
import { revokeGrantRow, validateSpaceIds, withRead } from './connections';
import {
  TOKEN_PREFIX,
  newSecret,
  pkceMatches,
  safeEqual,
  sha256,
  signValue,
  verifySigned,
} from './crypto';
import { newConnectionMail } from './mail';
import { getPolicy, maxLifetimeMs, moduleOn } from './policy';
import { invalidatePrincipals } from './principal';
import { take } from './rate-limit';
import { isFresh, requireFresh } from './reauth';

const DAY = 24 * 60 * 60 * 1000;
export const CODE_TTL_MS = 60_000;
const CONSENT_TOKEN_TTL_MS = 10 * 60 * 1000;

export const issuer = (env: Env) => env.API_URL.replace(/\/+$/, '');
/** The protected resource every token is bound to (RFC 8707 / RFC 9728). */
export const resourceUrl = (env: Env) => `${issuer(env)}/mcp`;
export const resourceMetadataUrl = (env: Env) =>
  `${issuer(env)}/.well-known/oauth-protected-resource/mcp`;

const normalizeResource = (r: string) => r.replace(/\/+$/, '');

export function protectedResourceMetadata(env: Env) {
  return {
    resource: resourceUrl(env),
    authorization_servers: [issuer(env)],
    scopes_supported: [...MCP_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'Crewhall',
    resource_documentation: `${env.HUB_URL}${paths.accountMcpDocs()}`,
  };
}

export function authorizationServerMetadata(env: Env) {
  const base = issuer(env);
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    revocation_endpoint_auth_methods_supported: [
      'none',
      'client_secret_post',
      'client_secret_basic',
    ],
    scopes_supported: [...MCP_SCOPES],
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${env.HUB_URL}${paths.accountMcpDocs()}`,
  };
}

const oauthJson = (c: Context<AppEnv>, status: number, body: object) => {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  return c.json(body, status as 200);
};

const oauthError = (c: Context<AppEnv>, status: number, error: string, description?: string) =>
  oauthJson(c, status, { error, ...(description ? { error_description: description } : {}) });

async function limited(c: Context<AppEnv>, deps: Deps, kind: string, perMinute: number) {
  // In-process requests (tests) have no address; every real request has one.
  const ip = clientIp(c);
  if (!ip) return null;
  const r = await take(deps.db, `ip:${ip}`, { kind, perMinute });
  if (r.allowed) return null;
  c.header('Retry-After', String(r.retryAfter));
  return oauthError(c, 429, 'slow_down', 'Too many requests');
}

// ---- dynamic client registration (RFC 7591) -------------------------------------------

export async function handleRegister(c: Context<AppEnv>, deps: Deps) {
  const slow = await limited(c, deps, 'oauth_register', 10);
  if (slow) return slow;
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return oauthError(c, 400, 'invalid_client_metadata', 'Body must be JSON');
  }
  const parsed = RegistrationRequest.safeParse(json);
  if (!parsed.success) {
    const redirect = parsed.error.issues.some((i) => i.path[0] === 'redirect_uris');
    return oauthError(
      c,
      400,
      redirect ? 'invalid_redirect_uri' : 'invalid_client_metadata',
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }
  try {
    const { client, response } = await registerClient(deps.db, parsed.data, clientIp(c));
    await mcpAudit(
      deps.db,
      {
        orgId: client.orgId,
        actorId: null,
        action: 'mcp.client.register',
        targetType: 'mcp_client',
        targetId: client.id,
        meta: { name: client.name, redirectUris: client.redirectUris, status: client.status },
      },
      { ip: clientIp(c), userAgent: c.req.header('user-agent') ?? null },
    );
    return oauthJson(c, 201, response);
  } catch (err) {
    if (err instanceof RegistrationError) return oauthError(c, 400, err.error, err.description);
    throw err;
  }
}

// ---- authorization request -------------------------------------------------------------

export type AuthorizeProblem =
  | 'unknown_client'
  | 'bad_redirect_uri'
  | 'unsupported_response_type'
  | 'pkce_required'
  | 'invalid_resource'
  | 'invalid_request';

/** Problems we must not redirect for (RFC 6749 §4.1.2.1): the redirect target is unproven. */
const UNSAFE: readonly AuthorizeProblem[] = ['unknown_client', 'bad_redirect_uri'];

export async function checkAuthorizeRequest(
  db: DbOrTx,
  env: Env,
  q: Record<string, string | undefined>,
): Promise<
  { client: ClientRow; problem: null } | { client: ClientRow | null; problem: AuthorizeProblem }
> {
  const client = q.client_id ? await clientByClientId(db, q.client_id) : null;
  if (!client) return { client: null, problem: 'unknown_client' };
  if (!q.redirect_uri || !redirectUriMatches(client.redirectUris, q.redirect_uri)) {
    return { client, problem: 'bad_redirect_uri' };
  }
  if (q.response_type !== 'code') return { client, problem: 'unsupported_response_type' };
  if (!q.code_challenge || q.code_challenge_method !== 'S256') {
    return { client, problem: 'pkce_required' };
  }
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge))
    return { client, problem: 'invalid_request' };
  if (q.resource && normalizeResource(q.resource) !== resourceUrl(env)) {
    return { client, problem: 'invalid_resource' };
  }
  return { client, problem: null };
}

const OAUTH_ERROR_FOR: Record<AuthorizeProblem, string> = {
  unknown_client: 'invalid_client',
  bad_redirect_uri: 'invalid_request',
  unsupported_response_type: 'unsupported_response_type',
  pkce_required: 'invalid_request',
  invalid_resource: 'invalid_target',
  invalid_request: 'invalid_request',
};

function withParams(uri: string, params: Record<string, string | undefined>) {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  return url.href;
}

/**
 * GET /oauth/authorize: validates what can be validated without a person, then hands the
 * browser to the web consent page (design 18.2), which signs in first when needed.
 */
export async function handleAuthorize(c: Context<AppEnv>, deps: Deps) {
  const q = c.req.query();
  const check = await checkAuthorizeRequest(deps.db, deps.env, q);
  if (check.problem && UNSAFE.includes(check.problem)) {
    const locale = resolveLocale(c.req.header('accept-language'));
    const message =
      locale === 'tr'
        ? 'Bağlantı isteği geçersiz: istemci ya da geri dönüş adresi tanınmıyor. İstemciden yeniden bağlanmayı dene.'
        : 'Invalid connection request: unknown client or redirect address. Try connecting again from the client.';
    c.header('Cache-Control', 'no-store');
    return c.html(
      `<!doctype html><html lang="${locale}"><meta charset="utf-8"><title>Crewhall</title><body style="font-family:system-ui;padding:40px;max-width:560px"><h1 style="font-size:20px">${check.problem}</h1><p>${message}</p></body></html>`,
      400,
    );
  }
  if (check.problem) {
    return c.redirect(
      withParams(q.redirect_uri!, {
        error: OAUTH_ERROR_FOR[check.problem],
        error_description: check.problem,
        state: q.state,
        iss: issuer(deps.env),
      }),
      302,
    );
  }
  const target = new URL(paths.oauthConsent(), deps.env.HUB_URL);
  for (const [k, v] of Object.entries(q)) target.searchParams.set(k, v);
  return c.redirect(target.href, 302);
}

// ---- consent (contract endpoints, called by the web consent page) ---------------------

export interface ConsentCtx {
  deps: Deps;
  org: OrgRow;
  member: MemberRow;
  user: AuthUser;
  session: AuthSession;
  ip: string | null;
}

function requestHash(q: ConsentRequest) {
  return sha256(
    [
      q.client_id,
      q.redirect_uri,
      q.code_challenge,
      q.state ?? '',
      q.resource ?? '',
      q.scope ?? '',
    ].join('\n'),
  );
}

function consentToken(ctx: ConsentCtx, q: ConsentRequest) {
  return signValue(
    ctx.deps.env.AUTH_SECRET,
    `consent|${ctx.session.id}|${ctx.user.id}|${requestHash(q)}`,
    CONSENT_TOKEN_TTL_MS,
  );
}

function checkConsentToken(ctx: ConsentCtx, q: ConsentRequest, token: string) {
  const payload = verifySigned(ctx.deps.env.AUTH_SECRET, token);
  const expected = `consent|${ctx.session.id}|${ctx.user.id}|${requestHash(q)}`;
  if (!payload || !safeEqual(payload, expected)) {
    throw new AppError('mcp_consent_invalid', { reason: 'consent_token' });
  }
}

/** Origin of a state-changing consent call must be the web app (CSRF, with the token). */
function checkOrigin(ctx: ConsentCtx, origin: string | undefined) {
  if (!origin) return;
  const allowed = [ctx.deps.env.HUB_URL, ...ctx.deps.env.WEB_ORIGINS].map((o) => new URL(o).origin);
  if (!allowed.includes(origin)) throw new AppError('forbidden', { reason: 'origin' });
}

async function validConsent(ctx: ConsentCtx, q: ConsentRequest) {
  const check = await checkAuthorizeRequest(ctx.deps.db, ctx.deps.env, q);
  if (check.problem) throw new AppError('mcp_consent_invalid', { reason: check.problem });
  const client = check.client;
  if (client.orgId && client.orgId !== ctx.org.id) {
    throw new AppError('mcp_consent_invalid', { reason: 'other_org' });
  }
  const policy = await getPolicy(ctx.deps.db, ctx.org.id);
  if (!policy.enabled || !moduleOn(ctx.org, 'mcp')) throw new AppError('mcp_disabled');
  if (ctx.member.role === 'guest' && !policy.guestsAllowed) {
    throw new AppError('mcp_guests_not_allowed');
  }
  return { client, policy };
}

function requestedScopes(scope: string | undefined): McpScope[] {
  const list = (scope ?? '')
    .split(/\s+/)
    .filter((s): s is McpScope => (MCP_SCOPES as readonly string[]).includes(s));
  return list;
}

const DURATION_DAYS: Record<ConsentDuration, number | null> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  never: null,
};

function allowedDurations(maxTokenDays: number | null): ConsentDuration[] {
  return (Object.keys(DURATION_DAYS) as ConsentDuration[]).filter((d) => {
    const days = DURATION_DAYS[d];
    if (maxTokenDays === null) return true;
    return days !== null && days <= maxTokenDays;
  });
}

export async function getConsent(ctx: ConsentCtx, q: ConsentRequest): Promise<ConsentInfo> {
  const { client, policy } = await validConsent(ctx, q);
  const requested = requestedScopes(q.scope);
  // No scope parameter: offer everything the policy allows, the person narrows it down.
  const defaults = requested.length ? requested : policy.allowedScopes;
  const scopes = MCP_SCOPES.map((scope) => ({
    scope,
    requested: scope === MCP_REQUIRED_SCOPE || defaults.includes(scope),
    allowed:
      scope === MCP_REQUIRED_SCOPE ||
      (policy.allowedScopes.includes(scope) &&
        (scope !== 'chat:send' || moduleOn(ctx.org, 'chat'))),
    required: scope === MCP_REQUIRED_SCOPE,
    // Publishing always waits for a person; trash/bulk show on their own row (18.2).
    approval: MCP_ALWAYS_APPROVED_SCOPES.includes(scope),
  }));
  const spaces = await listMySpaces(ctx.deps.db, ctx.org.id, ctx.user.id, false);
  const durations = allowedDurations(policy.maxTokenDays);
  return {
    client: {
      name: client.name,
      registration: client.registration,
      status: client.status,
      redirectUri: q.redirect_uri,
      redirectHost: redirectHost(q.redirect_uri),
    },
    user: { name: ctx.user.name, email: ctx.user.email, orgName: ctx.org.branding.orgName },
    scopes,
    spaces: spaces.map((s) => ({ id: s.id, name: s.name, kind: s.kind, color: s.color })),
    durations,
    defaultDuration: durations.includes('30d') ? '30d' : (durations[durations.length - 1] ?? '7d'),
    needsReauth: !(await isFresh(ctx.deps, ctx.session)),
    consentToken: consentToken(ctx, q),
  };
}

export async function approveConsent(
  ctx: ConsentCtx,
  input: ConsentDecision,
  origin: string | undefined,
): Promise<ConsentResult> {
  checkOrigin(ctx, origin);
  checkConsentToken(ctx, input, input.consentToken);
  const { client, policy } = await validConsent(ctx, input);
  if (client.status === 'pending') throw new AppError('mcp_client_pending');
  if (client.status === 'blocked') throw new AppError('mcp_client_blocked');
  await requireFresh(ctx.deps, ctx.session);

  const scopes = withRead(input.scopes);
  if (scopes.some((s) => s !== MCP_REQUIRED_SCOPE && !policy.allowedScopes.includes(s))) {
    throw new AppError('mcp_scope_not_allowed');
  }
  if (!allowedDurations(policy.maxTokenDays).includes(input.duration)) {
    throw new AppError('mcp_expiry_not_allowed');
  }
  const days = DURATION_DAYS[input.duration];
  const max = maxLifetimeMs(policy);
  const expiresAt =
    days === null ? null : new Date(Date.now() + Math.min(days * DAY, max ?? Infinity));
  const { db, env } = ctx.deps;
  const spaceIds = await validateSpaceIds(db, ctx.org.id, ctx.user.id, input.spaceIds);
  const code = newSecret(TOKEN_PREFIX.code, 40);

  const grant = await db.transaction(async (tx) => {
    const [g] = await tx
      .insert(mcpGrants)
      .values({
        orgId: ctx.org.id,
        userId: ctx.user.id,
        clientId: client.id,
        label: input.label?.trim() || null,
        scopes,
        spaceIds,
        resource: resourceUrl(env),
        expiresAt,
        lastIp: ctx.ip,
      })
      .returning();
    await tx.insert(mcpAuthCodes).values({
      orgId: ctx.org.id,
      codeHash: sha256(code),
      grantId: g!.id,
      clientId: client.clientId,
      redirectUri: input.redirect_uri,
      codeChallenge: input.code_challenge,
      resource: resourceUrl(env),
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    });
    return g!;
  });

  await mcpAudit(
    db,
    {
      orgId: ctx.org.id,
      actorId: ctx.user.id,
      action: 'mcp.grant.create',
      targetType: 'mcp_grant',
      targetId: grant.id,
      meta: {
        client: client.name,
        clientId: client.clientId,
        redirectUri: input.redirect_uri,
        scopes,
        spaceIds,
        expiresAt: expiresAt?.toISOString() ?? null,
      },
    },
    { ip: ctx.ip, userAgent: null },
  );
  await sendConnectionMails(ctx, client, input.redirect_uri, scopes, spaceIds, expiresAt).catch(
    (err) => ctx.deps.logger.warn({ err }, 'new MCP connection mail failed'),
  );

  return {
    grantId: grant.id,
    redirectTo: withParams(input.redirect_uri, {
      code,
      state: input.state,
      iss: issuer(env),
    }),
  };
}

export async function denyConsent(
  ctx: ConsentCtx,
  input: ConsentRequest & { consentToken: string },
  origin: string | undefined,
): Promise<ConsentResult> {
  checkOrigin(ctx, origin);
  checkConsentToken(ctx, input, input.consentToken);
  const check = await checkAuthorizeRequest(ctx.deps.db, ctx.deps.env, input);
  if (check.problem) throw new AppError('mcp_consent_invalid', { reason: check.problem });
  return {
    grantId: null,
    redirectTo: withParams(input.redirect_uri, {
      error: 'access_denied',
      state: input.state,
      iss: issuer(ctx.deps.env),
    }),
  };
}

async function sendConnectionMails(
  ctx: ConsentCtx,
  client: ClientRow,
  redirectUri: string,
  scopes: McpScope[],
  spaceIds: string[] | null,
  expiresAt: Date | null,
) {
  const { db, env, mailer } = ctx.deps;
  if (!(await mailer.enabledFor(ctx.org.id))) return;
  const brand = await mailBrandForOrg(db, env.HUB_URL, ctx.org.id);
  const spaces = spaceIds
    ? (await listMySpaces(db, ctx.org.id, ctx.user.id, false))
        .filter((s) => spaceIds.includes(s.id))
        .map((s) => s.name)
    : null;
  const base = {
    client: client.name,
    redirectUri,
    scopes,
    spaces,
    expiresAt,
    at: new Date(),
    ip: ctx.ip,
    manageUrl: `${env.HUB_URL}${paths.account('mcp')}`,
  };
  const userLocale = resolveLocale((ctx.user as { locale?: string }).locale ?? null);
  const own = newConnectionMail(brand, { ...base, locale: userLocale, name: ctx.user.name });
  await mailer.send({
    orgId: ctx.org.id,
    to: ctx.user.email,
    fromName: brand.branding.orgName,
    ...own,
  });
  // Org owners get the same security notice (design 18.3).
  const owners = await db
    .select({ email: users.email, name: users.name, locale: users.locale })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.userId))
    .where(
      and(
        eq(orgMembers.organizationId, ctx.org.id),
        eq(orgMembers.role, 'owner'),
        eq(orgMembers.status, 'active'),
      ),
    );
  for (const o of owners) {
    if (o.email === ctx.user.email) continue;
    const mail = newConnectionMail(brand, {
      ...base,
      locale: resolveLocale(o.locale),
      name: o.name,
      person: { name: ctx.user.name, email: ctx.user.email },
    });
    await mailer.send({
      orgId: ctx.org.id,
      to: o.email,
      fromName: brand.branding.orgName,
      ...mail,
    });
  }
}

// ---- token endpoint ---------------------------------------------------------------------

const TokenRequest = z.discriminatedUnion('grant_type', [
  z.object({
    grant_type: z.literal('authorization_code'),
    code: z.string().min(1).max(200),
    redirect_uri: z.string().min(1).max(2000),
    code_verifier: z.string().min(1).max(200),
    client_id: z.string().max(200).optional(),
    client_secret: z.string().max(200).optional(),
    resource: z.string().max(2000).optional(),
  }),
  z.object({
    grant_type: z.literal('refresh_token'),
    refresh_token: z.string().min(1).max(200),
    client_id: z.string().max(200).optional(),
    client_secret: z.string().max(200).optional(),
    resource: z.string().max(2000).optional(),
    scope: z.string().max(1000).optional(),
  }),
]);

async function readForm(c: Context<AppEnv>): Promise<Record<string, string>> {
  const type = c.req.header('content-type') ?? '';
  if (type.includes('application/json')) {
    const json = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(json).filter((e): e is [string, string] => typeof e[1] === 'string'),
    );
  }
  const text = await c.req.text();
  return Object.fromEntries(new URLSearchParams(text));
}

/** client_secret_basic or the body; returns the client or an error code. */
async function authenticateClient(
  c: Context<AppEnv>,
  db: DbOrTx,
  form: { client_id?: string | undefined; client_secret?: string | undefined },
) {
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
  if (client.tokenEndpointAuthMethod !== 'none') {
    if (
      !secret ||
      !client.clientSecretHash ||
      !safeEqual(sha256(secret), client.clientSecretHash)
    ) {
      return null;
    }
  }
  return client;
}

async function issueTokens(db: DbOrTx, grant: typeof mcpGrants.$inferSelect, refresh: string) {
  const access = newSecret(TOKEN_PREFIX.access, 40);
  const ttl = MCP_LIMITS.accessTokenSeconds * 1000;
  const until = grant.expiresAt
    ? new Date(Math.min(Date.now() + ttl, grant.expiresAt.getTime()))
    : new Date(Date.now() + ttl);
  await db.insert(mcpAccessTokens).values({
    orgId: grant.orgId,
    tokenHash: sha256(access),
    grantId: grant.id,
    resource: grant.resource,
    expiresAt: until,
  });
  // Old access tokens of the grant are left to expire; prune the long dead ones.
  await db.execute(
    sql`delete from ${mcpAccessTokens} where grant_id = ${grant.id} and expires_at < now() - interval '1 day'`,
  );
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: Math.max(1, Math.round((until.getTime() - Date.now()) / 1000)),
    refresh_token: refresh,
    scope: grant.scopes.join(' '),
  };
}

export async function handleToken(c: Context<AppEnv>, deps: Deps) {
  const slow = await limited(c, deps, 'oauth_token', 30);
  if (slow) return slow;
  const { db, env } = deps;
  const parsed = TokenRequest.safeParse(await readForm(c));
  if (!parsed.success) {
    const unsupported = parsed.error.issues.some((i) => i.path[0] === 'grant_type');
    return oauthError(c, 400, unsupported ? 'unsupported_grant_type' : 'invalid_request');
  }
  const form = parsed.data;
  const client = await authenticateClient(c, db, form);
  if (!client) return oauthError(c, 401, 'invalid_client');
  if (client.status !== 'allowed') return oauthError(c, 400, 'unauthorized_client');
  if (form.resource && normalizeResource(form.resource) !== resourceUrl(env)) {
    return oauthError(c, 400, 'invalid_target');
  }

  if (form.grant_type === 'authorization_code') {
    const hash = sha256(form.code);
    // Single use: the first exchange wins atomically.
    const [code] = await db
      .update(mcpAuthCodes)
      .set({ consumedAt: new Date() })
      .where(and(eq(mcpAuthCodes.codeHash, hash), isNull(mcpAuthCodes.consumedAt)))
      .returning();
    if (!code) {
      // A replayed code means it leaked: revoke what it produced (RFC 6749 §4.1.2).
      const [used] = await db.select().from(mcpAuthCodes).where(eq(mcpAuthCodes.codeHash, hash));
      if (used) await revokeGrantRow(db, used.grantId, null, 'code_reuse');
      return oauthError(c, 400, 'invalid_grant');
    }
    if (
      code.expiresAt <= new Date() ||
      code.clientId !== client.clientId ||
      code.redirectUri !== form.redirect_uri ||
      !pkceMatches(form.code_verifier, code.codeChallenge)
    ) {
      return oauthError(c, 400, 'invalid_grant');
    }
    const [grant] = await db
      .select()
      .from(mcpGrants)
      .where(and(eq(mcpGrants.id, code.grantId), isNull(mcpGrants.revokedAt)));
    if (!grant) return oauthError(c, 400, 'invalid_grant');
    const refresh = newSecret(TOKEN_PREFIX.refresh, 48);
    await db
      .update(mcpGrants)
      .set({ refreshHash: sha256(refresh), prevRefreshHash: null, lastUsedAt: new Date() })
      .where(eq(mcpGrants.id, grant.id));
    return oauthJson(c, 200, await issueTokens(db, grant, refresh));
  }

  // refresh_token: rotate on every use; a rotated-away token coming back revokes the grant.
  const hash = sha256(form.refresh_token);
  const [current] = await db
    .select()
    .from(mcpGrants)
    .where(and(eq(mcpGrants.refreshHash, hash), eq(mcpGrants.clientId, client.id)));
  if (!current) {
    const [reused] = await db.select().from(mcpGrants).where(eq(mcpGrants.prevRefreshHash, hash));
    if (reused && !reused.revokedAt) {
      await revokeGrantRow(db, reused.id, null, 'refresh_reuse');
      await mcpAudit(db, {
        orgId: reused.orgId,
        actorId: null,
        action: 'mcp.grant.refresh_reuse',
        targetType: 'mcp_grant',
        targetId: reused.id,
        meta: { userId: reused.userId },
      });
    }
    return oauthError(c, 400, 'invalid_grant');
  }
  if (current.revokedAt || (current.expiresAt && current.expiresAt <= new Date())) {
    return oauthError(c, 400, 'invalid_grant');
  }
  const refresh = newSecret(TOKEN_PREFIX.refresh, 48);
  const [rotated] = await db
    .update(mcpGrants)
    .set({ refreshHash: sha256(refresh), prevRefreshHash: hash, lastUsedAt: new Date() })
    .where(and(eq(mcpGrants.id, current.id), eq(mcpGrants.refreshHash, hash)))
    .returning();
  if (!rotated) return oauthError(c, 400, 'invalid_grant');
  return oauthJson(c, 200, await issueTokens(db, rotated, refresh));
}

/** RFC 7009: always 200, whether or not the token was known. */
export async function handleRevoke(c: Context<AppEnv>, deps: Deps) {
  const slow = await limited(c, deps, 'oauth_token', 30);
  if (slow) return slow;
  const form = await readForm(c);
  const client = await authenticateClient(c, deps.db, form);
  if (!client) return oauthError(c, 401, 'invalid_client');
  const token = form.token ?? '';
  const hash = sha256(token);
  if (token.startsWith(TOKEN_PREFIX.refresh)) {
    const [grant] = await deps.db
      .select()
      .from(mcpGrants)
      .where(and(eq(mcpGrants.refreshHash, hash), eq(mcpGrants.clientId, client.id)));
    if (grant) await revokeGrantRow(deps.db, grant.id, grant.userId, 'client_revoke');
  } else if (token.startsWith(TOKEN_PREFIX.access)) {
    const [row] = await deps.db
      .select({ id: mcpAccessTokens.id, grantId: mcpAccessTokens.grantId })
      .from(mcpAccessTokens)
      .innerJoin(mcpGrants, eq(mcpGrants.id, mcpAccessTokens.grantId))
      .where(and(eq(mcpAccessTokens.tokenHash, hash), eq(mcpGrants.clientId, client.id)));
    if (row) {
      await deps.db.delete(mcpAccessTokens).where(eq(mcpAccessTokens.id, row.id));
      invalidatePrincipals({ grantId: row.grantId });
    }
  }
  return oauthJson(c, 200, {});
}
