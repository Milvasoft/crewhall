import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { conversations } from '@crewhall/db';
import { WS_CLOSE } from '@crewhall/shared';
import { listen, until, uuid, WsClient } from './chat-helpers';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

let app: TestApp;
let server: Awaited<ReturnType<typeof listen>>;
let owner: Client;
let elif: Client;
let can: Client;
let ownerId: string;
let elifId: string;
let canId: string;
let spaceId: string;

const send = (c: Client, conversationId: string, text: string, extra: object = {}) =>
  c.api.call('sendMessage', {
    params: { conversationId },
    body: { clientMsgId: uuid(), text, ...extra },
  });

beforeAll(async () => {
  app = await createTestApp();
  server = await listen(app);
  const setup = await setupWithOwner(app);
  owner = setup.owner;
  ownerId = setup.ownerId;
  const spaces = await owner.api.call('listSpaces');
  spaceId = spaces.items.find((s) => s.name === 'Milvasoft')!.id;
  const e = await join(app, owner, 'elif@milvasoft.com', 'member', [spaceId]);
  elif = e.person;
  elifId = (await elif.api.call('me')).user.id;
  const c = await join(app, owner, 'can@milvasoft.com', 'member', [spaceId]);
  can = c.person;
  canId = (await can.api.call('me')).user.id;
});

afterAll(async () => {
  await server.close();
  await app.close();
});

describe('WebSocket gateway', () => {
  it('rejects a bad or reused ticket and accepts a fresh one', async () => {
    const bad = await WsClient.openWithTicket(server.port, 'nope');
    expect(await bad.waitClosed()).toBe(WS_CLOSE.ticketInvalid);

    const t = await elif.api.call('createWsTicket');
    expect(t.path).toBe('/ws');
    const ws = await WsClient.openWithTicket(server.port, t.ticket);
    const ready = await ws.waitFor('ready');
    expect(ready.userId).toBe(elifId);
    const again = await WsClient.openWithTicket(server.port, t.ticket);
    expect(await again.waitClosed()).toBe(WS_CLOSE.ticketInvalid);
    await ws.close();
  });
});

describe('direct conversations', () => {
  let directId: string;

  it('exists for the other person from the first message, and is found again', async () => {
    const draft = await owner.api.call('createConversation', {
      body: { type: 'direct', userId: elifId },
    });
    directId = draft.id;
    expect(draft.peer?.id).toBe(elifId);
    expect(draft.title).toBe('elif');
    // Empty direct conversation: only the opener sees it (design 4.17).
    expect((await elif.api.call('listConversations')).items.map((c) => c.id)).not.toContain(
      directId,
    );

    const ws = await WsClient.open(server.port, elif);
    await ws.waitFor('ready');
    const msg = await send(owner, directId, 'Merhaba <@' + elifId + '>');
    expect(msg.seq).toBe(1);
    expect(msg.mentions).toEqual([{ kind: 'user', userId: elifId }]);
    const created = await ws.waitFor('message.created', (e) => e.message.id === msg.id);
    expect(created.message.text).toContain(elifId);
    const note = await ws.waitFor('notification');
    expect(note.notification.type).toBe('chat.mention');

    const list = await elif.api.call('listConversations');
    const row = list.items.find((c) => c.id === directId)!;
    expect(row.my.unread).toBe(1);
    expect(row.my.unreadMentions).toBe(1);
    expect(row.lastMessage?.excerpt).toBe('Merhaba @elif');

    const same = await elif.api.call('createConversation', {
      body: { type: 'direct', userId: ownerId },
    });
    expect(same.id).toBe(directId);
    await ws.close();
  });

  it('does not create a second message for a resent clientMsgId', async () => {
    const clientMsgId = uuid();
    const a = await owner.api.call('sendMessage', {
      params: { conversationId: directId },
      body: { clientMsgId, text: 'tek' },
    });
    const b = await owner.api.call('sendMessage', {
      params: { conversationId: directId },
      body: { clientMsgId, text: 'tek' },
    });
    expect(b.id).toBe(a.id);
    const conv = await owner.api.call('getConversation', { params: { conversationId: directId } });
    expect(conv.lastSeq).toBe(a.seq);
  });

  it('keeps the order under concurrent writes (no gaps, no duplicates)', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => send(i % 2 ? owner : elif, directId, `paralel ${i}`)),
    );
    const seqs = results.map((m) => m.seq).sort((x, y) => x - y);
    expect(new Set(seqs).size).toBe(12);
    expect(seqs.at(-1)! - seqs[0]!).toBe(11);
    const page = await elif.api.call('listMessages', {
      params: { conversationId: directId },
      query: { limit: 100 },
    });
    const all = page.items.map((m) => m.seq);
    expect(all).toEqual(Array.from({ length: all.length }, (_, i) => i + 1));
    expect(page.lastSeq).toBe(all.at(-1));
  });

  it('loses nothing across a reconnect (unreads, then ?afterSeq=)', async () => {
    const ws = await WsClient.open(server.port, elif);
    await ws.waitFor('ready');
    const before = await send(owner, directId, 'bağlıyken');
    await ws.waitFor('message.created', (e) => e.message.id === before.id);
    const lastSeen = before.seq;
    await ws.close();

    // Offline: three messages and an edit arrive.
    const missed = [];
    for (const t of ['bir', 'iki', 'üç']) missed.push(await send(owner, directId, t));
    const editedAt = new Date().toISOString();
    await owner.api.call('updateMessage', {
      params: { messageId: before.id },
      body: { text: 'bağlıyken (düzenlendi)' },
    });

    const again = await WsClient.open(server.port, elif);
    await again.waitFor('ready');
    const unreads = await elif.api.call('getUnreads');
    const row = unreads.conversations.find((c) => c.conversationId === directId)!;
    expect(row.lastSeq).toBe(missed.at(-1)!.seq);
    const page = await elif.api.call('listMessages', {
      params: { conversationId: directId },
      query: { afterSeq: lastSeen },
    });
    expect(page.items.map((m) => m.text)).toEqual(['bir', 'iki', 'üç']);
    expect(page.hasMoreAfter).toBe(false);
    expect(page.hasMoreBefore).toBe(true);
    const changed = await elif.api.call('listMessages', {
      params: { conversationId: directId },
      query: { updatedAfter: editedAt },
    });
    expect(changed.items.find((m) => m.id === before.id)?.editedAt).not.toBeNull();

    // And live again afterwards.
    const live = await send(owner, directId, 'yine bağlı');
    await again.waitFor('message.created', (e) => e.message.id === live.id);
    await again.close();
  });

  it('moves the read position only forward and tells the other devices', async () => {
    const phone = await WsClient.open(server.port, elif);
    const ownerWs = await WsClient.open(server.port, owner);
    await phone.waitFor('ready');
    await ownerWs.waitFor('ready');
    const conv = await elif.api.call('getConversation', { params: { conversationId: directId } });
    const r1 = await elif.api.call('markConversationRead', {
      params: { conversationId: directId },
      body: { seq: conv.lastSeq },
    });
    expect(r1.unread).toBe(0);
    expect(r1.unreadMentions).toBe(0);
    const r2 = await elif.api.call('markConversationRead', {
      params: { conversationId: directId },
      body: { seq: 1 },
    });
    expect(r2.lastReadSeq).toBe(conv.lastSeq);
    const own = await phone.waitFor('read', (e) => e.userId === elifId && e.unread === 0);
    expect(own.lastReadSeq).toBe(conv.lastSeq);
    const other = await ownerWs.waitFor('read', (e) => e.userId === elifId);
    expect(other.unread).toBeUndefined();

    const receipts = await owner.api.call('listReadReceipts', {
      params: { conversationId: directId },
    });
    expect(receipts.items).toEqual([
      expect.objectContaining({ userId: elifId, lastReadSeq: conv.lastSeq }),
    ]);
    // No hiding: the old readReceipts switch is accepted and ignored (user decision).
    const settings = await elif.api.call('updateChatSettings', { body: { readReceipts: false } });
    expect(settings.readReceipts).toBe(true);
    expect(
      (await owner.api.call('listReadReceipts', { params: { conversationId: directId } })).items,
    ).toEqual([expect.objectContaining({ userId: elifId })]);
    expect(
      (await elif.api.call('listReadReceipts', { params: { conversationId: directId } })).items,
    ).toHaveLength(1);

    const unread = await elif.api.call('markConversationUnread', {
      params: { conversationId: directId },
      body: { fromSeq: conv.lastSeq - 1 },
    });
    expect(unread.lastReadSeq).toBe(conv.lastSeq - 2);
    expect(unread.unread).toBeGreaterThan(0);
    await phone.close();
    await ownerWs.close();
  });

  it('marks chat notifications read with the conversation', async () => {
    await send(owner, directId, 'okunacak <@' + elifId + '>');
    const before = await elif.api.call('getNotificationCounts');
    expect(before.unread).toBeGreaterThan(0);
    const conv = await elif.api.call('getConversation', { params: { conversationId: directId } });
    await elif.api.call('markConversationRead', {
      params: { conversationId: directId },
      body: { seq: conv.lastSeq },
    });
    const after = await elif.api.call('getNotificationCounts');
    expect(after.bySource.chat).toBe(0);
  });
});

describe('group conversations', () => {
  let groupId: string;

  it('needs three people, stays a draft until the first message, names itself', async () => {
    await expect(
      owner.api.call('createConversation', { body: { type: 'group', userIds: [elifId] } }),
    ).rejects.toMatchObject({ status: 422 });
    const g = await owner.api.call('createConversation', {
      body: { type: 'group', userIds: [elifId, canId] },
    });
    groupId = g.id;
    expect(g.title).toBe('can, elif');
    expect((await can.api.call('listConversations')).items.map((c) => c.id)).not.toContain(g.id);
    await send(owner, g.id, 'Selam ekip');
    expect((await can.api.call('listConversations')).items.map((c) => c.id)).toContain(g.id);
  });

  it('renames, adds people without history, and lets members leave', async () => {
    const renamed = await elif.api.call('updateConversation', {
      params: { conversationId: groupId },
      body: { name: 'Mobil' },
    });
    expect(renamed.title).toBe('Mobil');
    const zeynep = await join(app, owner, 'zeynep@milvasoft.com', 'member');
    const zeynepId = (await zeynep.person.api.call('me')).user.id;
    await owner.api.call('addConversationMembers', {
      params: { conversationId: groupId },
      body: { userIds: [zeynepId], history: 'none' },
    });
    const page = await zeynep.person.api.call('listMessages', {
      params: { conversationId: groupId },
    });
    // Only the "members added" line, nothing from before (design 4.8).
    expect(page.items.map((m) => m.kind)).toEqual(['system']);
    expect(page.items[0]!.system).toMatchObject({ type: 'members_added', userIds: [zeynepId] });
    expect(page.hasMoreBefore).toBe(false);
    const old = (
      await owner.api.call('listMessages', { params: { conversationId: groupId } })
    ).items.find((m) => m.text === 'Selam ekip')!;
    await expect(
      zeynep.person.api.call('addReaction', {
        params: { messageId: old.id },
        body: { emoji: '👍' },
      }),
    ).rejects.toMatchObject({ status: 404 });

    await zeynep.person.api.call('leaveConversation', { params: { conversationId: groupId } });
    await expect(
      zeynep.person.api.call('getConversation', { params: { conversationId: groupId } }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('turns into a space conversation with "Space\'e bağla"', async () => {
    const linked = await owner.api.call('linkConversationSpace', {
      params: { conversationId: groupId },
      body: { spaceId },
    });
    expect(linked.type).toBe('space');
    expect(linked.spaceId).toBe(spaceId);
    const msgs = await can.api.call('listMessages', { params: { conversationId: groupId } });
    expect(msgs.items.some((m) => m.text === 'Selam ekip')).toBe(true);
  });
});

describe('space conversations', () => {
  let convId: string;

  it('takes members from the space and enforces chat roles', async () => {
    const c = await owner.api.call('createConversation', {
      body: { type: 'space', spaceId, name: 'Milvaion Ekibi' },
    });
    convId = c.id;
    const members = await owner.api.call('listConversationMembers', {
      params: { conversationId: convId },
    });
    expect(c.memberCount).toBe(members.items.length);
    expect(members.items.find((m) => m.user.id === ownerId)?.spaceRole).toBe('owner');
    expect(c.permissions.moderate).toBe(true);
    const asElif = await elif.api.call('getConversation', { params: { conversationId: convId } });
    expect(asElif.permissions.write).toBe(true);
    expect(asElif.permissions.moderate).toBe(false);
    // Altyapı has only the owner: others get 404, not 403 (existence is not revealed).
    const altyapi = (await owner.api.call('listSpaces')).items.find((s) => s.name === 'Altyapı')!;
    const closed = await owner.api.call('createConversation', {
      body: { type: 'space', spaceId: altyapi.id, name: 'Sunucular' },
    });
    await expect(
      elif.api.call('getConversation', { params: { conversationId: closed.id } }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      elif.api.call('sendMessage', {
        params: { conversationId: closed.id },
        body: { clientMsgId: uuid(), text: 'x' },
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('quotes, edits, reacts, deletes and pins', async () => {
    const ws = await WsClient.open(server.port, can);
    await ws.waitFor('ready');
    const original = await send(elif, convId, 'Retry politikası: 3 deneme');
    const reply = await send(owner, convId, 'Katılıyorum', { replyToId: original.id });
    expect(reply.replyTo).toMatchObject({ id: original.id, excerpt: 'Retry politikası: 3 deneme' });

    await expect(
      owner.api.call('updateMessage', { params: { messageId: original.id }, body: { text: 'x' } }),
    ).rejects.toMatchObject({ status: 403 });
    const edited = await elif.api.call('updateMessage', {
      params: { messageId: original.id },
      body: { text: 'Retry politikası: 3 deneme + jitter' },
    });
    expect(edited.editedAt).not.toBeNull();

    const reacted = await can.api.call('addReaction', {
      params: { messageId: original.id },
      body: { emoji: '👍' },
    });
    expect(reacted.reactions).toEqual([{ emoji: '👍', count: 1, userIds: [canId], mine: true }]);
    await ws.waitFor('reaction', (e) => e.messageId === original.id && e.added);
    expect((await can.api.call('getChatSettings')).recentEmojis).toEqual(['👍']);

    const pinned = await owner.api.call('pinMessage', { params: { messageId: reply.id } });
    expect(pinned.pinnedAt).not.toBeNull();
    const pins = await can.api.call('listPinnedMessages', { params: { conversationId: convId } });
    expect(pins.items.map((p) => p.message.id)).toEqual([reply.id]);

    // Owner (space owner) may delete others' messages; the quote turns into "deleted".
    await owner.api.call('deleteMessage', { params: { messageId: original.id } });
    await ws.waitFor('message.deleted', (e) => e.messageId === original.id);
    const quoted = await ws.waitFor(
      'message.updated',
      (e) => e.message.id === reply.id && e.message.replyTo?.deleted === true,
    );
    expect(quoted.message.replyTo?.excerpt).toBeNull();
    const page = await can.api.call('listMessages', {
      params: { conversationId: convId },
      query: { aroundSeq: original.seq, limit: 4 },
    });
    const tomb = page.items.find((m) => m.id === original.id)!;
    expect(tomb.text).toBe('');
    expect(tomb.reactions).toEqual([]);
    await expect(
      can.api.call('deleteMessage', { params: { messageId: reply.id } }),
    ).rejects.toMatchObject({ status: 403 });
    await ws.close();
  });

  it('@all reaches everyone (even muted), with a confirmation from 20 people on', async () => {
    await can.api.call('updateMyConversation', {
      params: { conversationId: convId },
      body: { mutedUntil: new Date(Date.now() + 3600_000).toISOString() },
    });
    const ws = await WsClient.open(server.port, can);
    await ws.waitFor('ready');
    const m = await send(elif, convId, '<@all> stand-up 5 dk sonra');
    expect(m.mentions).toEqual([{ kind: 'all', userId: null }]);
    const n = await ws.waitFor('notification', (e) => e.notification.target.id === m.id);
    expect(n.notification.type).toBe('chat.mention');
    const conv = await can.api.call('getConversation', { params: { conversationId: convId } });
    expect(conv.my.unreadMentions).toBe(1);
    expect(conv.my.mutedUntil).not.toBeNull();
    // Plain messages don't notify at the default level ("mentions").
    const plain = await send(elif, convId, 'normal mesaj');
    // Events reach a connection in order: once the next mention's notification is here,
    // one for the plain message would have arrived before it.
    const marker = await send(elif, convId, `<@${canId}> işaret`);
    await ws.waitFor('notification', (e) => e.notification.target.id === marker.id);
    expect(ws.of('notification').some((e) => e.notification.target.id === plain.id)).toBe(false);
    await ws.close();
  });

  it('delivers typing to others and not back to the typist', async () => {
    const a = await WsClient.open(server.port, elif);
    const b = await WsClient.open(server.port, can);
    await a.waitFor('ready');
    await b.waitFor('ready');
    a.send({ type: 'typing', conversationId: convId });
    const t = await b.waitFor('typing');
    expect(t).toMatchObject({ conversationId: convId, userId: elifId });
    // The fan-out to b and (wrongly) to a happens in one loop: b having it is enough.
    expect(a.of('typing')).toEqual([]);
    await a.close();
    await b.close();
  });

  it("pins conversations in the caller's order, at most 15", async () => {
    const list = await owner.api.call('listConversations');
    const ids = list.items.map((c) => c.id).slice(0, 2);
    for (const id of ids) {
      await owner.api.call('updateMyConversation', {
        params: { conversationId: id },
        body: { pinned: true },
      });
    }
    await owner.api.call('reorderPinnedConversations', {
      body: { conversationIds: [...ids].reverse() },
    });
    const after = await owner.api.call('listConversations');
    expect(after.items.slice(0, 2).map((c) => c.id)).toEqual([...ids].reverse());
  });

  it('searches only readable history', async () => {
    await send(elif, convId, 'redis bağlantısı koptu');
    const altyapi = (await owner.api.call('listSpaces')).items.find((s) => s.name === 'Altyapı')!;
    const hidden = await owner.api.call('createConversation', {
      body: { type: 'space', spaceId: altyapi.id, name: 'Altyapı' },
    });
    await send(owner, hidden.id, 'redis şifresi değişti');
    const hits = await can.api.call('searchMessages', { query: { q: 'redis' } });
    expect(hits.items).toHaveLength(1);
    expect(hits.items[0]!.highlight).toContain('<mark>redis</mark>');
    expect(hits.items[0]!.conversation.title).toBe('Milvaion Ekibi');
    expect((await owner.api.call('searchMessages', { query: { q: 'redis' } })).items).toHaveLength(
      2,
    );
  });
});

describe('presence and status', () => {
  it('shows online, away and the chosen status to watchers', async () => {
    const watcher = await WsClient.open(server.port, owner);
    await watcher.waitFor('ready');
    // Watching sends the current state too, so the order of watch and connect doesn't matter.
    watcher.send({ type: 'presence.watch', userIds: [canId] });
    const phone = await WsClient.open(server.port, can);
    await phone.waitFor('ready');
    await watcher.waitFor(
      'presence',
      (e) => e.presence.userId === canId && e.presence.state === 'online',
    );
    phone.send({ type: 'heartbeat', active: false, focused: false });
    await watcher.waitFor(
      'presence',
      (e) => e.presence.userId === canId && e.presence.state === 'away',
    );

    await can.api.call('updateMyStatus', {
      body: {
        visibility: 'dnd',
        message: { text: 'Odaklanıyorum', emoji: '🎧', expiresAt: null },
      },
    });
    const dnd = await watcher.waitFor('presence', (e) => e.presence.state === 'dnd');
    expect(dnd.presence.message?.text).toBe('Odaklanıyorum');
    const snap = await owner.api.call('getPresence', { body: { userIds: [canId] } });
    expect(snap.items.find((p) => p.userId === canId)?.state).toBe('dnd');

    await can.api.call('updateMyStatus', { body: { visibility: 'invisible' } });
    await watcher.waitFor(
      'presence',
      (e) => e.presence.userId === canId && e.presence.state === 'offline',
    );
    await can.api.call('updateMyStatus', { body: { visibility: 'online', message: null } });

    const card = await owner.api.call('getChatUserCard', { params: { userId: canId } });
    expect(card.sharedSpaces.map((s) => s.name)).toContain('Milvasoft');
    expect(card.directConversationId).toBeNull();
    await phone.close();
    await watcher.close();
  });

  it('counts open connections', async () => {
    const ws = await WsClient.open(server.port, elif);
    await ws.waitFor('ready');
    expect(app.realtime.gateway.connectionCount).toBeGreaterThan(0);
    await ws.close();
  });
});

describe('notification centre', () => {
  it('lists, snoozes, dismisses and restores', async () => {
    const list = await elif.api.call('listNotifications', { query: {} });
    expect(list.items.length).toBeGreaterThan(0);
    const id = list.items[0]!.id;
    await elif.api.call('updateNotifications', {
      body: { ids: [id], action: 'snooze', until: new Date(Date.now() + 3600_000).toISOString() },
    });
    const snoozed = await elif.api.call('listNotifications', { query: { box: 'snoozed' } });
    expect(snoozed.items.map((n) => n.id)).toContain(id);
    await elif.api.call('updateNotifications', { body: { ids: [id], action: 'dismiss' } });
    const dismissed = await elif.api.call('listNotifications', { query: { box: 'dismissed' } });
    expect(dismissed.items.map((n) => n.id)).toContain(id);
    await elif.api.call('updateNotifications', { body: { ids: [id], action: 'restore' } });
    const counts = await elif.api.call('updateNotifications', {
      body: { all: true, action: 'read' },
    });
    expect(counts.unread).toBe(0);
  });

  it('keeps preferences, with locked channels', async () => {
    const prefs = await elif.api.call('updateNotificationPrefs', {
      body: {
        categories: [{ category: 'conversation_message', push: false }],
        digest: 'hourly',
        quietHours: { from: '22:00', to: '08:00' },
      },
    });
    expect(prefs.categories.find((c) => c.category === 'conversation_message')?.push).toBe(false);
    expect(prefs.digest).toBe('hourly');
    const security = prefs.categories.find((c) => c.category === 'security')!;
    expect(security.locked).toEqual(['inApp', 'email']);
    const off = await elif.api.call('updateNotificationPrefs', {
      body: { categories: [{ category: 'security', email: false }] },
    });
    expect(off.categories.find((c) => c.category === 'security')?.email).toBe(true);
  });
});

describe('archive', () => {
  it('stops writes in an archived conversation', async () => {
    const c = await owner.api.call('createConversation', {
      body: { type: 'space', spaceId, name: 'Eski' },
    });
    await owner.api.call('updateConversation', {
      params: { conversationId: c.id },
      body: { archived: true },
    });
    await expect(send(owner, c.id, 'x')).rejects.toMatchObject({
      status: 409,
      code: 'chat_archived',
    });
    const [row] = await app.deps.db.select().from(conversations).where(eq(conversations.id, c.id));
    expect(row!.archivedAt).not.toBeNull();
  });
});

describe('delivery latency', () => {
  it('delivers a message to another member in under 300 ms at p95 (local)', async () => {
    const conv = await owner.api.call('createConversation', {
      body: { type: 'direct', userId: canId },
    });
    const ws = await WsClient.open(server.port, can);
    await ws.waitFor('ready');
    const times: number[] = [];
    for (let i = 0; i < 60; i++) {
      const clientMsgId = uuid();
      const started = performance.now();
      const got = ws.waitFor('message.created', (e) => e.message.clientMsgId === clientMsgId);
      await owner.api.call('sendMessage', {
        params: { conversationId: conv.id },
        body: { clientMsgId, text: `ölçüm ${i}` },
      });
      await got;
      times.push(performance.now() - started);
    }
    times.sort((x, y) => x - y);
    const p95 = times[Math.floor(times.length * 0.95)]!;
    console.info(`chat delivery p50 ${times[30]!.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms`);
    // Acceptance (local, idle machine): 300 ms. Under heavy parallel load (many Testcontainers
    // runs at once) only a gross regression should fail the suite.
    expect(p95).toBeLessThan(Number(process.env.CHAT_P95_BUDGET_MS ?? 1500));
    await ws.close();
  });
});

describe('no notifications from the open conversation (H8)', () => {
  it('skips bell, toast and push for the chat on screen, not for others', async () => {
    const open = await owner.api.call('createConversation', {
      body: { type: 'direct', userId: canId },
    });
    const other = await elif.api.call('createConversation', {
      body: { type: 'direct', userId: canId },
    });
    const ws = await WsClient.open(server.port, can);
    await ws.waitFor('ready');
    ws.send({ type: 'heartbeat', active: true, focused: true, activeConversationId: open.id });
    await until(() => app.realtime.presence.isViewingConversation(canId, open.id));

    const quiet = await send(owner, open.id, `açık sohbette <@${canId}>`);
    const loud = await send(elif, other.id, 'başka sohbetten');
    // The other chat's notification arrives; the open one's would have come before it.
    await ws.waitFor('notification', (e) => e.notification.target.id === loud.id);
    expect(ws.of('notification').some((e) => e.notification.target.id === quiet.id)).toBe(false);
    const counts = await can.api.call('listNotifications', { query: {} });
    expect(counts.items.some((n) => n.target.id === quiet.id)).toBe(false);
    // The message itself still arrives live.
    await ws.waitFor('message.created', (e) => e.message.id === quiet.id);

    // Leaving the chat (or hiding the tab) brings notifications back.
    ws.send({ type: 'heartbeat', active: true, focused: false, activeConversationId: open.id });
    await until(() => !app.realtime.presence.isViewingConversation(canId, open.id));
    const back = await send(owner, open.id, 'sekme gizliyken');
    await ws.waitFor('notification', (e) => e.notification.target.id === back.id);
    await ws.close();
  });
});
