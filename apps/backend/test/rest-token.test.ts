import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { apiTokens, auditLogs, messages } from '@crewhall/db';
import { endpoints, MODULE_OF_ENDPOINT, type EndpointName, type McpScope } from '@crewhall/shared';
import { ApiError } from '@crewhall/api-client';
import { invalidatePrincipals } from '../src/services/mcp/principal';
import { tokenScopeOf } from '../src/services/mcp/rest';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/** Personal access tokens on the REST API (design 18.4, 18.14). */

describe('token scope map', () => {
  it('keeps the vault, MCP management, identity and account endpoints away from tokens', () => {
    for (const name of Object.keys(endpoints) as EndpointName[]) {
      const module = MODULE_OF_ENDPOINT[name];
      if (module === 'vault' || module === 'mcp') expect(tokenScopeOf(name), name).toBeNull();
      if (endpoints[name].path.startsWith('/api/v1/identity'))
        expect(tokenScopeOf(name), name).toBeNull();
    }
    for (const name of [
      'updateMe',
      'listSessions',
      'revokeSession',
      'trashNodes',
      'createShare',
      'clearConversation',
      'deleteConversation',
    ] as const) {
      expect(tokenScopeOf(name), name).toBeNull();
    }
    expect(tokenScopeOf('listSpaces')).toBe('hub:read');
    expect(tokenScopeOf('createFolder')).toBe('drive:write');
    expect(tokenScopeOf('createCard')).toBe('quick:write');
    expect(tokenScopeOf('sendMessage')).toBe('chat:send');
  });
});

describe('REST API with personal access tokens', () => {
  let app: TestApp;
  let owner: Client;
  let sharedId: string;
  let personalId: string;
  let mertId: string;

  async function tokenClient(
    scopes: McpScope[],
    spaceIds: string[] | null = null,
    name = 'CI',
  ): Promise<{ c: Client; id: string; value: string }> {
    const created = await owner.api.call('createMcpToken', {
      body: { name, scopes, spaceIds, expiresInDays: 30 },
    });
    const c = new Client(app);
    c.bearer = created.value;
    return { c, id: created.token.id, value: created.value };
  }

  async function expectCode(p: Promise<unknown>, status: number, code?: string) {
    try {
      await p;
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(status);
      if (code) expect((err as ApiError).code).toBe(code);
      return;
    }
    throw new Error(`expected ${status}`);
  }

  beforeAll(async () => {
    app = await createTestApp();
    ({ owner } = await setupWithOwner(app));
    const spaces = await owner.api.call('listSpaces');
    sharedId = spaces.items.find((s) => s.name === 'Milvasoft')!.id;
    personalId = spaces.items.find((s) => s.kind === 'personal')!.id;
    mertId = (await join(app, owner, 'mert@milvasoft.com', 'member', [sharedId])).me.user.id;
    await owner.api.call('updateMcpPolicy', {
      body: { requestsPerMinute: 600, writesPerMinute: 200 },
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('reads as the token owner', async () => {
    const { c } = await tokenClient(['hub:read']);
    const me = await c.api.call('me');
    expect(me.user.email).toBe('bugra@milvasoft.com');
    const spaces = await c.api.call('listSpaces');
    expect(spaces.items.map((s) => s.id)).toContain(sharedId);
    const nodes = await c.api.call('listNodes', { params: { spaceId: sharedId }, query: {} });
    expect(Array.isArray(nodes.items)).toBe(true);
  });

  it('refuses writes outside the token scope with 403 token_scope', async () => {
    const reader = await tokenClient(['hub:read']);
    await expectCode(
      reader.c.api.call('createFolder', {
        params: { spaceId: sharedId },
        body: { parentId: null, name: 'Okuyucu' },
      }),
      403,
      'token_scope',
    );
    const writer = await tokenClient(['hub:read', 'drive:write']);
    const folder = await writer.c.api.call('createFolder', {
      params: { spaceId: sharedId },
      body: { parentId: null, name: 'CI çıktıları' },
    });
    expect(folder.name).toBe('CI çıktıları');
    // Trash waits for a person on MCP; over REST it is not available to tokens at all.
    await expectCode(
      writer.c.api.call('trashNodes', { body: { nodeIds: [folder.id] } }),
      403,
      'token_scope',
    );
  });

  it('never reaches account, security, MCP management or the vault', async () => {
    const { c } = await tokenClient(['hub:read', 'drive:write', 'quick:write', 'chat:send']);
    await expectCode(c.api.call('updateMe', { body: { name: 'x' } }), 403, 'token_scope');
    await expectCode(c.api.call('listSessions'), 403, 'token_scope');
    await expectCode(c.api.call('listMcpTokens'), 403, 'token_scope');
    await expectCode(c.api.call('getSecurityPolicy'), 403, 'token_scope');
    await expectCode(c.api.call('vaultKeys'), 403, 'token_scope');
  });

  it('keeps to the token spaces: lists are narrowed, other spaces do not exist', async () => {
    const { c } = await tokenClient(['hub:read', 'drive:write'], [personalId], 'Kişisel');
    const spaces = await c.api.call('listSpaces');
    expect(spaces.items.map((s) => s.id)).toEqual([personalId]);
    await expectCode(
      c.api.call('listNodes', { params: { spaceId: sharedId }, query: {} }),
      404,
      'not_found',
    );
    await expectCode(
      c.api.call('createFolder', {
        params: { spaceId: sharedId },
        body: { parentId: null, name: 'Dışarı' },
      }),
      404,
    );
    const own = await c.api.call('createFolder', {
      params: { spaceId: personalId },
      body: { parentId: null, name: 'İçeri' },
    });
    expect(own.spaceId).toBe(personalId);
  });

  it('answers 401 for revoked, expired and unknown tokens', async () => {
    const revoked = await tokenClient(['hub:read']);
    expect((await revoked.c.api.call('listSpaces')).items.length).toBeGreaterThan(0);
    await owner.api.call('revokeMcpToken', { params: { tokenId: revoked.id } });
    await expectCode(revoked.c.api.call('listSpaces'), 401, 'unauthenticated');

    const expired = await tokenClient(['hub:read']);
    await app.deps.db
      .update(apiTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(apiTokens.id, expired.id));
    invalidatePrincipals({ tokenId: expired.id });
    await expectCode(expired.c.api.call('listSpaces'), 401);

    const unknown = new Client(app);
    unknown.bearer = `mhp_${'x'.repeat(40)}`;
    await expectCode(unknown.api.call('listSpaces'), 401);
    // Not a personal token: the normal session path answers as before.
    const other = new Client(app);
    other.bearer = 'not-a-session-token';
    await expectCode(other.api.call('listSpaces'), 401);
  });

  it('marks chat messages and audit rows as sent through the API', async () => {
    const dm = await owner.api.call('createConversation', {
      body: { type: 'direct', userId: mertId },
    });
    const { c, id } = await tokenClient(['hub:read', 'chat:send'], null, 'Dokploy deploy notu');
    const sent = await c.api.call('sendMessage', {
      params: { conversationId: dm.id },
      body: { clientMsgId: crypto.randomUUID(), text: 'Deploy bitti' },
    });
    expect(sent.via).toEqual({ kind: 'api', client: 'Dokploy deploy notu' });
    const [row] = await app.deps.db.select().from(messages).where(eq(messages.id, sent.id));
    expect(row!.body.via).toMatchObject({ kind: 'api', token: id });
    const list = await owner.api.call('listMessages', {
      params: { conversationId: dm.id },
      query: {},
    });
    expect(list.items.find((m) => m.id === sent.id)?.via?.client).toBe('Dokploy deploy notu');

    const writer = await tokenClient(['hub:read', 'drive:write'], null, 'Yedek');
    await writer.c.api.call('moveNodes', {
      body: {
        nodeIds: [
          (
            await writer.c.api.call('createFolder', {
              params: { spaceId: sharedId },
              body: { parentId: null, name: 'Taşınacak' },
            })
          ).id,
        ],
        target: { spaceId: personalId, parentId: null },
      },
    });
    const audits = await app.deps.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'node.move')));
    expect(audits.some((a) => (a.via as { kind?: string } | null)?.kind === 'api')).toBe(true);
  });

  it('turning tokens off in the policy closes the REST API to them', async () => {
    const { c } = await tokenClient(['hub:read']);
    await owner.api.call('updateMcpPolicy', { body: { patsEnabled: false } });
    try {
      await expectCode(c.api.call('listSpaces'), 403, 'mcp_tokens_disabled');
    } finally {
      await owner.api.call('updateMcpPolicy', { body: { patsEnabled: true } });
    }
  });
});
