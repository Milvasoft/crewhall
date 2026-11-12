import { can } from '@crewhall/shared';
import type { Context } from 'hono';
import { AppError } from '../http/errors';
import type { Router } from '../http/route';
import type { AppEnv, OrgCtx } from '../http/types';
import { orgContext } from '../services/membership';
import * as activity from '../services/mcp/activity';
import * as approvals from '../services/mcp/approvals';
import { orgUsage, toolCatalog } from '../services/mcp/catalog';
import { listClients, toClientInfo } from '../services/mcp/clients';
import * as conn from '../services/mcp/connections';
import { mcpAudit } from '../services/mcp/audit';
import * as oauth from '../services/mcp/oauth';
import { effectiveScopes, getPolicy, moduleOn, updatePolicy } from '../services/mcp/policy';
import { reauthWithPassword } from '../services/mcp/reauth';
import { handleMcp } from '../services/mcp/server';
import { driveActor } from './drive';
import { and, eq } from 'drizzle-orm';
import { mcpClients } from '@crewhall/db';
import { invalidatePrincipals } from '../services/mcp/principal';

const who = (ctx: Pick<OrgCtx<never>, 'org' | 'user' | 'session'>) => ({
  orgId: ctx.org.id,
  userId: ctx.user.id,
  session: ctx.session,
});

function requireAdmin(ctx: Pick<OrgCtx<never>, 'actor' | 'org'>) {
  if (!can(ctx.actor, 'org.update_settings', { type: 'org', org: orgContext(ctx.org) })) {
    throw new AppError('forbidden');
  }
}

/** Public OAuth documents and endpoints may be called from browser-based MCP clients. */
function openCors(c: Context<AppEnv>) {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  c.header(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, MCP-Protocol-Version, Mcp-Session-Id',
  );
  c.header('Access-Control-Max-Age', '600');
}

/** MCP module: /mcp, the OAuth 2.1 authorization server and the contract endpoints (design 18). */
export function registerMcp(r: Router): void {
  // ---- MCP server (Streamable HTTP, stateless) ----
  for (const method of ['POST', 'GET', 'DELETE'] as const) {
    r.rawPublic(method, '/mcp', ({ c, deps }) => handleMcp(c, deps));
  }

  // ---- OAuth 2.1 discovery (RFC 9728, RFC 8414) ----
  const documents: [
    string,
    (c: Context<AppEnv>, env: Parameters<typeof oauth.issuer>[0]) => object,
  ][] = [
    ['/.well-known/oauth-protected-resource', (_c, env) => oauth.protectedResourceMetadata(env)],
    [
      '/.well-known/oauth-protected-resource/mcp',
      (_c, env) => oauth.protectedResourceMetadata(env),
    ],
    [
      '/.well-known/oauth-authorization-server',
      (_c, env) => oauth.authorizationServerMetadata(env),
    ],
    // /.well-known/openid-configuration belongs to the identity module (Crewhall as OIDC provider).
  ];
  for (const [path, doc] of documents) {
    r.rawPublic('GET', path, async ({ c, deps }) => {
      openCors(c);
      c.header('Cache-Control', 'public, max-age=300');
      return c.json(doc(c, deps.env));
    });
    r.rawPublic('OPTIONS', path, async ({ c }) => {
      openCors(c);
      return c.body(null, 204);
    });
  }
  const endpoints: [string, typeof oauth.handleToken][] = [
    ['/oauth/register', oauth.handleRegister],
    ['/oauth/token', oauth.handleToken],
    ['/oauth/revoke', oauth.handleRevoke],
  ];
  for (const [path, handler] of endpoints) {
    r.rawPublic('POST', path, async ({ c, deps }) => {
      openCors(c);
      return handler(c, deps);
    });
    r.rawPublic('OPTIONS', path, async ({ c }) => {
      openCors(c);
      return c.body(null, 204);
    });
  }
  r.rawPublic('GET', '/oauth/authorize', ({ c, deps }) => oauth.handleAuthorize(c, deps));

  // ---- Hesabım › MCP ve API ----
  r.org('getMcpOverview', async (ctx) => {
    const { db, env } = ctx.deps;
    const policy = await getPolicy(db, ctx.org.id);
    const guestBlocked = ctx.member.role === 'guest' && !policy.guestsAllowed;
    const mcpOn = policy.enabled && moduleOn(ctx.org, 'mcp');
    const [grants, tokens, today, pending] = await Promise.all([
      conn.listGrants(db, ctx.org.id, ctx.user.id),
      conn.listTokens(db, ctx.org.id, ctx.user.id),
      activity.todayStats(db, ctx.user.id),
      approvals.pendingCount(db, ctx.user.id),
    ]);
    return {
      serverUrl: oauth.resourceUrl(env),
      enabled: mcpOn && !guestBlocked,
      disabledReason: !mcpOn ? 'org_disabled' : guestBlocked ? 'guests_not_allowed' : null,
      patsEnabled: policy.patsEnabled,
      allowedScopes: policy.allowedScopes,
      maxTokenDays: policy.maxTokenDays,
      todayCalls: today.calls,
      todayWrites: today.writes,
      todayErrors: today.errors,
      pendingApprovals: pending,
      grants: grants.length,
      tokens: tokens.length,
    };
  });
  r.org('listMcpGrants', async (ctx) => ({
    items: await conn.listGrants(ctx.deps.db, ctx.org.id, ctx.user.id),
  }));
  r.org('getMcpGrant', async (ctx) =>
    conn.grantDetail(ctx.deps.db, ctx.org.id, ctx.user.id, ctx.params.grantId),
  );
  r.org('updateMcpGrant', async (ctx) =>
    conn.updateGrant(ctx.deps, who(ctx), ctx.params.grantId, ctx.body),
  );
  r.org('revokeMcpGrant', async (ctx) => {
    await conn.revokeGrant(ctx.deps.db, ctx.org.id, ctx.user.id, ctx.params.grantId);
    return {};
  });
  r.org('listMcpTokens', async (ctx) => ({
    items: await conn.listTokens(ctx.deps.db, ctx.org.id, ctx.user.id),
  }));
  r.org(
    'createMcpToken',
    async (ctx) =>
      conn.createToken(ctx.deps.db, { orgId: ctx.org.id, userId: ctx.user.id }, ctx.body),
    { status: 201 },
  );
  r.org('revokeMcpToken', async (ctx) => {
    await conn.revokeToken(ctx.deps.db, ctx.org.id, ctx.user.id, ctx.params.tokenId);
    return {};
  });
  r.org('mcpReauth', async (ctx) => {
    const until = await reauthWithPassword(ctx.deps, who(ctx), ctx.body.password);
    return { verifiedUntil: until.toISOString() };
  });

  // ---- Etkinlik ----
  r.org('listMcpActivity', async (ctx) =>
    activity.listActivity(ctx.deps.db, ctx.org.id, ctx.user.id, ctx.query),
  );
  r.org('undoMcpToolCall', async (ctx) =>
    activity.undoToolCall(ctx.deps, driveActor(ctx), ctx.params.callNo),
  );

  // ---- Onay bekleyenler ----
  r.org('listMcpApprovals', async (ctx) =>
    approvals.listApprovals(ctx.deps.db, ctx.org.id, ctx.user.id, ctx.query),
  );
  r.org('getMcpApproval', async (ctx) =>
    approvals.approvalDetail(ctx.deps, who(ctx), ctx.params.approvalId),
  );
  r.org('approveMcpApproval', async (ctx) =>
    approvals.approve(ctx.deps, who(ctx), ctx.params.approvalId),
  );
  r.org('rejectMcpApproval', async (ctx) =>
    approvals.reject(ctx.deps, who(ctx), ctx.params.approvalId, ctx.body.reason),
  );

  // ---- Araç belgeleri ----
  r.org('getMcpToolCatalog', async (ctx) => {
    const { db } = ctx.deps;
    const policy = await getPolicy(db, ctx.org.id);
    const [grants, tokens] = await Promise.all([
      conn.listGrants(db, ctx.org.id, ctx.user.id),
      conn.listTokens(db, ctx.org.id, ctx.user.id),
    ]);
    const mine = new Set([...grants, ...tokens].flatMap((g) => effectiveScopes(policy, g.scopes)));
    return toolCatalog(mine, ctx.org);
  });

  // ---- OAuth onay ekranı ----
  const consentCtx = (ctx: OrgCtx<never>): oauth.ConsentCtx => ({
    deps: ctx.deps,
    org: ctx.org,
    member: ctx.member,
    user: ctx.user,
    session: ctx.session,
    ip: ctx.req.ip,
  });
  r.org('getMcpConsent', async (ctx) => oauth.getConsent(consentCtx(ctx as never), ctx.query));
  r.org('approveMcpConsent', async (ctx) =>
    oauth.approveConsent(consentCtx(ctx as never), ctx.body, ctx.c.req.header('origin')),
  );
  r.org('denyMcpConsent', async (ctx) =>
    oauth.denyConsent(consentCtx(ctx as never), ctx.body, ctx.c.req.header('origin')),
  );

  // ---- Yönetim › MCP ve API ----
  r.org('getMcpPolicy', async (ctx) => {
    requireAdmin(ctx);
    return getPolicy(ctx.deps.db, ctx.org.id);
  });
  r.org('updateMcpPolicy', async (ctx) => {
    requireAdmin(ctx);
    const { db } = ctx.deps;
    const policy = await db.transaction(async (tx) => {
      const next = await updatePolicy(tx, ctx.org.id, ctx.body);
      if (ctx.body.allowedScopes) await conn.narrowToPolicy(tx, ctx.org.id, next.allowedScopes);
      return next;
    });
    invalidatePrincipals({ all: true });
    await mcpAudit(
      db,
      {
        orgId: ctx.org.id,
        actorId: ctx.user.id,
        action: 'mcp.policy.update',
        targetType: 'org',
        targetId: ctx.org.id,
        meta: { changes: ctx.body },
      },
      ctx.req,
    );
    return policy;
  });
  r.org('listMcpClients', async (ctx) => {
    requireAdmin(ctx);
    return { items: await listClients(ctx.deps.db, ctx.org.id) };
  });
  r.org('updateMcpClient', async (ctx) => {
    requireAdmin(ctx);
    const { db } = ctx.deps;
    const [row] = await db
      .update(mcpClients)
      .set({ status: ctx.body.status })
      .where(and(eq(mcpClients.id, ctx.params.mcpClientId), eq(mcpClients.orgId, ctx.org.id)))
      .returning();
    if (!row) throw new AppError('not_found');
    // A blocked client's tokens fail at once on this node (the lookup checks the status).
    invalidatePrincipals({ all: true });
    await mcpAudit(
      db,
      {
        orgId: ctx.org.id,
        actorId: ctx.user.id,
        action: 'mcp.client.update',
        targetType: 'mcp_client',
        targetId: row.id,
        meta: { status: row.status, name: row.name },
      },
      ctx.req,
    );
    return toClientInfo(row);
  });
  r.org('listMcpOrgConnections', async (ctx) => {
    requireAdmin(ctx);
    return { items: await conn.orgConnections(ctx.deps.db, ctx.org.id, ctx.query.kind) };
  });
  r.org('revokeMcpOrgGrant', async (ctx) => {
    requireAdmin(ctx);
    await conn.revokeGrant(ctx.deps.db, ctx.org.id, ctx.user.id, ctx.params.grantId, {
      asAdmin: true,
    });
    return {};
  });
  r.org('revokeMcpOrgToken', async (ctx) => {
    requireAdmin(ctx);
    await conn.revokeToken(ctx.deps.db, ctx.org.id, ctx.user.id, ctx.params.tokenId, {
      asAdmin: true,
    });
    return {};
  });
  r.org('getMcpUsage', async (ctx) => {
    requireAdmin(ctx);
    return orgUsage(ctx.deps.db, ctx.org.id, ctx.query.days);
  });
}
