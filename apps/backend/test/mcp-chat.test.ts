import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { messages, organizations } from '@crewhall/db';
import { forgetChatModule } from '../src/services/chat/module';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';
import { callTool, connect, mcp } from './mcp-helpers';

/** Chat tools over MCP (doc 17 §13): send_message, list_conversations, list_notifications. */
describe('MCP chat tools', () => {
  let app: TestApp;
  let owner: Client;
  let orgId: string;
  let mert: Client;
  let mertId: string;
  let spaceId: string;
  let token: string;

  async function setModules(modules: Record<string, boolean> | null) {
    await app.deps.db.execute(
      modules
        ? sql`update ${organizations} set settings = jsonb_set(settings, '{modules}', ${JSON.stringify(modules)}::jsonb) where id = ${orgId}`
        : sql`update ${organizations} set settings = settings - 'modules' where id = ${orgId}`,
    );
    forgetChatModule();
  }

  const toolNames = async (t: string) => {
    const res = await mcp(app, t, 'tools/list');
    return (res.json.result as { tools: { name: string }[] }).tools.map((x) => x.name);
  };

  beforeAll(async () => {
    app = await createTestApp();
    const setup = await setupWithOwner(app);
    owner = setup.owner;
    orgId = setup.orgId;
    spaceId = (await owner.api.call('listSpaces')).items.find((s) => s.name === 'Milvasoft')!.id;
    const joined = await join(app, owner, 'mert@milvasoft.com', 'member', [spaceId]);
    mert = joined.person;
    mertId = joined.me.user.id;
    await owner.api.call('updateMcpPolicy', {
      body: { requestsPerMinute: 600, writesPerMinute: 200 },
    });
    const created = await owner.api.call('createMcpToken', {
      body: { name: 'Chat', scopes: ['hub:read', 'chat:send'], spaceIds: null, expiresInDays: 30 },
    });
    token = created.value;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('lists the chat tools for a connection with chat:send', async () => {
    const names = await toolNames(token);
    expect(names).toEqual(
      expect.arrayContaining(['send_message', 'list_conversations', 'list_notifications']),
    );
    const readOnly = await connect(app, owner, { scopes: ['hub:read'] });
    const readNames = await toolNames(readOnly.access);
    expect(readNames).toContain('list_conversations');
    expect(readNames).not.toContain('send_message');
    const denied = await callTool(app, readOnly.access, 'send_message', {
      conversation_id: crypto.randomUUID(),
      text: 'x',
    });
    expect(denied.status).toBe(403);
  });

  it('sends a direct message as the person, marked as sent through MCP, and undoes it', async () => {
    const dm = await owner.api.call('createConversation', {
      body: { type: 'direct', userId: mertId },
    });
    const sent = await callTool(app, token, 'send_message', {
      conversation_id: dm.id,
      text: 'Sürüm notları hazır.',
    });
    expect(sent.isError).toBe(false);
    const messageId = sent.data.message_id as string;

    const list = await mert.api.call('listMessages', {
      params: { conversationId: dm.id },
      query: {},
    });
    const msg = list.items.find((m) => m.id === messageId)!;
    expect(msg.author?.name).toBe('Ahmet Buğra Kösen');
    expect(msg.text).toBe('Sürüm notları hazır.');
    // The contract carries it too: the person is the author, the client is the via.
    expect(msg.via).toEqual({ kind: 'mcp', client: 'Chat' });
    const own = await owner.api.call('sendMessage', {
      params: { conversationId: dm.id },
      body: { clientMsgId: crypto.randomUUID(), text: 'elle yazdım' },
    });
    expect(own.via ?? null).toBeNull();
    const [row] = await app.deps.db.select().from(messages).where(eq(messages.id, messageId));
    expect((row!.body as { via?: { kind: string; client: string } }).via).toMatchObject({
      kind: 'mcp',
      client: 'Chat',
    });

    const conversations = await callTool(app, token, 'list_conversations', {});
    expect((conversations.data.items as { id: string }[]).map((c) => c.id)).toContain(dm.id);

    const mertToken = (
      await mert.api.call('createMcpToken', {
        body: { name: 'Mert', scopes: ['hub:read'], spaceIds: null, expiresInDays: 7 },
      })
    ).value;
    const notes = await callTool(app, mertToken, 'list_notifications', {});
    expect(notes.isError).toBe(false);
    expect((notes.data.items as unknown[]).length).toBeGreaterThan(0);

    const activity = await owner.api.call('listMcpActivity', { query: { filter: 'write' } });
    const call = activity.items.find((c) => c.tool === 'send_message')!;
    expect(call.canUndo).toBe(true);
    await owner.api.call('undoMcpToolCall', { params: { callNo: call.id } });
    const [gone] = await app.deps.db.select().from(messages).where(eq(messages.id, messageId));
    expect(gone!.deletedAt).not.toBeNull();
  });

  it('space messages go straight out unless the policy asks for an approval', async () => {
    const conv = await owner.api.call('createConversation', {
      body: { type: 'space', spaceId, name: 'Milvaion Ekibi' },
    });
    const direct = await callTool(app, token, 'send_message', {
      conversation_id: conv.id,
      text: 'Herkese merhaba',
    });
    expect(direct.data.message_id).toBeTruthy();

    const policy = await owner.api.call('getMcpPolicy');
    await owner.api.call('updateMcpPolicy', {
      body: { approvalRules: [...policy.approvalRules, 'chat_space_message'] },
    });
    const pending = await callTool(app, token, 'send_message', {
      conversation_id: conv.id,
      text: 'Yayın bugün 17:00',
      note: 'Kullanıcı istedi',
    });
    expect(pending.data.status).toBe('pending_approval');
    const approvalId = pending.data.approval_id as string;
    const before = await owner.api.call('listMessages', {
      params: { conversationId: conv.id },
      query: {},
    });
    expect(before.items.some((m) => m.text === 'Yayın bugün 17:00')).toBe(false);

    const approved = await owner.api.call('approveMcpApproval', { params: { approvalId } });
    expect(approved.status).toBe('applied');
    const after = await owner.api.call('listMessages', {
      params: { conversationId: conv.id },
      query: {},
    });
    const msg = after.items.find((m) => m.text === 'Yayın bugün 17:00')!;
    const [row] = await app.deps.db.select().from(messages).where(eq(messages.id, msg.id));
    expect((row!.body as { via?: { kind: string } }).via?.kind).toBe('mcp');
    await owner.api.call('updateMcpPolicy', { body: { approvalRules: policy.approvalRules } });
  });

  it('keeps space limits: a connection without the space cannot post there', async () => {
    const conv = await owner.api.call('createConversation', {
      body: { type: 'space', spaceId, name: 'Duyurular' },
    });
    const personal = (await owner.api.call('listSpaces')).items.find((s) => s.kind === 'personal')!;
    const narrow = (
      await owner.api.call('createMcpToken', {
        body: {
          name: 'Dar',
          scopes: ['hub:read', 'chat:send'],
          spaceIds: [personal.id],
          expiresInDays: 7,
        },
      })
    ).value;
    const res = await callTool(app, narrow, 'send_message', {
      conversation_id: conv.id,
      text: 'x',
    });
    expect(res.data.error).toBe('space_not_in_connection');
    const listed = await callTool(app, narrow, 'list_conversations', {});
    expect((listed.data.items as { id: string }[]).map((c) => c.id)).not.toContain(conv.id);
  });

  it('hides the chat tools while the org has chat off', async () => {
    await setModules({ chat: false });
    try {
      const names = await toolNames(token);
      expect(names).not.toContain('send_message');
      expect(names).not.toContain('list_conversations');
      expect(names).toContain('search');
      // Not a scope problem: the tool does not exist for this org right now.
      const call = await callTool(app, token, 'list_conversations', {});
      expect(call.status).toBe(200);
      expect(call.data.error).toBe('unknown_tool');
      const catalog = await owner.api.call('getMcpToolCatalog');
      expect(catalog.tools.map((t) => t.name)).not.toContain('send_message');
    } finally {
      await setModules(null);
    }
  });

  it('turning the MCP module off closes /mcp', async () => {
    await setModules({ mcp: false });
    try {
      const res = await mcp(app, token, 'tools/list');
      expect(res.status).toBe(403);
      expect(res.json.error).toBe('mcp_disabled');
    } finally {
      await setModules(null);
    }
    expect((await mcp(app, token, 'tools/list')).status).toBe(200);
  });
});
