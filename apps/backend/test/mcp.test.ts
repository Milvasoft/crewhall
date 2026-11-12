import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  apiTokens,
  auditLogs,
  mcpAccessTokens,
  mcpAuthCodes,
  mcpGrants,
  nodes,
  sessions,
  toolCalls,
} from '@crewhall/db';
import { ApiError } from '@crewhall/api-client';
import { invalidatePrincipals } from '../src/services/mcp/principal';
import { pkceMatches } from '../src/services/mcp/crypto';
import { redirectUriAllowed, redirectUriMatches } from '../src/services/mcp/clients';
import { requiresApproval } from '../src/services/mcp/approvals';
import { trimParams } from '../src/services/mcp/executor';
import { Client, createTestApp, join, PASSWORD, setupWithOwner, type TestApp } from './helpers';
import {
  API,
  REDIRECT,
  RESOURCE,
  callTool,
  connect,
  http,
  mcp,
  pkce,
  register,
} from './mcp-helpers';

async function expectApiError(p: Promise<unknown>, status: number, code?: string) {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    const e = err as ApiError;
    expect(e.status).toBe(status);
    if (code) expect(e.code).toBe(code);
    return e;
  }
  throw new Error(`expected ${status}`);
}

/** Pretends the session started an hour ago, so a re-verification is needed. */
async function ageSessions(app: TestApp, userId: string) {
  await app.deps.db
    .update(sessions)
    .set({ createdAt: new Date(Date.now() - 60 * 60 * 1000) })
    .where(eq(sessions.userId, userId));
  await app.deps.db.execute(sql`delete from mcp_reauth where user_id = ${userId}`);
}

describe('MCP unit pieces', () => {
  it('PKCE S256 matches only the right verifier', () => {
    const { verifier, challenge } = pkce();
    expect(pkceMatches(verifier, challenge)).toBe(true);
    expect(pkceMatches(`${verifier}x`, challenge)).toBe(false);
    expect(pkceMatches('short', challenge)).toBe(false);
  });

  it('redirect URIs: https, loopback http, private schemes; loopback port is free', () => {
    expect(redirectUriAllowed('https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(redirectUriAllowed('http://localhost:53682/callback')).toBe(true);
    expect(redirectUriAllowed('http://127.0.0.1/cb')).toBe(true);
    expect(redirectUriAllowed('cursor://anysphere.cursor-retrieval/oauth/callback')).toBe(true);
    expect(redirectUriAllowed('http://evil.example/cb')).toBe(false);
    expect(redirectUriAllowed('javascript:alert(1)')).toBe(false);
    expect(redirectUriAllowed('https://a.example/cb#frag')).toBe(false);
    const reg = ['http://127.0.0.1:53682/callback', 'https://claude.ai/cb'];
    expect(redirectUriMatches(reg, 'http://127.0.0.1:61000/callback')).toBe(true);
    expect(redirectUriMatches(reg, 'http://127.0.0.1:61000/other')).toBe(false);
    expect(redirectUriMatches(reg, 'http://localhost:53682/callback')).toBe(false);
    expect(redirectUriMatches(reg, 'https://claude.ai/cb')).toBe(true);
    expect(redirectUriMatches(reg, 'https://claude.ai/cb?x=1')).toBe(false);
  });

  it('requiresApproval: trash, publish, bulk always; space chat by policy', () => {
    const policy = { approvalRules: [] as never[] };
    expect(requiresApproval('node.trash', 1, policy)).toBe(true);
    expect(requiresApproval('portal.publish', 1, policy)).toBe(true);
    expect(requiresApproval('write', 21, policy)).toBe(true);
    expect(requiresApproval('write', 3, policy)).toBe(false);
    expect(requiresApproval('chat.space_message', 1, policy)).toBe(false);
    expect(
      requiresApproval('chat.space_message', 1, { approvalRules: ['chat_space_message'] }),
    ).toBe(true);
  });

  it('trims secrets and long values out of logged parameters', () => {
    const out = trimParams({
      password: 'x',
      content_base64: 'AAAA',
      text: 'a'.repeat(600),
      nested: { api_key: 'k' },
    }) as Record<string, unknown>;
    expect(out.password).toBe('[gizlendi]');
    expect(out.content_base64).toBe('[3 bayt]');
    expect(String(out.text)).toMatch(/600 karakter/);
    expect((out.nested as Record<string, unknown>).api_key).toBe('[gizlendi]');
  });
});

describe('MCP server and OAuth 2.1', () => {
  let app: TestApp;
  let owner: Client;
  let ownerId: string;
  let member: Client;
  let memberId: string;
  let sharedSpaceId: string;

  beforeAll(async () => {
    app = await createTestApp();
    const setup = await setupWithOwner(app);
    owner = setup.owner;
    ownerId = setup.ownerId;
    const spaces = await owner.api.call('listSpaces');
    sharedSpaceId = spaces.items.find((s) => s.name === 'Milvasoft')!.id;
    const joined = await join(app, owner, 'mert@milvasoft.com', 'member', [sharedSpaceId]);
    member = joined.person;
    memberId = joined.me.user.id;
    // The suite makes far more calls per minute than a person would.
    await owner.api.call('updateMcpPolicy', {
      body: { requestsPerMinute: 600, writesPerMinute: 200 },
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('discovery and registration', () => {
    it('answers 401 with resource metadata when no token is sent', async () => {
      const res = await mcp(app, null, 'initialize');
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain(
        `resource_metadata="${API}/.well-known/oauth-protected-resource/mcp"`,
      );
    });

    it('publishes protected resource and authorization server metadata', async () => {
      const prm = await http(app, 'GET', '/.well-known/oauth-protected-resource/mcp');
      expect(prm.json.resource).toBe(RESOURCE);
      expect(prm.json.authorization_servers).toEqual([API]);
      const as = await http(app, 'GET', '/.well-known/oauth-authorization-server');
      expect(as.json.issuer).toBe(API);
      expect(as.json.code_challenge_methods_supported).toEqual(['S256']);
      expect(as.json.registration_endpoint).toBe(`${API}/oauth/register`);
      expect(as.headers.get('access-control-allow-origin')).toBe('*');
    });

    it('registers clients dynamically and refuses unsafe redirect URIs', async () => {
      const ok = await register(app);
      expect(ok.status).toBe(201);
      expect(String(ok.json.client_id)).toMatch(/^mcp_c_/);
      expect(ok.json.token_endpoint_auth_method).toBe('none');
      const bad = await register(app, ['http://evil.example/cb']);
      expect(bad.status).toBe(400);
      expect(bad.json.error).toBe('invalid_redirect_uri');
    });
  });

  describe('authorization', () => {
    it('never redirects to an unregistered redirect_uri', async () => {
      const reg = await register(app);
      const { challenge } = pkce();
      const q = new URLSearchParams({
        response_type: 'code',
        client_id: reg.json.client_id as string,
        redirect_uri: 'https://attacker.example/cb',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      const res = await http(app, 'GET', `/oauth/authorize?${q}`);
      expect(res.status).toBe(400);
      expect(res.headers.get('location')).toBeNull();
    });

    it('requires PKCE S256 and returns the error to the client with state', async () => {
      const reg = await register(app);
      const q = new URLSearchParams({
        response_type: 'code',
        client_id: reg.json.client_id as string,
        redirect_uri: REDIRECT,
        code_challenge: 'plain-challenge-plain-challenge-plain-challenge',
        code_challenge_method: 'plain',
        state: 's1',
      });
      const res = await http(app, 'GET', `/oauth/authorize?${q}`);
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get('location')!);
      expect(loc.searchParams.get('error')).toBe('invalid_request');
      expect(loc.searchParams.get('state')).toBe('s1');
    });

    it('rejects a token request for another resource (RFC 8707)', async () => {
      const reg = await register(app);
      const { challenge } = pkce();
      const q = new URLSearchParams({
        response_type: 'code',
        client_id: reg.json.client_id as string,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource: 'https://other.example/mcp',
      });
      const res = await http(app, 'GET', `/oauth/authorize?${q}`);
      expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe(
        'invalid_target',
      );
    });

    it('hands valid requests to the consent page', async () => {
      const reg = await register(app);
      const { challenge } = pkce();
      const q = new URLSearchParams({
        response_type: 'code',
        client_id: reg.json.client_id as string,
        redirect_uri: 'http://127.0.0.1:61234/callback',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: 'abc',
      });
      const res = await http(app, 'GET', `/oauth/authorize?${q}`);
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get('location')!);
      expect(loc.origin + loc.pathname).toBe('http://localhost:5173/oauth/consent');
      expect(loc.searchParams.get('state')).toBe('abc');
    });

    it('describes the request on the consent page, with the redirect host', async () => {
      const reg = await register(app);
      const { challenge } = pkce();
      const consent = await owner.api.call('getMcpConsent', {
        query: {
          response_type: 'code',
          client_id: reg.json.client_id as string,
          redirect_uri: REDIRECT,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          scope: 'hub:read quick:write',
        },
      });
      expect(consent.client.name).toBe('Claude Code');
      expect(consent.client.redirectHost).toBe('127.0.0.1:53682');
      const byScope = Object.fromEntries(consent.scopes.map((s) => [s.scope, s]));
      expect(byScope['hub:read']!.required).toBe(true);
      expect(byScope['quick:write']!.requested).toBe(true);
      expect(byScope['drive:write']!.requested).toBe(false);
      expect(consent.spaces.map((s) => s.id)).toContain(sharedSpaceId);
      expect(consent.durations).not.toContain('never');
      expect(consent.needsReauth).toBe(false);
    });

    it('consent needs the signed token from this session and our own Origin', async () => {
      const reg = await register(app);
      const { challenge } = pkce();
      const query = {
        response_type: 'code' as const,
        client_id: reg.json.client_id as string,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256' as const,
      };
      const consent = await owner.api.call('getMcpConsent', { query });
      const body = {
        ...query,
        scopes: ['hub:read' as const],
        spaceIds: null,
        duration: '30d' as const,
      };
      await expectApiError(
        owner.api.call('approveMcpConsent', { body: { ...body, consentToken: 'forged.token' } }),
        400,
        'mcp_consent_invalid',
      );
      // Another person's consent token does not work in this session.
      await expectApiError(
        member.api.call('approveMcpConsent', {
          body: { ...body, consentToken: consent.consentToken },
        }),
        400,
        'mcp_consent_invalid',
      );
      const foreign = await owner.raw(
        'POST',
        '/api/v1/mcp/consent',
        { ...body, consentToken: consent.consentToken },
        { Origin: 'https://evil.example' },
      );
      expect(foreign.status).toBe(403);
    });

    it('asks for a recent passkey/password check before granting', async () => {
      const reg = await register(app);
      const { challenge } = pkce();
      const query = {
        response_type: 'code' as const,
        client_id: reg.json.client_id as string,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256' as const,
      };
      await ageSessions(app, memberId);
      const consent = await member.api.call('getMcpConsent', { query });
      expect(consent.needsReauth).toBe(true);
      const body = {
        ...query,
        consentToken: consent.consentToken,
        scopes: ['hub:read' as const],
        spaceIds: null,
        duration: '30d' as const,
      };
      await expectApiError(
        member.api.call('approveMcpConsent', { body }),
        403,
        'mcp_reauth_required',
      );
      await expectApiError(
        member.api.call('mcpReauth', { body: { password: 'wrong-password-123' } }),
        401,
        'mcp_password_invalid',
      );
      await member.api.call('mcpReauth', { body: { password: PASSWORD } });
      const ok = await member.api.call('approveMcpConsent', { body });
      expect(new URL(ok.redirectTo).searchParams.get('code')).toMatch(/^mhc_/);
    });
  });

  describe('token endpoint', () => {
    it('exchanges a code once, with PKCE, and returns state and iss', async () => {
      const reg = await register(app);
      const clientId = reg.json.client_id as string;
      const { verifier, challenge } = pkce();
      const query = {
        response_type: 'code' as const,
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256' as const,
        state: 'st-42',
      };
      const consent = await owner.api.call('getMcpConsent', { query });
      const decision = await owner.api.call('approveMcpConsent', {
        body: {
          ...query,
          consentToken: consent.consentToken,
          scopes: ['hub:read'],
          spaceIds: null,
          duration: '7d',
        },
      });
      const back = new URL(decision.redirectTo);
      expect(back.searchParams.get('state')).toBe('st-42');
      expect(back.searchParams.get('iss')).toBe(API);
      const code = back.searchParams.get('code')!;

      const wrong = await http(app, 'POST', '/oauth/token', {
        form: {
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT,
          client_id: clientId,
          code_verifier: pkce().verifier,
        },
      });
      expect(wrong.status).toBe(400);
      expect(wrong.json.error).toBe('invalid_grant');

      // The failed try consumed the code: a leaked code cannot be retried.
      const again = await http(app, 'POST', '/oauth/token', {
        form: {
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT,
          client_id: clientId,
          code_verifier: verifier,
        },
      });
      expect(again.json.error).toBe('invalid_grant');
      const [grant] = await app.deps.db
        .select()
        .from(mcpGrants)
        .where(eq(mcpGrants.id, decision.grantId!));
      expect(grant!.revokedAt).not.toBeNull();
    });

    it('stores only hashes of codes and tokens', async () => {
      const c = await connect(app, owner, { scopes: ['hub:read'] });
      const tokens = await app.deps.db.select().from(mcpAccessTokens);
      expect(tokens.some((t) => t.tokenHash === c.access)).toBe(false);
      expect(tokens.every((t) => /^[0-9a-f]{64}$/.test(t.tokenHash))).toBe(true);
      const codes = await app.deps.db.select().from(mcpAuthCodes);
      expect(codes.every((x) => /^[0-9a-f]{64}$/.test(x.codeHash))).toBe(true);
      const [grant] = await app.deps.db.select().from(mcpGrants).where(eq(mcpGrants.id, c.grantId));
      expect(grant!.refreshHash).not.toBe(c.refresh);
    });

    it('rejects an expired code', async () => {
      const reg = await register(app);
      const clientId = reg.json.client_id as string;
      const { verifier, challenge } = pkce();
      const query = {
        response_type: 'code' as const,
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256' as const,
      };
      const consent = await owner.api.call('getMcpConsent', { query });
      const decision = await owner.api.call('approveMcpConsent', {
        body: {
          ...query,
          consentToken: consent.consentToken,
          scopes: ['hub:read'],
          spaceIds: null,
          duration: '7d',
        },
      });
      await app.deps.db
        .update(mcpAuthCodes)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(mcpAuthCodes.grantId, decision.grantId!));
      const res = await http(app, 'POST', '/oauth/token', {
        form: {
          grant_type: 'authorization_code',
          code: new URL(decision.redirectTo).searchParams.get('code')!,
          redirect_uri: REDIRECT,
          client_id: clientId,
          code_verifier: verifier,
        },
      });
      expect(res.json.error).toBe('invalid_grant');
    });

    it('rotates refresh tokens; a reused one revokes the whole grant', async () => {
      const c = await connect(app, owner, { scopes: ['hub:read'] });
      const first = await http(app, 'POST', '/oauth/token', {
        form: { grant_type: 'refresh_token', refresh_token: c.refresh, client_id: c.clientId },
      });
      expect(first.status).toBe(200);
      expect(first.json.refresh_token).not.toBe(c.refresh);
      const newAccess = first.json.access_token as string;
      expect((await mcp(app, newAccess, 'tools/list')).status).toBe(200);

      const replay = await http(app, 'POST', '/oauth/token', {
        form: { grant_type: 'refresh_token', refresh_token: c.refresh, client_id: c.clientId },
      });
      expect(replay.json.error).toBe('invalid_grant');
      const after = await mcp(app, newAccess, 'tools/list');
      expect(after.status).toBe(401);
      const rotated = await http(app, 'POST', '/oauth/token', {
        form: {
          grant_type: 'refresh_token',
          refresh_token: first.json.refresh_token as string,
          client_id: c.clientId,
        },
      });
      expect(rotated.json.error).toBe('invalid_grant');
    });

    it('rate-limits the token endpoint per address', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 32; i++) {
        const res = await http(app, 'POST', '/oauth/token', {
          headers: { 'X-Forwarded-For': '198.51.100.9' },
          form: { grant_type: 'refresh_token', refresh_token: 'mhr_nope', client_id: 'nope' },
        });
        statuses.push(res.status);
      }
      expect(statuses).toContain(429);
    });
  });

  describe('tools over OAuth', () => {
    it('lists only the tools of granted scopes; out-of-scope calls get 403', async () => {
      const c = await connect(app, owner, { scopes: ['hub:read', 'quick:write'] });
      const init = await mcp(app, c.access, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      });
      expect(init.status).toBe(200);
      expect((init.json.result as { serverInfo: { name: string } }).serverInfo.name).toBe(
        'crewhall',
      );
      const list = await mcp(app, c.access, 'tools/list');
      const names = (list.json.result as { tools: { name: string }[] }).tools.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(['search', 'list_spaces', 'add_link']));
      expect(names).not.toContain('create_folder');
      expect(names.some((n) => /vault|kasa/i.test(n))).toBe(false);

      const denied = await callTool(app, c.access, 'create_folder', {
        space_id: sharedSpaceId,
        name: 'Yasak',
      });
      expect(denied.status).toBe(403);
      expect(denied.headers.get('www-authenticate')).toContain('error="insufficient_scope"');
      expect(denied.headers.get('www-authenticate')).toContain('scope="drive:write"');
      expect(denied.body.error).toBe('insufficient_scope');
    });

    it('runs tools as the person, logs them and writes audit rows with via', async () => {
      const c = await connect(app, owner, { scopes: ['hub:read', 'quick:write'] });
      const spaces = await callTool(app, c.access, 'list_spaces');
      expect(spaces.isError).toBe(false);
      const added = await callTool(app, c.access, 'add_link', {
        url: 'https://status.example.com/',
        title: 'Status',
      });
      expect(added.isError).toBe(false);
      const cardId = added.data.card_id as string;
      const surfaces = await owner.api.call('listSurfaces');
      const mine = await owner.api.call('getSurface', {
        params: { surfaceId: surfaces.items[0]!.id },
      });
      expect(mine.cards.some((card) => card.id === cardId)).toBe(true);

      const activity = await owner.api.call('listMcpActivity', { query: { filter: 'write' } });
      const row = activity.items.find((i) => i.tool === 'add_link')!;
      expect(row.result).toBe('ok');
      expect(row.canUndo).toBe(true);
      expect(row.via.grantId).toBe(c.grantId);

      const audits = await app.deps.db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.action, 'mcp.tool.call'));
      expect(audits.some((a) => (a.via as { kind?: string } | null)?.kind === 'mcp')).toBe(true);

      const undone = await owner.api.call('undoMcpToolCall', { params: { callNo: row.id } });
      expect(undone.undoneAt).not.toBeNull();
      const after = await owner.api.call('getSurface', {
        params: { surfaceId: surfaces.items[0]!.id },
      });
      expect(after.cards.some((card) => card.id === cardId)).toBe(false);
      await expectApiError(
        owner.api.call('undoMcpToolCall', { params: { callNo: row.id } }),
        410,
        'mcp_undo_unavailable',
      );
    });

    it('a write with the same Idempotency-Key runs once', async () => {
      const c = await connect(app, owner, { scopes: ['hub:read', 'quick:write'] });
      const args = { type: 'note', text: 'idempotent' };
      const a = await callTool(app, c.access, 'add_quick_card', args, { 'Idempotency-Key': 'k-1' });
      const b = await callTool(app, c.access, 'add_quick_card', args, { 'Idempotency-Key': 'k-1' });
      expect(b.data.card_id).toBe(a.data.card_id);
      const other = await callTool(
        app,
        c.access,
        'add_quick_card',
        { type: 'note', text: 'x' },
        {
          'Idempotency-Key': 'k-1',
        },
      );
      expect(other.data.error).toBe('idempotency_key_reused');
    });

    it('a disconnected client gets 401 on its next call', async () => {
      const c = await connect(app, owner, { scopes: ['hub:read'] });
      expect((await mcp(app, c.access, 'tools/list')).status).toBe(200);
      const grants = await owner.api.call('listMcpGrants');
      expect(grants.items.some((g) => g.id === c.grantId)).toBe(true);
      await owner.api.call('revokeMcpGrant', { params: { grantId: c.grantId } });
      const res = await mcp(app, c.access, 'tools/list');
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"');
      const refresh = await http(app, 'POST', '/oauth/token', {
        form: { grant_type: 'refresh_token', refresh_token: c.refresh, client_id: c.clientId },
      });
      expect(refresh.json.error).toBe('invalid_grant');
    });

    it('another api node sees the revoke once its 30 s cache entry is gone', async () => {
      const c = await connect(app, owner, { scopes: ['hub:read'] });
      expect((await mcp(app, c.access, 'tools/list')).status).toBe(200);
      // Revoke straight in the database (as another node would), then drop the cache entry
      // the way its 30 s lifetime would.
      await app.deps.db
        .update(mcpGrants)
        .set({ revokedAt: new Date() })
        .where(eq(mcpGrants.id, c.grantId));
      invalidatePrincipals({ all: true });
      expect((await mcp(app, c.access, 'tools/list')).status).toBe(401);
    });

    it('narrowing a grant applies to the next call; widening asks to re-verify', async () => {
      const c = await connect(app, owner, { scopes: ['hub:read', 'quick:write'] });
      await owner.api.call('updateMcpGrant', {
        params: { grantId: c.grantId },
        body: { scopes: ['hub:read'] },
      });
      const denied = await callTool(app, c.access, 'add_link', { url: 'https://a.example/' });
      expect(denied.status).toBe(403);
      await ageSessions(app, ownerId);
      await expectApiError(
        owner.api.call('updateMcpGrant', {
          params: { grantId: c.grantId },
          body: { scopes: ['hub:read', 'quick:write'] },
        }),
        403,
        'mcp_reauth_required',
      );
      await owner.api.call('mcpReauth', { body: { password: PASSWORD } });
      const wide = await owner.api.call('updateMcpGrant', {
        params: { grantId: c.grantId },
        body: { scopes: ['hub:read', 'quick:write'] },
      });
      expect(wide.scopes).toContain('quick:write');
    });

    it('refuses an access token bound to another resource (audience)', async () => {
      const c = await connect(app, owner, { scopes: ['hub:read'] });
      expect((await mcp(app, c.access, 'tools/list')).status).toBe(200);
      await app.deps.db
        .update(mcpAccessTokens)
        .set({ resource: 'https://other.example/mcp' })
        .where(eq(mcpAccessTokens.grantId, c.grantId));
      invalidatePrincipals({ grantId: c.grantId });
      expect((await mcp(app, c.access, 'tools/list')).status).toBe(401);
    });

    it('rejects foreign browser origins and wrong methods on /mcp', async () => {
      const c = await connect(app, owner, { scopes: ['hub:read'] });
      const evil = await mcp(app, c.access, 'tools/list', {}, { Origin: 'https://evil.example' });
      expect(evil.status).toBe(403);
      const get = await http(app, 'GET', '/mcp', {
        headers: { Authorization: `Bearer ${c.access}` },
      });
      expect(get.status).toBe(405);
    });
  });

  describe('personal access tokens', () => {
    it('shows the value once, stores a hash, honours spaces and revocation', async () => {
      const created = await member.api.call('createMcpToken', {
        body: {
          name: 'CI',
          scopes: ['hub:read', 'drive:write'],
          spaceIds: [personalIdOf(await member.api.call('listSpaces'))],
          expiresInDays: 30,
        },
      });
      expect(created.value).toMatch(/^mhp_[0-9A-Za-z]{40}$/);
      expect(created.token.prefix).toBe(created.value.slice(0, 8));
      const [row] = await app.deps.db
        .select()
        .from(apiTokens)
        .where(eq(apiTokens.id, created.token.id));
      expect(row!.tokenHash).not.toContain(created.value);
      const listed = await member.api.call('listMcpTokens');
      expect(JSON.stringify(listed)).not.toContain(created.value);

      const own = await callTool(app, created.value, 'list_spaces');
      expect((own.data.items as unknown[]).length).toBe(1);
      const outside = await callTool(app, created.value, 'create_folder', {
        space_id: sharedSpaceId,
        name: 'Dışarıda',
      });
      expect(outside.isError).toBe(true);
      expect(outside.data.error).toBe('space_not_in_connection');

      await member.api.call('revokeMcpToken', { params: { tokenId: created.token.id } });
      expect((await mcp(app, created.value, 'tools/list')).status).toBe(401);
    });

    it('respects the policy maximum lifetime and IP limits', async () => {
      await expectApiError(
        member.api.call('createMcpToken', {
          body: { name: 'Forever', scopes: ['hub:read'], spaceIds: null, expiresInDays: null },
        }),
        422,
        'mcp_expiry_not_allowed',
      );
      const t = await member.api.call('createMcpToken', {
        body: {
          name: 'Office',
          scopes: ['hub:read'],
          spaceIds: null,
          expiresInDays: 10,
          allowedIps: ['10.8.0.0/24'],
        },
      });
      const outside = await mcp(
        app,
        t.value,
        'tools/list',
        {},
        { 'X-Forwarded-For': '203.0.113.5' },
      );
      expect(outside.status).toBe(401);
      const inside = await mcp(app, t.value, 'tools/list', {}, { 'X-Forwarded-For': '10.8.0.20' });
      expect(inside.status).toBe(200);
    });
  });

  describe('approval queue', () => {
    let token: string;

    beforeAll(async () => {
      const created = await owner.api.call('createMcpToken', {
        body: {
          name: 'Drive',
          scopes: ['hub:read', 'drive:write'],
          spaceIds: null,
          expiresInDays: 30,
        },
      });
      token = created.value;
    });

    async function folder(name: string) {
      const res = await callTool(app, token, 'create_folder', { space_id: sharedSpaceId, name });
      expect(res.isError).toBe(false);
      return res.data.node_id as string;
    }

    it('trash goes to the queue, applies after a verified approval and can be undone', async () => {
      const nodeId = await folder('Eski notlar');
      const pending = await callTool(app, token, 'trash_nodes', {
        node_ids: [nodeId],
        note: 'Kullanıcı istedi',
      });
      expect(pending.isError).toBe(false);
      expect(pending.data.status).toBe('pending_approval');
      const approvalId = pending.data.approval_id as string;
      const [still] = await app.deps.db.select().from(nodes).where(eq(nodes.id, nodeId));
      expect(still!.deletedAt).toBeNull();

      const list = await owner.api.call('listMcpApprovals', { query: { status: 'pending' } });
      expect(list.items.map((i) => i.id)).toContain(approvalId);
      const detail = await owner.api.call('getMcpApproval', { params: { approvalId } });
      expect(detail.items[0]!.label).toBe('Eski notlar');
      expect(detail.clientNote).toBe('Kullanıcı istedi');
      expect(app.mailer.outbox.some((m) => m.subject.includes('onay'))).toBe(true);

      await ageSessions(app, ownerId);
      await expectApiError(
        owner.api.call('approveMcpApproval', { params: { approvalId } }),
        403,
        'mcp_reauth_required',
      );
      await owner.api.call('mcpReauth', { body: { password: PASSWORD } });
      const approved = await owner.api.call('approveMcpApproval', { params: { approvalId } });
      expect(approved.status).toBe('applied');
      const [gone] = await app.deps.db.select().from(nodes).where(eq(nodes.id, nodeId));
      expect(gone!.deletedAt).not.toBeNull();

      const status = await callTool(app, token, 'get_approval', { approval_id: approvalId });
      expect(status.data.status).toBe('applied');

      const activity = await owner.api.call('listMcpActivity', { query: { filter: 'all' } });
      const call = activity.items.find((i) => i.approvalId === approvalId)!;
      expect(call.result).toBe('ok');
      expect(call.canUndo).toBe(true);
      await owner.api.call('undoMcpToolCall', { params: { callNo: call.id } });
      const [back] = await app.deps.db.select().from(nodes).where(eq(nodes.id, nodeId));
      expect(back!.deletedAt).toBeNull();
    });

    it('a target changed while waiting makes the request stale', async () => {
      const nodeId = await folder('Değişecek');
      const pending = await callTool(app, token, 'trash_nodes', { node_ids: [nodeId] });
      const approvalId = pending.data.approval_id as string;
      await owner.api.call('updateNode', { params: { nodeId }, body: { name: 'Değişti' } });
      await expectApiError(
        owner.api.call('approveMcpApproval', { params: { approvalId } }),
        409,
        'mcp_approval_closed',
      );
      const detail = await owner.api.call('getMcpApproval', { params: { approvalId } });
      expect(detail.status).toBe('stale');
    });

    it('rejected requests leave the target alone and tell the client', async () => {
      const nodeId = await folder('Kalsın');
      const pending = await callTool(app, token, 'trash_nodes', { node_ids: [nodeId] });
      const approvalId = pending.data.approval_id as string;
      const rejected = await owner.api.call('rejectMcpApproval', {
        params: { approvalId },
        body: {},
      });
      expect(rejected.status).toBe('rejected');
      const [kept] = await app.deps.db.select().from(nodes).where(eq(nodes.id, nodeId));
      expect(kept!.deletedAt).toBeNull();
      const status = await callTool(app, token, 'get_approval', { approval_id: approvalId });
      expect(status.data.status).toBe('rejected');
      await expectApiError(
        owner.api.call('approveMcpApproval', { params: { approvalId } }),
        409,
        'mcp_approval_closed',
      );
    });

    it('another person cannot see or decide my requests', async () => {
      const nodeId = await folder('Benim');
      const pending = await callTool(app, token, 'trash_nodes', { node_ids: [nodeId] });
      await expectApiError(
        member.api.call('getMcpApproval', {
          params: { approvalId: pending.data.approval_id as string },
        }),
        404,
      );
    });
  });

  describe('org policy and limits', () => {
    it('limits writes per minute with 429 and Retry-After', async () => {
      await owner.api.call('updateMcpPolicy', { body: { writesPerMinute: 2 } });
      const t = await owner.api.call('createMcpToken', {
        body: {
          name: 'Burst',
          scopes: ['hub:read', 'quick:write'],
          spaceIds: null,
          expiresInDays: 1,
        },
      });
      // A fresh person-wide bucket: reset the counters other tests left behind.
      await app.deps.db.execute(sql`delete from mcp_rate_buckets`);
      const results = [];
      for (let i = 0; i < 3; i++) {
        results.push(
          await callTool(app, t.value, 'add_quick_card', { type: 'note', text: `n${i}` }),
        );
      }
      expect(results[0]!.status).toBe(200);
      expect(results[2]!.status).toBe(429);
      expect(Number(results[2]!.headers.get('retry-after'))).toBeGreaterThan(0);
      await owner.api.call('updateMcpPolicy', { body: { writesPerMinute: 200 } });
    });

    it('a scope taken out of the policy drops from live connections', async () => {
      const c = await connect(app, owner, { scopes: ['hub:read', 'quick:write'] });
      const all = (await owner.api.call('getMcpPolicy')).allowedScopes;
      await owner.api.call('updateMcpPolicy', {
        body: { allowedScopes: all.filter((s) => s !== 'quick:write') },
      });
      const list = await mcp(app, c.access, 'tools/list');
      const names = (list.json.result as { tools: { name: string }[] }).tools.map((t) => t.name);
      expect(names).not.toContain('add_link');
      const [grant] = await app.deps.db.select().from(mcpGrants).where(eq(mcpGrants.id, c.grantId));
      expect(grant!.scopes).not.toContain('quick:write');
      await owner.api.call('updateMcpPolicy', { body: { allowedScopes: all } });
    });

    it('turning MCP off answers 403 on /mcp', async () => {
      const c = await connect(app, owner, { scopes: ['hub:read'] });
      await owner.api.call('updateMcpPolicy', { body: { enabled: false } });
      const res = await mcp(app, c.access, 'tools/list');
      expect(res.status).toBe(403);
      expect(res.json.error).toBe('mcp_disabled');
      const overview = await owner.api.call('getMcpOverview');
      expect(overview.enabled).toBe(false);
      await owner.api.call('updateMcpPolicy', { body: { enabled: true } });
    });

    it('"listed" clients wait for an admin before anyone can connect', async () => {
      await owner.api.call('updateMcpPolicy', { body: { clientMode: 'listed' } });
      const reg = await register(app, [REDIRECT], 'mcp-inspector');
      const clientId = reg.json.client_id as string;
      const { challenge } = pkce();
      const query = {
        response_type: 'code' as const,
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256' as const,
      };
      const consent = await owner.api.call('getMcpConsent', { query });
      expect(consent.client.status).toBe('pending');
      await expectApiError(
        owner.api.call('approveMcpConsent', {
          body: {
            ...query,
            consentToken: consent.consentToken,
            scopes: ['hub:read'],
            spaceIds: null,
            duration: '7d',
          },
        }),
        403,
        'mcp_client_pending',
      );
      const clients = await owner.api.call('listMcpClients');
      const row = clients.items.find((c) => c.clientId === clientId)!;
      await owner.api.call('updateMcpClient', {
        params: { mcpClientId: row.id },
        body: { status: 'allowed' },
      });
      const ok = await connect(app, owner, { scopes: ['hub:read'], clientId });
      expect(ok.access).toMatch(/^mha_/);
      await owner.api.call('updateMcpPolicy', { body: { clientMode: 'all' } });
    });

    it('policy and the org connection list are for admins only', async () => {
      await expectApiError(member.api.call('getMcpPolicy'), 403);
      await expectApiError(member.api.call('listMcpOrgConnections', { query: {} }), 403);
      const list = await owner.api.call('listMcpOrgConnections', { query: {} });
      expect(list.items.length).toBeGreaterThan(0);
      expect(JSON.stringify(list)).not.toMatch(/mhp_[0-9A-Za-z]{40}|mha_/);
      const usage = await owner.api.call('getMcpUsage', { query: {} });
      expect(usage.tools.length).toBeGreaterThan(0);
    });

    it('sends a new-connection notice to the person', async () => {
      const before = app.mailer.outbox.length;
      await connect(app, member, { scopes: ['hub:read'] });
      const mails = app.mailer.outbox.slice(before);
      expect(mails.some((m) => m.to === 'mert@milvasoft.com')).toBe(true);
      // Owners get the same security notice when someone else connects.
      expect(mails.some((m) => m.to === 'bugra@milvasoft.com')).toBe(true);
    });

    it('the tool catalog is generated from the schemas', async () => {
      const catalog = await owner.api.call('getMcpToolCatalog');
      const search = catalog.tools.find((t) => t.name === 'search')!;
      expect(search.inputSchema).toMatchObject({ type: 'object' });
      expect(catalog.resources[0]!.uriTemplate).toBe('crewhall://page/{id}');
      expect(catalog.tools.some((t) => /vault|kasa/i.test(t.name))).toBe(false);
    });
  });

  it('tool_calls rows exist for every call', async () => {
    const [row] = await app.deps.db
      .select({ n: sql<number>`count(*)::int` })
      .from(toolCalls)
      .where(and(eq(toolCalls.userId, ownerId)));
    expect(row!.n).toBeGreaterThan(5);
  });

  function personalIdOf(list: { items: { id: string; kind: string }[] }) {
    return list.items.find((s) => s.kind === 'personal')!.id;
  }
});
