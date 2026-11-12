import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditLogs, conversations, messages, nodes } from '@crewhall/db';
import { ApiError } from '@crewhall/api-client';
import { listen, uuid, WsClient } from './chat-helpers';
import { Client, createTestApp, join, setupWithOwner, uploadFile, type TestApp } from './helpers';

/** H19: clear for me, personal archive, delete for everyone. */

let app: TestApp;
let server: Awaited<ReturnType<typeof listen>>;
let owner: Client;
let elif: Client;
let can: Client;
let elifId: string;
let canId: string;
let spaceId: string;

const send = (c: Client, conversationId: string, text: string, extra: object = {}) =>
  c.api.call('sendMessage', {
    params: { conversationId },
    body: { clientMsgId: uuid(), text, ...extra },
  });
const listIds = async (c: Client, archived?: 'true' | 'false') =>
  (await c.api.call('listConversations', { query: archived ? { archived } : {} })).items.map(
    (x) => x.id,
  );
const texts = async (c: Client, conversationId: string) =>
  (await c.api.call('listMessages', { params: { conversationId }, query: {} })).items
    .filter((m) => m.kind === 'user')
    .map((m) => m.text);

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
  spaceId = (await owner.api.call('listSpaces')).items.find((s) => s.name === 'Milvasoft')!.id;
  const e = await join(app, owner, 'elif@milvasoft.com', 'member', [spaceId]);
  elif = e.person;
  elifId = e.me.user.id;
  const c = await join(app, owner, 'can@milvasoft.com', 'member', [spaceId]);
  can = c.person;
  canId = c.me.user.id;
});

afterAll(async () => {
  await server.close();
  await app.close();
});

describe('Benim için sil (clear for me)', () => {
  it('hides the history from me only; a new message brings the chat back clean', async () => {
    const dm = await owner.api.call('createConversation', {
      body: { type: 'direct', userId: elifId },
    });
    await send(owner, dm.id, 'eski bir');
    await send(elif, dm.id, 'eski iki');
    await owner.api.call('clearConversation', { params: { conversationId: dm.id } });

    expect(await listIds(owner)).not.toContain(dm.id);
    expect(await texts(owner, dm.id)).toEqual([]);
    expect(await texts(elif, dm.id)).toEqual(['eski bir', 'eski iki']);
    const found = await owner.api.call('searchMessages', { query: { q: 'eski' } });
    expect(found.items.some((h) => h.message.conversationId === dm.id)).toBe(false);

    await send(elif, dm.id, 'yeni');
    expect(await listIds(owner)).toContain(dm.id);
    expect(await texts(owner, dm.id)).toEqual(['yeni']);
    const view = (await owner.api.call('listConversations', { query: {} })).items.find(
      (x) => x.id === dm.id,
    )!;
    expect(view.my.unread).toBe(1);
    expect(view.lastMessage?.excerpt).toBe('yeni');
  });

  it('is not available in space conversations', async () => {
    const conv = await owner.api.call('createConversation', {
      body: { type: 'space', spaceId, name: 'Milvaion Ekibi' },
    });
    expect(conv.permissions.clearForMe).toBe(false);
    await expectCode(
      owner.api.call('clearConversation', { params: { conversationId: conv.id } }),
      403,
      'chat_delete_not_allowed',
    );
  });
});

describe('Arşivle (personal archive)', () => {
  it('moves the chat to my archive only and back', async () => {
    const group = await owner.api.call('createConversation', {
      body: { type: 'group', userIds: [elifId, canId], name: 'Sürüm ekibi' },
    });
    await send(owner, group.id, 'merhaba');
    const archived = await elif.api.call('updateMyConversation', {
      params: { conversationId: group.id },
      body: { archived: true },
    });
    expect(archived.my.archivedAt).not.toBeNull();
    expect(await listIds(elif)).not.toContain(group.id);
    expect(await listIds(elif, 'true')).toContain(group.id);
    expect(await listIds(owner)).toContain(group.id);
    // Still a member: new messages are there when it is opened from the archive.
    await send(owner, group.id, 'arşivde de okunur');
    expect(await texts(elif, group.id)).toContain('arşivde de okunur');
    await elif.api.call('updateMyConversation', {
      params: { conversationId: group.id },
      body: { archived: false },
    });
    expect(await listIds(elif)).toContain(group.id);
  });
});

describe('Herkes için sil (delete for everyone)', () => {
  it('only the owner or an org admin may, never in direct or space chats', async () => {
    const group = await elif.api.call('createConversation', {
      body: { type: 'group', userIds: [canId, (await owner.api.call('me')).user.id] },
    });
    await send(elif, group.id, 'x');
    const asCan = await can.api.call('getConversation', { params: { conversationId: group.id } });
    expect(asCan.permissions.deleteForEveryone).toBe(false);
    await expectCode(
      can.api.call('deleteConversation', { params: { conversationId: group.id } }),
      403,
      'chat_delete_not_allowed',
    );
    const dm = await elif.api.call('createConversation', {
      body: { type: 'direct', userId: canId },
    });
    await expectCode(
      elif.api.call('deleteConversation', { params: { conversationId: dm.id } }),
      403,
      'chat_delete_not_allowed',
    );
    const space = await owner.api.call('createConversation', {
      body: { type: 'space', spaceId, name: 'Genel' },
    });
    await expectCode(
      owner.api.call('deleteConversation', { params: { conversationId: space.id } }),
      403,
      'chat_delete_not_allowed',
    );

    await owner.api.call('updateOrg', { body: { settings: { chatDeleteForEveryone: false } } });
    try {
      await expectCode(
        owner.api.call('deleteConversation', { params: { conversationId: group.id } }),
        403,
        'chat_delete_disabled',
      );
      const view = await elif.api.call('getConversation', { params: { conversationId: group.id } });
      expect(view.permissions.deleteForEveryone).toBe(false);
    } finally {
      await owner.api.call('updateOrg', { body: { settings: { chatDeleteForEveryone: true } } });
    }
  });

  it('removes messages and attachments for everyone, tells them over WS, keeps an audit row', async () => {
    const group = await elif.api.call('createConversation', {
      body: {
        type: 'group',
        userIds: [canId, (await owner.api.call('me')).user.id],
        name: 'Silinecek',
      },
    });
    const folder = await elif.api.call('getChatAttachmentFolder', {
      params: { conversationId: group.id },
    });
    const file = await uploadFile(elif, {
      spaceId: folder.spaceId,
      parentId: folder.folderId,
      name: 'rapor.txt',
      content: Buffer.from('gizli'),
      mime: 'text/plain',
    });
    await send(elif, group.id, 'ekli mesaj', { attachmentNodeIds: [file.node.id] });
    // A file attached from elsewhere in Drive is not the chat's to delete.
    const personal = (await elif.api.call('listSpaces')).items.find((s) => s.kind === 'personal')!;
    const own = await uploadFile(elif, {
      spaceId: personal.id,
      parentId: null,
      name: 'kendi.txt',
      content: Buffer.from('benim'),
      mime: 'text/plain',
    });
    await send(elif, group.id, 'drive dosyası', { attachmentNodeIds: [own.node.id] });
    expect(
      (await elif.api.call('getConversation', { params: { conversationId: group.id } })).permissions
        .deleteForEveryone,
    ).toBe(true);

    const ws = await WsClient.open(server.port, can);
    await elif.api.call('deleteConversation', { params: { conversationId: group.id } });
    const removed = await ws.waitFor('conversation.removed', (e) => e.conversationId === group.id);
    expect(removed.reason).toBe('deleted');
    await ws.close();

    await expectCode(
      can.api.call('getConversation', { params: { conversationId: group.id } }),
      404,
    );
    expect(await listIds(can)).not.toContain(group.id);
    const rows = await app.deps.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, group.id));
    expect(rows).toHaveLength(0);
    const [conv] = await app.deps.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, group.id));
    expect(conv).toBeUndefined();
    // The file goes to the Drive trash; the trash retention purges it later.
    const [node] = await app.deps.db.select().from(nodes).where(eq(nodes.id, file.node.id));
    expect(node!.deletedAt).not.toBeNull();
    const [kept] = await app.deps.db.select().from(nodes).where(eq(nodes.id, own.node.id));
    expect(kept!.deletedAt).toBeNull();
    const audits = await app.deps.db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.action, 'chat.conversation.delete'), eq(auditLogs.targetId, group.id)),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.meta).toMatchObject({ attachments: 1, messages: expect.any(Number) });
  });

  it('an org admin may delete a group someone else created', async () => {
    const group = await elif.api.call('createConversation', {
      body: { type: 'group', userIds: [canId, (await owner.api.call('me')).user.id] },
    });
    await send(elif, group.id, 'x');
    await owner.api.call('deleteConversation', { params: { conversationId: group.id } });
    await expectCode(
      elif.api.call('getConversation', { params: { conversationId: group.id } }),
      404,
    );
  });
});
