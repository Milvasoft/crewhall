import { and, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { orgMembers, users } from '@crewhall/db';
import type { EndpointName, McpScope } from '@crewhall/shared';
import type { Deps } from '../../deps';
import { clientIp } from '../../http/client-ip';
import { AppError } from '../../http/errors';
import type { AppEnv, AuthSession, AuthUser } from '../../http/types';
import { take } from '../mcp/rate-limit';
import { tokenScopeOf, type TokenAuth } from '../mcp/rest';
import { loadInstallation, pluginName } from './installations';
import { looksLikeSessionToken, verifySessionToken } from './tokens';

/**
 * The REST API with a plugin session token (docs/contracts/eklentiler.md › Kimlik): the person
 * acts within the installation's approved permissions, through the same endpoint → scope map as
 * personal tokens (`tokenScopeOf`). Audit rows and messages say `via: plugin`.
 */

const bearerOf = (c: Context<AppEnv>) =>
  /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1] ?? '';

export const isPluginTokenRequest = (c: Context<AppEnv>) => looksLikeSessionToken(bearerOf(c));

/** Requests per minute a plugin may make for one person. */
const PLUGIN_REQUESTS_PER_MINUTE = 120;

function invalid(c: Context<AppEnv>): never {
  c.header('WWW-Authenticate', 'Bearer error="invalid_token"');
  throw new AppError('unauthenticated', { reason: 'invalid_token' });
}

export async function authenticatePluginToken(
  deps: Deps,
  c: Context<AppEnv>,
  name: EndpointName,
): Promise<TokenAuth> {
  const claims = await verifySessionToken(deps.db, deps.env, bearerOf(c));
  if (!claims) invalid(c);
  const row = await loadInstallation(deps.db, claims.org, claims.inst).catch(() => null);
  if (!row || row.pluginId !== claims.aud) invalid(c);
  if (!row.enabled) throw new AppError('plugin_disabled');
  const [member] = await deps.db
    .select()
    .from(orgMembers)
    .where(and(eq(orgMembers.organizationId, claims.org), eq(orgMembers.userId, claims.sub)));
  if (!member || member.status !== 'active') invalid(c);
  const [user] = await deps.db.select().from(users).where(eq(users.id, claims.sub));
  if (!user) invalid(c);

  // The token's scopes, but never more than the installation has now (it may have changed).
  const scopes = claims.scope.split(' ').filter((s) => row.permissions.includes(s)) as McpScope[];
  const needed = tokenScopeOf(name);
  if (needed === null || !scopes.includes(needed)) {
    throw new AppError('token_scope', { endpoint: name, scope: needed });
  }
  const limit = await take(
    deps.db,
    `${claims.sub}:${row.id}`,
    { kind: 'plugin_req', perMinute: PLUGIN_REQUESTS_PER_MINUTE },
    claims.org,
  );
  if (!limit.allowed) {
    c.header('Retry-After', String(limit.retryAfter));
    throw new AppError('rate_limited', { retryAfter: limit.retryAfter });
  }
  const client = pluginName(row.manifest, 'tr');
  const session = {
    id: claims.jti,
    token: '',
    userId: user.id,
    // Never "just signed in": re-verification needs a real session.
    createdAt: new Date(0),
    updatedAt: new Date(0),
    expiresAt: new Date(claims.exp * 1000),
    ipAddress: clientIp(c),
    userAgent: c.req.header('user-agent') ?? null,
    activeOrganizationId: claims.org,
  } as unknown as AuthSession;
  return {
    principal: {
      kind: 'token',
      grantId: null,
      tokenId: null,
      name: client,
      userId: user.id,
      orgId: claims.org,
      scopes,
      spaceIds: null,
      expiresAt: new Date(claims.exp * 1000),
      allowedIps: null,
    },
    user: user as unknown as AuthUser,
    session,
    via: { kind: 'plugin', client, plugin: row.pluginId, installation: row.id },
  };
}
