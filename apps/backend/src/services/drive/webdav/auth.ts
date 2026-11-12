import { and, eq } from 'drizzle-orm';
import { orgMembers, organizations, users } from '@crewhall/db';
import type { McpScope } from '@crewhall/shared';
import type { Context } from 'hono';
import type { Deps } from '../../../deps';
import { clientIp } from '../../../http/client-ip';
import { AppError } from '../../../http/errors';
import type { AppEnv } from '../../../http/types';
import { checkIpAllowlist } from '../../identity/guard';
import { needsTwoFactorEnrolment, toActor } from '../../membership';
import { TOKEN_PREFIX } from '../../mcp/crypto';
import { effectiveScopes, getPolicy, moduleOn } from '../../mcp/policy';
import { resolveBearer, touchPrincipal, type McpPrincipal } from '../../mcp/principal';
import { take } from '../../mcp/rate-limit';
import { REST_RESOURCE } from '../../mcp/rest';
import type { DriveActor } from '../access';

/**
 * WebDAV sign-in (roadmap 9): a personal access token (Hesabım › MCP ve API) as the Basic
 * auth password, any user name; `Authorization: Bearer mhp_…` works too (rclone
 * bearer_token). The token's scopes, spaces, expiry, IP list and the org's policy apply as on
 * the REST API.
 */
export interface DavSession {
  a: DriveActor;
  principal: McpPrincipal;
  scopes: McpScope[];
  /** For audit rows and tool-call style attribution. */
  via: Record<string, unknown>;
}

/** WebDAV clients list folders in bursts; this is per person, separate from the REST bucket. */
export const DAV_REQUESTS_PER_MINUTE = 1200;

export function bearerOf(header: string | undefined): string | null {
  if (!header) return null;
  const bearer = /^Bearer\s+(\S+)$/i.exec(header);
  if (bearer) return bearer[1] ?? null;
  const basic = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header);
  if (!basic?.[1]) return null;
  const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  return colon < 0 ? null : decoded.slice(colon + 1);
}

/** null = no or bad credentials (the caller answers 401 with a Basic challenge). */
export async function authenticateDav(deps: Deps, c: Context<AppEnv>): Promise<DavSession | null> {
  const token = bearerOf(c.req.header('authorization'));
  if (!token?.startsWith(TOKEN_PREFIX.pat)) return null;
  const ip = clientIp(c);
  const principal = await resolveBearer(deps.db, token, REST_RESOURCE, ip);
  if (principal?.kind !== 'token') return null;

  const [row] = await deps.db
    .select({ member: orgMembers, org: organizations, user: users })
    .from(orgMembers)
    .innerJoin(organizations, eq(organizations.id, orgMembers.organizationId))
    .innerJoin(users, eq(users.id, orgMembers.userId))
    .where(
      and(
        eq(orgMembers.organizationId, principal.orgId),
        eq(orgMembers.userId, principal.userId),
        eq(orgMembers.status, 'active'),
      ),
    );
  if (!row) return null;
  const { org, member, user } = row;

  const policy = await getPolicy(deps.db, org.id);
  if (!moduleOn(org, 'mcp') || !policy.enabled) throw new AppError('mcp_disabled');
  if (!policy.patsEnabled) throw new AppError('mcp_tokens_disabled');
  if (await needsTwoFactorEnrolment(deps.db, org, member, user)) {
    throw new AppError('two_factor_required');
  }
  await checkIpAllowlist(deps.db, org.id, c.req.method, new URL(c.req.url).pathname, ip);

  const limit = await take(
    deps.db,
    principal.userId,
    { kind: 'dav_req', perMinute: DAV_REQUESTS_PER_MINUTE },
    org.id,
  );
  if (!limit.allowed) {
    c.header('Retry-After', String(limit.retryAfter));
    throw new AppError('rate_limited', { retryAfter: limit.retryAfter });
  }
  await touchPrincipal(deps.db, principal, ip);

  return {
    a: { org, actor: toActor(member), userId: user.id },
    principal,
    scopes: effectiveScopes(policy, principal.scopes),
    via: {
      kind: 'api',
      client: `WebDAV · ${principal.name}`,
      token: principal.tokenId,
      grant: null,
    },
  };
}
