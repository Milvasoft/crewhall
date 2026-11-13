import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@crewhall/api-client';
import { listen, uuid, WsClient } from './chat-helpers';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';
import { callTool } from './mcp-helpers';

/**
 * Private space channels (Teams-like): only the people added see the channel, its messages,
 * notifications, search hits, WS events and MCP results; owners and space admins manage people.
 */

let app: TestApp;
let server: Awaited<ReturnType<typeof listen>>;
let owner: Client;
let elif: Client;
let can: Client;
let ayse: Client;
let outsider: Client;
let elifId: string;
let canId: string;
let ayseId: string;
let outsiderId: string;
let spaceId: string;
let ownerId: string;

const send = (c: Client, conversationId: string, text: string) =>
  c.api.call('sendMessage', { params: { conversationId }, body: { clientMsgId: uuid(), text } });
const listIds = async (c: Client) =>
  (await c.api.call('listConversations', { query: {} })).items.map((x) => x.id);
const texts = async (c: Client, conversationId: string) =>
  (await c.api.call('listMessages', { params: { conversationId }, query: {} })).items
    .filter((m) => m.kind === 'user')
    .map((m) => m.text);
const memberNames = async (c: Client, conversationId: string) =>
  (await c.api.call('listConversationMembers', { params: { conversationId } })).items
    .map((m) => `${m.user.name}:${m.role ?? '-'}`)
    .sort();

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
  server = await listen(app);
  ({ owner } = await setupWithOwner(app));
  ownerId = (await owner.api.call('me')).user.id;
  // A space of its own: the default space takes in everyone who joins the org.
  spaceId = (await owner.api.call('createSpace', { body: { name: 'Proje', color: 's2' } })).id;
  const e = await join(app, owner, 'elif@milvasoft.com', 'member', [spaceId]);
  elif = e.person;
  elifId = e.me.user.id;
  const c = await join(app, owner, 'can@milvasoft.com', 'member', [spaceId]);
  can = c.person;
  canId = c.me.user.id;
  const a = await join(app, owner, 'ayse@milvasoft.com', 'member', [spaceId]);
  ayse = a.person;
  ayseId = a.me.user.id;
  // In the org but not in the space.
  const o = await join(app, owner, 'oguz@milvasoft.com', 'member', []);
  outsider = o.person;
  outsiderId = o.me.user.id;
  // Elif and Can open channels (space editors); Ayşe stays a plain (invited) member.
  for (const userId of [elifId, canId]) {
    await owner.api.call('updateSpaceMember', {
      params: { spaceId, userId },
      body: { role: 'editor' },
    });
  }
});

afterAll(async () => {
  await server.close();
  await app.close();
});

describe('private space channels', () => {
  it('shows a private channel, its messages and search hits to its members only', async () => {
    const ch = await elif.api.call('createConversation', {
      body: { type: 'space', spaceId, name: 'Gizli proje', private: true, userIds: [canId] },
    });
    expect(ch.private).toBe(true);
    expect(ch.memberCount).toBe(2);
    expect(ch.permissions.manage).toBe(true);
    await send(elif, ch.id, 'gizlibilgi burada');

    // Members see it.
    expect(await listIds(can)).toContain(ch.id);
    expect(await texts(can, ch.id)).toEqual(['gizlibilgi burada']);
    expect(await memberNames(elif, ch.id)).toEqual(['can:member', 'elif:owner']);
    const canView = await can.api.call('getConversation', { params: { conversationId: ch.id } });
    expect(canView.permissions.manage).toBe(false);
    expect(canView.permissions.write).toBe(true);

    // A space member who was not added sees nothing, not even that it exists.
    expect(await listIds(ayse)).not.toContain(ch.id);
    await expectCode(
      ayse.api.call('getConversation', { params: { conversationId: ch.id } }),
      404,
      'not_found',
    );
    await expectCode(
      ayse.api.call('listMessages', { params: { conversationId: ch.id }, query: {} }),
      404,
    );
    await expectCode(send(ayse, ch.id, 'merhaba'), 404);
    await expectCode(
      ayse.api.call('listConversationMembers', { params: { conversationId: ch.id } }),
      404,
    );
    const unreads = await ayse.api.call('getUnreads');
    expect(unreads.conversations.some((u) => u.conversationId === ch.id)).toBe(false);
    const found = await ayse.api.call('searchMessages', { query: { q: 'gizlibilgi' } });
    expect(found.items.some((h) => h.message.conversationId === ch.id)).toBe(false);
    const canFound = await can.api.call('searchMessages', { query: { q: 'gizlibilgi' } });
    expect(canFound.items.some((h) => h.message.conversationId === ch.id)).toBe(true);

    // The space's owner (org owner) is not a member either.
    expect(await listIds(owner)).not.toContain(ch.id);
  });

  it('sends WS events and notifications to members only', async () => {
    const ch = await elif.api.call('createConversation', {
      body: { type: 'space', spaceId, name: 'Bildirim', private: true, userIds: [canId, ownerId] },
    });
    const canWs = await WsClient.open(server.port, can);
    const ayseWs = await WsClient.open(server.port, ayse);
    try {
      const msg = await send(elif, ch.id, '<@all> toplantı 15:00');
      await canWs.waitFor('message.created', (e) => e.message.id === msg.id);
      const after = await send(elif, ch.id, 'ikinci');
      await canWs.waitFor('message.created', (e) => e.message.id === after.id);
      expect(ayseWs.of('message.created').some((e) => e.message.conversationId === ch.id)).toBe(
        false,
      );
      expect(ayseWs.of('conversation.updated').some((e) => e.conversation.id === ch.id)).toBe(
        false,
      );
    } finally {
      await canWs.close();
      await ayseWs.close();
    }
    await vi.waitFor(
      async () => {
        const canNotes = await can.api.call('listNotifications', { query: {} });
        expect(canNotes.items.some((n) => n.target.conversationId === ch.id)).toBe(true);
      },
      { timeout: 10_000, interval: 200 },
    );
    const ayseNotes = await ayse.api.call('listNotifications', { query: {} });
    expect(ayseNotes.items.some((n) => n.target.conversationId === ch.id)).toBe(false);
  });

  it('lets owners add and remove people; members of the space only', async () => {
    const ch = await elif.api.call('createConversation', {
      body: { type: 'space', spaceId, name: 'Ekip', private: true, userIds: [canId] },
    });
    await send(elif, ch.id, 'önceki mesaj');

    // Plain members cannot manage people.
    await expectCode(
      can.api.call('addConversationMembers', {
        params: { conversationId: ch.id },
        body: { userIds: [ayseId], history: 'all' },
      }),
      403,
      'forbidden',
    );
    // Someone outside the space cannot join a private channel of it.
    await expectCode(
      elif.api.call('addConversationMembers', {
        params: { conversationId: ch.id },
        body: { userIds: [outsiderId], history: 'all' },
      }),
      409,
      'chat_not_in_space',
    );
    await expectCode(
      elif.api.call('createConversation', {
        body: { type: 'space', spaceId, name: 'X', private: true, userIds: [outsiderId] },
      }),
      409,
      'chat_not_in_space',
    );

    await elif.api.call('addConversationMembers', {
      params: { conversationId: ch.id },
      body: { userIds: [ayseId], history: 'none' },
    });
    expect(await listIds(ayse)).toContain(ch.id);
    expect(await texts(ayse, ch.id)).toEqual([]);

    // Ownership: make Can an owner, then Can removes Ayşe.
    await elif.api.call('updateConversationMember', {
      params: { conversationId: ch.id, userId: canId },
      body: { role: 'owner' },
    });
    await can.api.call('removeConversationMember', {
      params: { conversationId: ch.id, userId: ayseId },
    });
    expect(await listIds(ayse)).not.toContain(ch.id);
    await expectCode(
      ayse.api.call('listMessages', { params: { conversationId: ch.id }, query: {} }),
      404,
    );

    // The last owner cannot step down; leaving hands ownership over.
    await elif.api.call('updateConversationMember', {
      params: { conversationId: ch.id, userId: elifId },
      body: { role: 'member' },
    });
    await expectCode(
      can.api.call('updateConversationMember', {
        params: { conversationId: ch.id, userId: canId },
        body: { role: 'member' },
      }),
      400,
    );
    // Elif is a plain member now.
    await expectCode(
      elif.api.call('addConversationMembers', {
        params: { conversationId: ch.id },
        body: { userIds: [ayseId], history: 'all' },
      }),
      403,
    );
    await can.api.call('leaveConversation', { params: { conversationId: ch.id } });
    expect(await memberNames(elif, ch.id)).toEqual(['elif:owner']);
  });

  it('lets the space admin manage a private channel they are in', async () => {
    const ch = await elif.api.call('createConversation', {
      body: { type: 'space', spaceId, name: 'Yönetim', private: true, userIds: [ownerId] },
    });
    // The org owner is the space owner (space admin and up) though not the channel's owner.
    await owner.api.call('addConversationMembers', {
      params: { conversationId: ch.id },
      body: { userIds: [ayseId], history: 'all' },
    });
    expect(await listIds(ayse)).toContain(ch.id);
  });

  it('ends access when someone leaves the space; coming back does not restore it', async () => {
    const ch = await elif.api.call('createConversation', {
      body: { type: 'space', spaceId, name: 'Geçici', private: true, userIds: [ayseId] },
    });
    await send(elif, ch.id, 'merhaba ekip');
    expect(await listIds(ayse)).toContain(ch.id);

    await owner.api.call('removeSpaceMember', { params: { spaceId, userId: ayseId } });
    expect(await listIds(ayse)).not.toContain(ch.id);
    await expectCode(
      ayse.api.call('listMessages', { params: { conversationId: ch.id }, query: {} }),
      404,
    );
    expect(await memberNames(elif, ch.id)).toEqual(['elif:owner']);

    // Back in the space a moment later: the old row does not count.
    await new Promise((r) => setTimeout(r, 20));
    await owner.api.call('addSpaceMember', {
      params: { spaceId },
      body: { userId: ayseId, role: 'editor' },
    });
    expect(await listIds(ayse)).not.toContain(ch.id);
    await expectCode(ayse.api.call('getConversation', { params: { conversationId: ch.id } }), 404);
    // Added again by an owner: in.
    await elif.api.call('addConversationMembers', {
      params: { conversationId: ch.id },
      body: { userIds: [ayseId], history: 'all' },
    });
    expect(await texts(ayse, ch.id)).toEqual(['merhaba ekip']);
  });

  it('turns an open channel private (everyone added) and back', async () => {
    const ch = await elif.api.call('createConversation', {
      body: { type: 'space', spaceId, name: 'Genel duyuru' },
    });
    expect(ch.private).toBe(false);
    expect(await listIds(ayse)).toContain(ch.id);
    // A plain member of the space cannot change it.
    await expectCode(
      can.api.call('updateConversation', {
        params: { conversationId: ch.id },
        body: { private: true },
      }),
      403,
    );
    const made = await owner.api.call('updateConversation', {
      params: { conversationId: ch.id },
      body: { private: true },
    });
    expect(made.private).toBe(true);
    const names = await memberNames(owner, ch.id);
    expect(names).toContain('ayse:member');
    expect(names.some((n) => n.endsWith(':owner'))).toBe(true);
    await owner.api.call('removeConversationMember', {
      params: { conversationId: ch.id, userId: ayseId },
    });
    expect(await listIds(ayse)).not.toContain(ch.id);

    const opened = await owner.api.call('updateConversation', {
      params: { conversationId: ch.id },
      body: { private: false },
    });
    expect(opened.private).toBe(false);
    expect(await listIds(ayse)).toContain(ch.id);
  });

  it('lets whoever opened a channel make it private, and becomes its owner', async () => {
    const ch = await elif.api.call('createConversation', {
      body: { type: 'space', spaceId, name: 'Elif açtı' },
    });
    expect(ch.permissions.changePrivacy).toBe(true);
    const canView = await can.api.call('getConversation', { params: { conversationId: ch.id } });
    expect(canView.permissions.changePrivacy).toBe(false);
    const made = await elif.api.call('updateConversation', {
      params: { conversationId: ch.id },
      body: { private: true },
    });
    expect(made.private).toBe(true);
    expect(made.permissions.manage).toBe(true);
    expect(await memberNames(elif, ch.id)).toContain('elif:owner');
  });

  it('keeps MCP tools to members: list_conversations, read_messages, send_message', async () => {
    const ch = await elif.api.call('createConversation', {
      body: { type: 'space', spaceId, name: 'MCP gizli', private: true, userIds: [canId] },
    });
    await send(elif, ch.id, 'mcp gizli mesaj');
    const token = async (c: Client, name: string) =>
      (
        await c.api.call('createMcpToken', {
          body: { name, scopes: ['hub:read', 'chat:send'], spaceIds: null, expiresInDays: 7 },
        })
      ).value;
    const ayseToken = await token(ayse, 'Ayşe');
    const canToken = await token(can, 'Can');

    const listed = await callTool(app, ayseToken, 'list_conversations', {});
    expect((listed.data.items as { id: string }[]).map((c) => c.id)).not.toContain(ch.id);
    const read = await callTool(app, ayseToken, 'read_messages', { conversation_id: ch.id });
    expect(read.isError).toBe(true);
    const sent = await callTool(app, ayseToken, 'send_message', {
      conversation_id: ch.id,
      text: 'izinsiz',
    });
    expect(sent.isError).toBe(true);
    expect(await texts(can, ch.id)).toEqual(['mcp gizli mesaj']);

    const canListed = await callTool(app, canToken, 'list_conversations', {});
    expect((canListed.data.items as { id: string }[]).map((c) => c.id)).toContain(ch.id);
    const canRead = await callTool(app, canToken, 'read_messages', { conversation_id: ch.id });
    expect(canRead.isError).toBe(false);
  });

  it('leaves open channels and groups as they were', async () => {
    const open = await elif.api.call('createConversation', {
      body: { type: 'space', spaceId, name: 'Herkes' },
    });
    expect(await listIds(ayse)).toContain(open.id);
    expect(await listIds(outsider)).not.toContain(open.id);
    await expectCode(
      elif.api.call('addConversationMembers', {
        params: { conversationId: open.id },
        body: { userIds: [outsiderId], history: 'all' },
      }),
      400,
    );
    const group = await elif.api.call('createConversation', {
      body: { type: 'group', userIds: [canId, outsiderId], name: 'Üçlü' },
    });
    expect(group.private).toBeUndefined();
    await send(elif, group.id, 'grup');
    expect(await listIds(outsider)).toContain(group.id);
    expect(await listIds(ayse)).not.toContain(group.id);
  });
});
