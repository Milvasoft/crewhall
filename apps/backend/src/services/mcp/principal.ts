import { BlockList, isIPv4, isIPv6 } from 'node:net';
import { and, eq, isNull } from 'drizzle-orm';
import { apiTokens, mcpAccessTokens, mcpClients, mcpGrants, type DbOrTx } from '@crewhall/db';
import type { McpScope } from '@crewhall/shared';
import { TOKEN_PREFIX, sha256 } from './crypto';

/** Who is calling /mcp: a person through an OAuth grant or a personal token. */
export interface McpPrincipal {
  kind: 'oauth' | 'token';
  grantId: string | null;
  tokenId: string | null;
  /** Client name (OAuth) or token name. */
  name: string;
  userId: string;
  orgId: string;
  scopes: McpScope[];
  /** null = every space the person can reach. */
  spaceIds: string[] | null;
  /** The bearer stops working at this time (access token or PAT expiry). */
  expiresAt: Date | null;
  allowedIps: string[] | null;
}

/**
 * Bearer lookups are cached for 30 s (doc 17 §13). Revoking in this process clears the
 * entry at once; other api nodes see the revoke within the cache lifetime.
 */
export const PRINCIPAL_CACHE_MS = 30_000;
const cache = new Map<string, { principal: McpPrincipal; at: number }>();

export function invalidatePrincipals(match: { grantId?: string; tokenId?: string; all?: true }) {
  for (const [key, entry] of cache) {
    if (
      match.all ||
      (match.grantId && entry.principal.grantId === match.grantId) ||
      (match.tokenId && entry.principal.tokenId === match.tokenId)
    ) {
      cache.delete(key);
    }
  }
}

export function ipAllowed(ip: string | null, cidrs: readonly string[] | null): boolean {
  if (!cidrs || cidrs.length === 0) return true;
  if (!ip) return false;
  const list = new BlockList();
  for (const c of cidrs) {
    const [addr, bits] = c.split('/');
    if (!addr) continue;
    const type = isIPv4(addr) ? 'ipv4' : isIPv6(addr) ? 'ipv6' : null;
    if (!type) continue;
    if (bits === undefined) list.addAddress(addr, type);
    else list.addSubnet(addr, Number(bits), type);
  }
  const plain = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const type = isIPv4(plain) ? 'ipv4' : 'ipv6';
  return list.check(plain, type);
}

async function lookup(db: DbOrTx, bearer: string, resource: string) {
  const hash = sha256(bearer);
  const now = new Date();
  if (bearer.startsWith(TOKEN_PREFIX.pat)) {
    const [row] = await db
      .select()
      .from(apiTokens)
      .where(and(eq(apiTokens.tokenHash, hash), isNull(apiTokens.revokedAt)));
    if (!row || (row.expiresAt && row.expiresAt <= now)) return null;
    const principal: McpPrincipal = {
      kind: 'token',
      grantId: null,
      tokenId: row.id,
      name: row.name,
      userId: row.userId,
      orgId: row.orgId,
      scopes: row.scopes as McpScope[],
      spaceIds: row.spaceIds,
      expiresAt: row.expiresAt,
      allowedIps: row.allowedIps,
    };
    return principal;
  }
  if (bearer.startsWith(TOKEN_PREFIX.access)) {
    const [row] = await db
      .select({ token: mcpAccessTokens, grant: mcpGrants, client: mcpClients })
      .from(mcpAccessTokens)
      .innerJoin(mcpGrants, eq(mcpGrants.id, mcpAccessTokens.grantId))
      .innerJoin(mcpClients, eq(mcpClients.id, mcpGrants.clientId))
      .where(eq(mcpAccessTokens.tokenHash, hash));
    if (!row) return null;
    const { token, grant, client } = row;
    // Audience: a token minted for another resource is not accepted here (RFC 8707).
    if (token.resource !== resource || grant.resource !== resource) return null;
    if (token.expiresAt <= now || grant.revokedAt) return null;
    if (grant.expiresAt && grant.expiresAt <= now) return null;
    if (client.status !== 'allowed') return null;
    const principal: McpPrincipal = {
      kind: 'oauth',
      grantId: grant.id,
      tokenId: null,
      name: grant.label ? `${client.name} · ${grant.label}` : client.name,
      userId: grant.userId,
      orgId: grant.orgId,
      scopes: grant.scopes as McpScope[],
      spaceIds: grant.spaceIds,
      expiresAt: token.expiresAt,
      allowedIps: null,
    };
    return principal;
  }
  return null;
}

/** Resolves a bearer for /mcp (or the REST API); null when unknown, expired or revoked. */
export async function resolveBearer(
  db: DbOrTx,
  bearer: string,
  resource: string,
  ip: string | null,
): Promise<McpPrincipal | null> {
  const key = `${resource}\n${sha256(bearer)}`;
  const hit = cache.get(key);
  let principal: McpPrincipal | null;
  if (hit && Date.now() - hit.at < PRINCIPAL_CACHE_MS) {
    principal = hit.principal;
  } else {
    principal = await lookup(db, bearer, resource);
    if (principal) cache.set(key, { principal, at: Date.now() });
    else cache.delete(key);
  }
  if (!principal) return null;
  if (principal.expiresAt && principal.expiresAt <= new Date()) return null;
  if (!ipAllowed(ip, principal.allowedIps)) return null;
  return principal;
}

/** last_used_at / last_ip, written at most once a minute per connection. */
const touched = new Map<string, number>();
export async function touchPrincipal(db: DbOrTx, p: McpPrincipal, ip: string | null) {
  const id = p.grantId ?? p.tokenId!;
  const last = touched.get(id) ?? 0;
  if (Date.now() - last < 60_000) return;
  touched.set(id, Date.now());
  const values = { lastUsedAt: new Date(), lastIp: ip };
  if (p.grantId) await db.update(mcpGrants).set(values).where(eq(mcpGrants.id, p.grantId));
  else await db.update(apiTokens).set(values).where(eq(apiTokens.id, p.tokenId!));
}
