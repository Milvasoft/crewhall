import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { federationConversations, federationPeers, organizations } from '@crewhall/db';
import { Client, createTestApp, join, setupWithOwner, uploadFile, type TestApp } from './helpers';

/**
 * Internal references: a message points at an item with no link and no share; the card is
 * answered per viewer, and a title reaches nobody who may not see the item.
 */

const SECRET = 'Gizli Birleşme Planı';

let app: TestApp;
let owner: Client;
let elif: Client;
let can: Client;
let canId: string;
let spaceId: string;
let groupId: string;
let folderId: string;
let fileId: string;
let pageId: string;
let boardId: string;
let cardId: string;

const node = (id: string) => ({ kind: 'node' as const, id });
const resolve = async (c: Client, ref: { kind: 'node' | 'card'; id: string }) => {
  const { items } = await c.api.call('resolveChatRefs', { body: { refs: [ref] } });
  return items[0]!;
};
const send = (c: Client, body: object) =>
  c.api.call('sendMessage', {
    params: { conversationId: groupId },
    body: { clientMsgId: randomUUID(), ...body },
  });

beforeAll(async () => {
  app = await createTestApp();
  const setup = await setupWithOwner(app);
  owner = setup.owner;
  // A closed space: Elif is in it; Can is in the chat but not in the space.
  spaceId = (await owner.api.call('createSpace', { body: { name: 'Yönetim', color: 's5' } })).id;
  elif = (await join(app, owner, 'elif@milvasoft.com', 'member', [spaceId])).person;
  const c = await join(app, owner, 'can@milvasoft.com', 'member');
  can = c.person;
  canId = c.me.user.id;
  const elifId = (await elif.api.call('me')).user.id;
  groupId = (
    await owner.api.call('createConversation', {
      body: { type: 'group', userIds: [elifId, canId], name: 'Ekip' },
    })
  ).id;
  folderId = (await owner.api.call('createFolder', { params: { spaceId }, body: { name: SECRET } }))
    .id;
  fileId = (
    await uploadFile(owner, {
      spaceId,
      parentId: folderId,
      name: `${SECRET}.txt`,
      content: Buffer.from('içerik'),
    })
  ).node.id;
  pageId = (
    await owner.api.call('createPage', {
      params: { spaceId },
      body: { name: `${SECRET} sayfası` },
    })
  ).id;
  const board = await owner.api.call('createBoard', {
    params: { spaceId },
    body: { name: `${SECRET} panosu`, template: 'roadmap', key: 'GZL' },
  });
  boardId = board.id;
  const detail = await owner.api.call('getBoard', { params: { boardId } });
  cardId = (
    await owner.api.call('createBoardCard', {
      params: { boardId },
      body: { columnId: detail.columns[0]!.id, title: `${SECRET} kartı` },
    })
  ).id;
});

afterAll(async () => {
  await app.close();
});

describe('resolving', () => {
  it('gives each type its card and in-app address', async () => {
    const page = await resolve(elif, node(pageId));
    expect(page).toMatchObject({
      state: 'ok',
      item: { type: 'page', title: `${SECRET} sayfası`, path: `/p/${pageId}` },
    });
    const folder = await resolve(elif, node(folderId));
    expect(folder.item).toMatchObject({ type: 'folder', spaceName: 'Yönetim' });
    expect(folder.item?.path).toContain(`/folder/${folderId}`);
    const file = await resolve(elif, node(fileId));
    expect(file.item?.type).toBe('file');
    expect(file.item?.path).toContain(`/folder/${folderId}?preview=${fileId}`);
    expect((await resolve(elif, node(boardId))).item?.path).toBe(`/b/${boardId}`);
    const card = await resolve(elif, { kind: 'card', id: cardId });
    expect(card.item).toMatchObject({ type: 'card', path: `/b/${boardId}/GZL-1` });
  });

  it('tells someone without permission nothing about the item', async () => {
    for (const ref of [
      node(folderId),
      node(fileId),
      node(pageId),
      node(boardId),
      { kind: 'card' as const, id: cardId },
    ]) {
      const r = await resolve(can, ref);
      expect(r).toEqual({ ...ref, state: 'no_access', item: null });
    }
  });

  it('follows the permission: a share opens it, ending the share closes it', async () => {
    const share = await owner.api.call('createShare', {
      params: { nodeId: folderId },
      body: { kind: 'user', userId: canId, role: 'viewer' },
    });
    // Reaches inside the folder too; the page beside it stays closed.
    expect((await resolve(can, node(fileId))).state).toBe('ok');
    expect((await resolve(can, node(pageId))).state).toBe('no_access');
    await owner.api.call('deleteShare', { params: { shareId: share.id } });
    expect((await resolve(can, node(fileId))).state).toBe('no_access');
  });

  it('says deleted only to people who could see it', async () => {
    const page = await owner.api.call('createPage', {
      params: { spaceId },
      body: { name: `${SECRET} silinecek` },
    });
    await owner.api.call('trashNodes', { body: { nodeIds: [page.id] } });
    expect(await resolve(elif, node(page.id))).toEqual({
      ...node(page.id),
      state: 'deleted',
      item: null,
    });
    expect((await resolve(can, node(page.id))).state).toBe('no_access');
    await owner.api.call('restoreNodes', { body: { nodeIds: [page.id] } });
    expect((await resolve(elif, node(page.id))).state).toBe('ok');
    // No such row: nothing to protect, and the same for another org's ids.
    expect((await resolve(elif, node(randomUUID()))).state).toBe('deleted');
  });

  it('hides items of a switched-off module', async () => {
    await owner.api.call('updateOrg', { body: { settings: { modules: { wiki: false } } } });
    try {
      expect(await resolve(elif, node(pageId))).toMatchObject({ state: 'no_access', item: null });
    } finally {
      await owner.api.call('updateOrg', { body: { settings: { modules: { wiki: true } } } });
    }
  });
});

describe('searching', () => {
  it('finds only what the caller can see', async () => {
    const mine = await elif.api.call('searchChatRefs', { query: { q: 'Birleşme' } });
    const titles = mine.items.map((i) => i.item?.title);
    expect(titles).toContain(`${SECRET} sayfası`);
    expect(titles).toContain(`${SECRET} kartı`);
    expect(mine.items.every((i) => i.state === 'ok')).toBe(true);
    const other = await can.api.call('searchChatRefs', { query: { q: 'Birleşme' } });
    expect(other.items).toEqual([]);
    expect(JSON.stringify(other)).not.toContain(SECRET);
  });

  it('lists recently opened items with no query, never someone else’s', async () => {
    await elif.api.call('getPage', { params: { nodeId: pageId } });
    const recent = await elif.api.call('searchChatRefs', { query: {} });
    expect(recent.items.every((i) => i.state === 'ok')).toBe(true);
    expect((await can.api.call('searchChatRefs', { query: {} })).items).toEqual([]);
  });
});

describe('sending', () => {
  it('carries ids only: no title in the message, the list, or the notification', async () => {
    const m = await send(owner, { refs: [node(pageId), { kind: 'card', id: cardId }] });
    expect(m.text).toBe('');
    expect(m.refs).toEqual([node(pageId), { kind: 'card', id: cardId }]);
    expect(JSON.stringify(m)).not.toContain(SECRET);

    // Someone in the chat without access to the item: the message, list and bell stay clean.
    const page = await can.api.call('listMessages', { params: { conversationId: groupId } });
    expect(page.items.find((x) => x.id === m.id)?.refs).toEqual(m.refs);
    expect(JSON.stringify(page)).not.toContain(SECRET);
    const conv = (await can.api.call('listConversations')).items.find((c) => c.id === groupId)!;
    expect(conv.lastMessage?.excerpt).toBe('🔗');
    expect(JSON.stringify(conv)).not.toContain(SECRET);
    expect(JSON.stringify(await can.api.call('listNotifications'))).not.toContain(SECRET);
  });

  it('does not let someone send what they cannot see', async () => {
    await expect(send(can, { refs: [node(pageId)] })).rejects.toMatchObject({
      status: 403,
      code: 'chat_ref_no_access',
    });
    await expect(send(can, { refs: [node(randomUUID())] })).rejects.toMatchObject({
      code: 'chat_ref_no_access',
    });
    // The refusal reads the same either way: not a way to probe for items.
    await expect(
      send(owner, { text: 'çok fazla', refs: Array.from({ length: 6 }, () => node(pageId)) }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('keeps repeats out and a note beside the reference', async () => {
    const m = await send(owner, { text: 'şuna bak', refs: [node(pageId), node(pageId)] });
    expect(m.text).toBe('şuna bak');
    expect(m.refs).toEqual([node(pageId)]);
  });

  it('drops the refs of a deleted message', async () => {
    const m = await send(owner, { refs: [node(pageId)] });
    await owner.api.call('deleteMessage', { params: { messageId: m.id } });
    const page = await owner.api.call('listMessages', { params: { conversationId: groupId } });
    expect(page.items.find((x) => x.id === m.id)?.refs).toEqual([]);
  });

  it('schedules a reference and checks it again when it goes out', async () => {
    const at = new Date(Date.now() + 3_600_000).toISOString();
    await expect(
      can.api.call('createScheduledMessage', {
        params: { conversationId: groupId },
        body: { refs: [node(pageId)], sendAt: at },
      }),
    ).rejects.toMatchObject({ code: 'chat_ref_no_access' });
    const s = await owner.api.call('createScheduledMessage', {
      params: { conversationId: groupId },
      body: { refs: [node(pageId)], sendAt: at },
    });
    expect(s.refs).toEqual([node(pageId)]);
    const sent = await owner.api.call('sendScheduledMessageNow', {
      params: { scheduledId: s.id },
    });
    expect(sent.refs).toEqual([node(pageId)]);
  });

  it('refuses references in a chat shared with another installation', async () => {
    const [org] = await app.deps.db.select().from(organizations);
    const [peer] = await app.deps.db
      .insert(federationPeers)
      .values({ orgId: org!.id, domain: 'partner.example' })
      .returning();
    await app.deps.db.insert(federationConversations).values({
      orgId: org!.id,
      conversationId: groupId,
      peerId: peer!.id,
      homeDomain: 'partner.example',
    });
    await expect(send(owner, { refs: [node(pageId)] })).rejects.toMatchObject({
      status: 400,
      code: 'invalid_target',
    });
  });
});
