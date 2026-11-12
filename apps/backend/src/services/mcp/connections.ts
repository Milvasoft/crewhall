import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import {
  apiTokens,
  mcpAccessTokens,
  mcpClients,
  mcpGrants,
  spaces,
  toolCalls,
  users,
  type DbOrTx,
} from '@crewhall/db';
import { isGuest } from '../guests';
import {
  MCP_REQUIRED_SCOPE,
  type ApiToken,
  type CreateApiToken,
  type McpGrant,
  type McpGrantDetail,
  type McpOrgConnection,
  type McpScope,
  type McpSpaceRef,
  type UpdateMcpGrant,
} from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { AuthSession } from '../../http/types';
import { listMySpaces } from '../spaces';
import { toClientInfo } from './clients';
import { TOKEN_PREFIX, newSecret, sha256 } from './crypto';
import { mcpAudit } from './audit';
import { getPolicy, maxLifetimeMs } from './policy';
import { invalidatePrincipals } from './principal';
import { requireFresh } from './reauth';
import { toToolCall } from './activity';

const DAY = 24 * 60 * 60 * 1000;
const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Space references for display; ids that no longer exist drop out. */
export async function spaceRefs(db: DbOrTx, orgId: string, ids: string[]) {
  if (ids.length === 0) return new Map<string, McpSpaceRef>();
  const rows = await db
    .select({ id: spaces.id, name: spaces.name, kind: spaces.kind, color: spaces.color })
    .from(spaces)
    .where(and(eq(spaces.orgId, orgId), inArray(spaces.id, ids)));
  return new Map(rows.map((r) => [r.id, r]));
}

async function refsFor(db: DbOrTx, orgId: string, lists: (string[] | null)[]) {
  const all = [...new Set(lists.flatMap((l) => l ?? []))];
  return spaceRefs(db, orgId, all);
}

const pick = (refs: Map<string, McpSpaceRef>, ids: string[] | null) =>
  ids === null ? null : ids.map((id) => refs.get(id)).filter((r): r is McpSpaceRef => !!r);

/** The person's spaces a connection may be limited to; others are rejected. */
export async function validateSpaceIds(
  db: DbOrTx,
  orgId: string,
  userId: string,
  ids: string[] | null,
) {
  if (ids === null) return null;
  const mine = new Set((await listMySpaces(db, orgId, userId, false)).map((s) => s.id));
  const unique = [...new Set(ids)];
  if (unique.some((id) => !mine.has(id))) {
    throw new AppError('validation_failed', { reason: 'unknown_space' });
  }
  return unique;
}

/** Reading is always part of a connection. */
export const withRead = (scopes: readonly McpScope[]): McpScope[] => [
  ...new Set<McpScope>([MCP_REQUIRED_SCOPE, ...scopes]),
];

type GrantRow = typeof mcpGrants.$inferSelect;
type ClientRow = typeof mcpClients.$inferSelect;

function toGrant(row: GrantRow, client: ClientRow, refs: Map<string, McpSpaceRef>): McpGrant {
  return {
    id: row.id,
    client: {
      id: client.id,
      name: client.name,
      softwareId: client.softwareId,
      registration: client.registration,
    },
    label: row.label,
    scopes: row.scopes as McpScope[],
    spaces: pick(refs, row.spaceIds),
    expiresAt: iso(row.expiresAt),
    lastUsedAt: iso(row.lastUsedAt),
    lastIp: row.lastIp,
    createdAt: row.createdAt.toISOString(),
    revokedAt: iso(row.revokedAt),
  };
}

const liveGrant = () =>
  and(
    isNull(mcpGrants.revokedAt),
    sql`(${mcpGrants.expiresAt} is null or ${mcpGrants.expiresAt} > now())`,
  );

export async function listGrants(db: DbOrTx, orgId: string, userId: string) {
  const rows = await db
    .select({ grant: mcpGrants, client: mcpClients })
    .from(mcpGrants)
    .innerJoin(mcpClients, eq(mcpClients.id, mcpGrants.clientId))
    .where(and(eq(mcpGrants.orgId, orgId), eq(mcpGrants.userId, userId), liveGrant()))
    .orderBy(desc(sql`coalesce(${mcpGrants.lastUsedAt}, ${mcpGrants.createdAt})`));
  const refs = await refsFor(
    db,
    orgId,
    rows.map((r) => r.grant.spaceIds),
  );
  return rows.map((r) => toGrant(r.grant, r.client, refs));
}

async function ownGrant(db: DbOrTx, orgId: string, userId: string | null, grantId: string) {
  const [row] = await db
    .select({ grant: mcpGrants, client: mcpClients })
    .from(mcpGrants)
    .innerJoin(mcpClients, eq(mcpClients.id, mcpGrants.clientId))
    .where(
      and(
        eq(mcpGrants.id, grantId),
        eq(mcpGrants.orgId, orgId),
        userId ? eq(mcpGrants.userId, userId) : undefined,
        isNull(mcpGrants.revokedAt),
      ),
    );
  if (!row) throw new AppError('not_found');
  return row;
}

export async function grantDetail(
  db: DbOrTx,
  orgId: string,
  userId: string,
  grantId: string,
): Promise<McpGrantDetail> {
  const { grant, client } = await ownGrant(db, orgId, userId, grantId);
  const since = new Date(Date.now() - DAY);
  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(toolCalls)
    .where(and(eq(toolCalls.viaGrantId, grant.id), gte(toolCalls.createdAt, since)));
  const recent = await db
    .select()
    .from(toolCalls)
    .where(and(eq(toolCalls.viaGrantId, grant.id), gte(toolCalls.createdAt, since)))
    .orderBy(desc(toolCalls.createdAt))
    .limit(20);
  const refs = await refsFor(db, orgId, [grant.spaceIds]);
  return {
    ...toGrant(grant, client, refs),
    client: { ...toClientInfo(client) },
    calls24h: count?.n ?? 0,
    recentCalls: await Promise.all(recent.map((r) => toToolCall(db, r))),
  };
}

export async function updateGrant(
  deps: Deps,
  ctx: { orgId: string; userId: string; session: AuthSession },
  grantId: string,
  patch: UpdateMcpGrant,
) {
  const { db } = deps;
  const { grant, client } = await ownGrant(db, ctx.orgId, ctx.userId, grantId);
  const policy = await getPolicy(db, ctx.orgId);
  const set: Partial<GrantRow> = {};
  let widens = false;
  if (patch.label !== undefined) set.label = patch.label;
  if (patch.scopes) {
    const scopes = withRead(patch.scopes);
    if (scopes.some((s) => s !== MCP_REQUIRED_SCOPE && !policy.allowedScopes.includes(s))) {
      throw new AppError('mcp_scope_not_allowed');
    }
    if (scopes.some((s) => !grant.scopes.includes(s))) widens = true;
    set.scopes = scopes;
  }
  if (patch.spaceIds !== undefined) {
    const ids = await validateSpaceIds(db, ctx.orgId, ctx.userId, patch.spaceIds);
    if (ids === null ? grant.spaceIds !== null : ids.some((id) => !grant.spaceIds?.includes(id))) {
      if (grant.spaceIds !== null) widens = true;
    }
    set.spaceIds = ids;
  }
  if (patch.extendDays !== undefined) {
    const max = maxLifetimeMs(policy);
    const ms = patch.extendDays * DAY;
    if (max !== null && ms > max) throw new AppError('mcp_expiry_not_allowed');
    set.expiresAt = new Date(Date.now() + ms);
    widens = true;
  }
  // Narrowing applies at once; widening needs a recent passkey or password check.
  if (widens) await requireFresh(deps, ctx.session);
  const [row] = await db.update(mcpGrants).set(set).where(eq(mcpGrants.id, grant.id)).returning();
  invalidatePrincipals({ grantId: grant.id });
  await mcpAudit(db, {
    orgId: ctx.orgId,
    actorId: ctx.userId,
    action: 'mcp.grant.update',
    targetType: 'mcp_grant',
    targetId: grant.id,
    meta: { widens, scopes: row!.scopes, spaceIds: row!.spaceIds },
  });
  const refs = await refsFor(db, ctx.orgId, [row!.spaceIds]);
  return toGrant(row!, client, refs);
}

/** Revokes a grant: its refresh token and every access token stop working. */
export async function revokeGrantRow(
  db: DbOrTx,
  grantId: string,
  by: string | null,
  reason: string,
) {
  await db
    .update(mcpGrants)
    .set({
      revokedAt: new Date(),
      revokedBy: by,
      revokeReason: reason,
      refreshHash: null,
      prevRefreshHash: null,
    })
    .where(and(eq(mcpGrants.id, grantId), isNull(mcpGrants.revokedAt)));
  await db.delete(mcpAccessTokens).where(eq(mcpAccessTokens.grantId, grantId));
  invalidatePrincipals({ grantId });
}

export async function revokeGrant(
  db: DbOrTx,
  orgId: string,
  actorId: string,
  grantId: string,
  opts: { asAdmin?: boolean } = {},
) {
  const { grant } = await ownGrant(db, orgId, opts.asAdmin ? null : actorId, grantId);
  await revokeGrantRow(db, grant.id, actorId, opts.asAdmin ? 'admin' : 'user');
  await mcpAudit(db, {
    orgId,
    actorId,
    action: 'mcp.grant.revoke',
    targetType: 'mcp_grant',
    targetId: grant.id,
    meta: { userId: grant.userId, admin: opts.asAdmin === true },
  });
}

// ---- personal access tokens ----------------------------------------------------------

type TokenRow = typeof apiTokens.$inferSelect;

function toToken(row: TokenRow, refs: Map<string, McpSpaceRef>): ApiToken {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes as McpScope[],
    spaces: pick(refs, row.spaceIds),
    allowedIps: row.allowedIps,
    expiresAt: iso(row.expiresAt),
    lastUsedAt: iso(row.lastUsedAt),
    createdAt: row.createdAt.toISOString(),
    revokedAt: iso(row.revokedAt),
  };
}

const liveToken = () =>
  and(
    isNull(apiTokens.revokedAt),
    sql`(${apiTokens.expiresAt} is null or ${apiTokens.expiresAt} > now())`,
  );

export async function listTokens(db: DbOrTx, orgId: string, userId: string) {
  const rows = await db
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.orgId, orgId), eq(apiTokens.userId, userId), liveToken()))
    .orderBy(desc(apiTokens.createdAt));
  const refs = await refsFor(
    db,
    orgId,
    rows.map((r) => r.spaceIds),
  );
  return rows.map((r) => toToken(r, refs));
}

export async function createToken(
  db: DbOrTx,
  ctx: { orgId: string; userId: string },
  input: CreateApiToken,
) {
  const policy = await getPolicy(db, ctx.orgId);
  if (!policy.patsEnabled) throw new AppError('mcp_tokens_disabled');
  if (!policy.guestsAllowed && (await isGuest(db, ctx.orgId, ctx.userId))) {
    throw new AppError('mcp_guests_not_allowed');
  }
  const scopes = withRead(input.scopes);
  if (scopes.some((s) => s !== MCP_REQUIRED_SCOPE && !policy.allowedScopes.includes(s))) {
    throw new AppError('mcp_scope_not_allowed');
  }
  const max = maxLifetimeMs(policy);
  if (
    input.expiresInDays === null ? max !== null : max !== null && input.expiresInDays * DAY > max
  ) {
    throw new AppError('mcp_expiry_not_allowed');
  }
  const spaceIds = await validateSpaceIds(db, ctx.orgId, ctx.userId, input.spaceIds);
  const value = newSecret(TOKEN_PREFIX.pat, 40);
  const [row] = await db
    .insert(apiTokens)
    .values({
      orgId: ctx.orgId,
      userId: ctx.userId,
      name: input.name,
      prefix: value.slice(0, 8),
      tokenHash: sha256(value),
      scopes,
      spaceIds,
      allowedIps: input.allowedIps && input.allowedIps.length ? input.allowedIps : null,
      expiresAt:
        input.expiresInDays === null ? null : new Date(Date.now() + input.expiresInDays * DAY),
    })
    .returning();
  await mcpAudit(db, {
    orgId: ctx.orgId,
    actorId: ctx.userId,
    action: 'mcp.token.create',
    targetType: 'api_token',
    targetId: row!.id,
    meta: { name: row!.name, scopes, spaceIds },
  });
  const refs = await refsFor(db, ctx.orgId, [spaceIds]);
  return { token: toToken(row!, refs), value };
}

export async function revokeToken(
  db: DbOrTx,
  orgId: string,
  actorId: string,
  tokenId: string,
  opts: { asAdmin?: boolean } = {},
) {
  const [row] = await db
    .update(apiTokens)
    .set({ revokedAt: new Date(), revokedBy: actorId })
    .where(
      and(
        eq(apiTokens.id, tokenId),
        eq(apiTokens.orgId, orgId),
        opts.asAdmin ? undefined : eq(apiTokens.userId, actorId),
        isNull(apiTokens.revokedAt),
      ),
    )
    .returning();
  if (!row) throw new AppError('not_found');
  invalidatePrincipals({ tokenId });
  await mcpAudit(db, {
    orgId,
    actorId,
    action: 'mcp.token.revoke',
    targetType: 'api_token',
    targetId: tokenId,
    meta: { userId: row.userId, admin: opts.asAdmin === true },
  });
}

// ---- org view (18.10) ----------------------------------------------------------------

export async function orgConnections(
  db: DbOrTx,
  orgId: string,
  kind?: 'grant' | 'token',
): Promise<McpOrgConnection[]> {
  const out: (McpOrgConnection & { sort: number })[] = [];
  const person = { id: users.id, name: users.name, imageUrl: users.image };
  if (kind !== 'token') {
    const rows = await db
      .select({ grant: mcpGrants, client: mcpClients, user: person })
      .from(mcpGrants)
      .innerJoin(mcpClients, eq(mcpClients.id, mcpGrants.clientId))
      .innerJoin(users, eq(users.id, mcpGrants.userId))
      .where(and(eq(mcpGrants.orgId, orgId), liveGrant()));
    const refs = await refsFor(
      db,
      orgId,
      rows.map((r) => r.grant.spaceIds),
    );
    for (const r of rows) {
      out.push({
        id: r.grant.id,
        kind: 'grant',
        user: r.user,
        name: r.grant.label ? `${r.client.name} · ${r.grant.label}` : r.client.name,
        scopes: r.grant.scopes as McpScope[],
        spaces: pick(refs, r.grant.spaceIds),
        lastUsedAt: iso(r.grant.lastUsedAt),
        expiresAt: iso(r.grant.expiresAt),
        createdAt: r.grant.createdAt.toISOString(),
        sort: (r.grant.lastUsedAt ?? r.grant.createdAt).getTime(),
      });
    }
  }
  if (kind !== 'grant') {
    const rows = await db
      .select({ token: apiTokens, user: person })
      .from(apiTokens)
      .innerJoin(users, eq(users.id, apiTokens.userId))
      .where(and(eq(apiTokens.orgId, orgId), liveToken()));
    const refs = await refsFor(
      db,
      orgId,
      rows.map((r) => r.token.spaceIds),
    );
    for (const r of rows) {
      out.push({
        id: r.token.id,
        kind: 'token',
        user: r.user,
        name: r.token.name,
        scopes: r.token.scopes as McpScope[],
        spaces: pick(refs, r.token.spaceIds),
        lastUsedAt: iso(r.token.lastUsedAt),
        expiresAt: iso(r.token.expiresAt),
        createdAt: r.token.createdAt.toISOString(),
        sort: (r.token.lastUsedAt ?? r.token.createdAt).getTime(),
      });
    }
  }
  return out.sort((a, b) => b.sort - a.sort).map(({ sort: _sort, ...c }) => c);
}

/** Scopes the policy took away are dropped from every live connection (18.10). */
export async function narrowToPolicy(db: DbOrTx, orgId: string, allowed: readonly McpScope[]) {
  const keep = sql`array(select s from unnest(scopes) s where s = ${MCP_REQUIRED_SCOPE} or s = any(${sql.param(allowed as string[])}::text[]))`;
  await db.execute(
    sql`update ${mcpGrants} set scopes = ${keep} where org_id = ${orgId} and revoked_at is null`,
  );
  await db.execute(
    sql`update ${apiTokens} set scopes = ${keep} where org_id = ${orgId} and revoked_at is null`,
  );
  invalidatePrincipals({ all: true });
}
