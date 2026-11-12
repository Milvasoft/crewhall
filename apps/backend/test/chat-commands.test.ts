import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq, sql as sqlRaw } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { messages, reactions } from '@crewhall/db';
import { fireDueReminders } from '../src/services/chat/commands';
import { listen, uuid, WsClient } from './chat-helpers';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/** Roadmap 23: /whisper, /me, /poll and /remind (/meet is the meet module's own calls). */

let app: TestApp;
let server: Awaited<ReturnType<typeof listen>>;
let owner: Client;
let elif: Client;
let can: Client;
let elifId: string;
let canId: string;
let groupId: string;

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
  const spaces = await owner.api.call('listSpaces');
  const spaceId = spaces.items.find((s) => s.name === 'Milvasoft')!.id;
  elif = (await join(app, owner, 'elif@milvasoft.com', 'member', [spaceId])).person;
  elifId = (await elif.api.call('me')).user.id;
  can = (await join(app, owner, 'can@milvasoft.com', 'member', [spaceId])).person;
  canId = (await can.api.call('me')).user.id;
  const group = await owner.api.call('createConversation', {
    body: { type: 'group', userIds: [elifId, canId], name: 'Ekip' },
  });
  groupId = group.id;
});

afterAll(async () => {
  await server.close();
  await app.close();
});

describe('/whisper', () => {
  it('reaches only the pair: reads, events, unread, search and previews skip it', async () => {
    const wsElif = await WsClient.open(server.port, elif);
    const wsCan = await WsClient.open(server.port, can);
    await Promise.all([wsElif.waitFor('ready'), wsCan.waitFor('ready')]);
    await send(owner, groupId, 'herkese merhaba');
    const w = await send(owner, groupId, 'gizlizarf sadece sana', { whisperTo: elifId });
    expect(w.whisperTo?.id).toBe(elifId);
    const after = await send(owner, groupId, 'son mesaj');

    await wsElif.waitFor('message.created', (e) => e.message.id === after.id);
    await wsCan.waitFor('message.created', (e) => e.message.id === after.id);
    expect(wsElif.of('message.created').some((e) => e.message.id === w.id)).toBe(true);
    expect(wsCan.of('message.created').some((e) => e.message.id === w.id)).toBe(false);

    const forElif = await elif.api.call('listMessages', { params: { conversationId: groupId } });
    expect(forElif.items.map((m) => m.text)).toContain('gizlizarf sadece sana');
    const forCan = await can.api.call('listMessages', { params: { conversationId: groupId } });
    expect(forCan.items.map((m) => m.id)).not.toContain(w.id);
    // Paging past a hidden whisper still ends cleanly.
    const page = await can.api.call('listMessages', {
      params: { conversationId: groupId },
      query: { afterSeq: w.seq - 1 },
    });
    expect(page.items.map((m) => m.id)).toEqual([after.id]);
    const before = await can.api.call('listMessages', {
      params: { conversationId: groupId },
      query: { beforeSeq: after.seq },
    });
    expect(before.items.map((m) => m.id)).not.toContain(w.id);
    expect(before.hasMoreBefore).toBe(false);

    const canConv = await can.api.call('getConversation', { params: { conversationId: groupId } });
    expect(canConv.my.unread).toBe(2);
    expect(
      (await can.api.call('searchMessages', { query: { q: 'gizlizarf' } })).items,
    ).toHaveLength(0);
    expect(
      (await elif.api.call('searchMessages', { query: { q: 'gizlizarf' } })).items,
    ).toHaveLength(1);
    await expect(
      can.api.call('addReaction', { params: { messageId: w.id }, body: { emoji: '👍' } }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      owner.api.call('pinMessage', { params: { messageId: w.id } }),
    ).rejects.toMatchObject({ code: 'invalid_target' });
    await wsElif.close();
    await wsCan.close();
  });

  it('goes only to another member, never in a direct chat, and is answered privately', async () => {
    await expect(send(owner, groupId, 'x', { whisperTo: uuid() })).rejects.toMatchObject({
      code: 'invalid_target',
    });
    const direct = await owner.api.call('createConversation', {
      body: { type: 'direct', userId: elifId },
    });
    await expect(send(owner, direct.id, 'x', { whisperTo: elifId })).rejects.toMatchObject({
      code: 'invalid_target',
    });
    const w = await send(owner, groupId, 'soru?', { whisperTo: elifId });
    // A public reply would quote the whisper to everyone.
    await expect(send(elif, groupId, 'cevap', { replyToId: w.id })).rejects.toMatchObject({
      code: 'invalid_target',
    });
    const ownerId = w.author!.id;
    const reply = await send(elif, groupId, 'cevap', { replyToId: w.id, whisperTo: ownerId });
    expect(reply.replyTo?.id).toBe(w.id);
  });
});

describe('/me', () => {
  it('sends an action line', async () => {
    const m = await send(elif, groupId, 'kahve almaya gitti', { emote: true });
    expect(m.emote).toBe(true);
    await expect(send(elif, groupId, '  ', { emote: true })).rejects.toMatchObject({
      status: 422,
    });
  });
});

describe('/poll', () => {
  it('creates, counts votes live, and closes', async () => {
    const ws = await WsClient.open(server.port, can);
    await ws.waitFor('ready');
    const clientMsgId = uuid();
    const msg = await owner.api.call('createPoll', {
      params: { conversationId: groupId },
      body: { clientMsgId, question: 'Öğle yemeği?', options: ['Pizza', 'Döner', 'Salata'] },
    });
    expect(msg.text).toBe('Öğle yemeği?');
    expect(msg.poll?.options.map((o) => o.text)).toEqual(['Pizza', 'Döner', 'Salata']);
    const again = await owner.api.call('createPoll', {
      params: { conversationId: groupId },
      body: { clientMsgId, question: 'Öğle yemeği?', options: ['Pizza', 'Döner'] },
    });
    expect(again.id).toBe(msg.id);
    const pollId = msg.poll!.id;

    await elif.api.call('votePoll', { params: { pollId }, body: { options: [1] } });
    const voted = await can.api.call('votePoll', { params: { pollId }, body: { options: [0] } });
    expect(voted.poll?.options.map((o) => o.count)).toEqual([1, 1, 0]);
    // Changing one's mind replaces the vote.
    const changed = await can.api.call('votePoll', { params: { pollId }, body: { options: [1] } });
    expect(changed.poll?.options[1]).toMatchObject({ count: 2 });
    expect(changed.poll?.voterCount).toBe(2);
    await ws.waitFor(
      'message.updated',
      (e) => e.message.id === msg.id && e.message.poll?.options[1]?.count === 2,
    );
    await expect(
      can.api.call('votePoll', { params: { pollId }, body: { options: [0, 1] } }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      can.api.call('votePoll', { params: { pollId }, body: { options: [5] } }),
    ).rejects.toMatchObject({ status: 422 });

    await expect(can.api.call('closePoll', { params: { pollId } })).rejects.toMatchObject({
      status: 403,
    });
    const closed = await owner.api.call('closePoll', { params: { pollId } });
    expect(closed.poll?.closedAt).not.toBeNull();
    await expect(
      elif.api.call('votePoll', { params: { pollId }, body: { options: [0] } }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      owner.api.call('updateMessage', { params: { messageId: msg.id }, body: { text: 'x' } }),
    ).rejects.toMatchObject({ code: 'chat_message_not_editable' });

    const list = await elif.api.call('listMessages', { params: { conversationId: groupId } });
    expect(list.items.find((m) => m.id === msg.id)?.poll?.options[1]?.userIds).toEqual(
      expect.arrayContaining([elifId, canId]),
    );
    await ws.close();
  });

  it('allows several options when multiple', async () => {
    const msg = await elif.api.call('createPoll', {
      params: { conversationId: groupId },
      body: { clientMsgId: uuid(), question: 'Günler?', options: ['Pzt', 'Sal'], multiple: true },
    });
    const v = await can.api.call('votePoll', {
      params: { pollId: msg.poll!.id },
      body: { options: [0, 1] },
    });
    expect(v.poll?.options.map((o) => o.count)).toEqual([1, 1]);
  });
});

describe('/remind', () => {
  it('stores, lists, fires once as a notification and can be deleted', async () => {
    await expect(
      elif.api.call('createChatReminder', {
        body: {
          conversationId: groupId,
          text: 'geçmiş',
          remindAt: new Date(Date.now() - 3600_000).toISOString(),
        },
      }),
    ).rejects.toMatchObject({ status: 422 });
    const soon = new Date(Date.now() + 15 * 60_000).toISOString();
    const r = await elif.api.call('createChatReminder', {
      body: { conversationId: groupId, text: 'toplantı', remindAt: soon },
    });
    const later = await elif.api.call('createChatReminder', {
      body: {
        conversationId: groupId,
        text: 'rapor',
        remindAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    expect((await elif.api.call('listChatReminders')).items.map((x) => x.id)).toEqual([
      r.id,
      later.id,
    ]);
    // Others can't touch it.
    await expect(
      can.api.call('deleteChatReminder', { params: { reminderId: r.id } }),
    ).rejects.toMatchObject({ status: 404 });

    const fired = await fireDueReminders(app.deps, new Date(Date.now() + 16 * 60_000));
    expect(fired).toBe(1);
    expect(await fireDueReminders(app.deps, new Date(Date.now() + 16 * 60_000))).toBe(0);
    const notes = await elif.api.call('listNotifications');
    const note = notes.items.find((n) => n.type === 'chat.reminder');
    expect(note?.data.text).toBe('toplantı');
    expect(note?.url).toBe(`/chat/c/${groupId}`);
    expect((await elif.api.call('listChatReminders')).items.map((x) => x.id)).toEqual([later.id]);

    await elif.api.call('deleteChatReminder', { params: { reminderId: later.id } });
    expect((await elif.api.call('listChatReminders')).items).toHaveLength(0);
  });

  it('needs membership of the conversation', async () => {
    const direct = await owner.api.call('createConversation', {
      body: { type: 'direct', userId: elifId },
    });
    await expect(
      can.api.call('createChatReminder', {
        body: {
          conversationId: direct.id,
          text: 'x',
          remindAt: new Date(Date.now() + 60_000).toISOString(),
        },
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('reaction emoji (S1)', () => {
  it('adds only a single emoji and cleans up stored text reactions', async () => {
    const m = await send(owner, groupId, 'tepki testi');
    const thumbs = String.fromCodePoint(0x1f44d, 0x1f3fd);
    const ok = await elif.api.call('addReaction', {
      params: { messageId: m.id },
      body: { emoji: thumbs },
    });
    expect(ok.reactions.map((r) => r.emoji)).toEqual([thumbs]);
    for (const emoji of ['??', 'ok', `${thumbs}${thumbs}`]) {
      await expect(
        elif.api.call('addReaction', { params: { messageId: m.id }, body: { emoji } }),
      ).rejects.toMatchObject({ status: 400, code: 'chat_invalid_reaction' });
    }

    // A "??" stored before the check: the migration removes it, and it can still be taken back.
    const orgId = (await app.deps.db.select().from(messages).where(eq(messages.id, m.id)))[0]!
      .orgId;
    await app.deps.db
      .insert(reactions)
      .values({ messageId: m.id, userId: canId, emoji: '??', orgId });
    await can.api.call('removeReaction', { params: { messageId: m.id }, body: { emoji: '??' } });
    await app.deps.db
      .insert(reactions)
      .values({ messageId: m.id, userId: canId, emoji: '??', orgId });
    // Found by name: the migration number changes when branches merge.
    const dir = fileURLToPath(new URL('../../../packages/db/migrations/', import.meta.url));
    const file = readdirSync(dir).find((f) => f.endsWith('_drop_invalid_reactions.sql'))!;
    const sql = readFileSync(`${dir}${file}`, 'utf8');
    await app.deps.db.execute(sqlRaw.raw(sql));
    const left = await app.deps.db.select().from(reactions).where(eq(reactions.messageId, m.id));
    expect(left.map((r) => r.emoji)).toEqual([thumbs]);
  });
});

describe('channel emoji', () => {
  const rocket = String.fromCodePoint(0x1f680);
  const team = String.fromCodePoint(0x1f468, 0x200d, 0x1f4bb);

  it('is set at creation, changed by members, published, and removed', async () => {
    const ws = await WsClient.open(server.port, can);
    await ws.waitFor('ready');
    const conv = await owner.api.call('createConversation', {
      body: { type: 'group', userIds: [elifId, canId], name: 'Roket', emoji: rocket },
    });
    expect(conv.emoji).toBe(rocket);

    const changed = await elif.api.call('updateConversation', {
      params: { conversationId: conv.id },
      body: { emoji: team },
    });
    expect(changed.emoji).toBe(team);
    await ws.waitFor(
      'conversation.updated',
      (e) => e.conversation.id === conv.id && e.conversation.emoji === team,
    );
    const listed = await can.api.call('getConversation', { params: { conversationId: conv.id } });
    expect(listed?.emoji).toBe(team);

    const removed = await owner.api.call('updateConversation', {
      params: { conversationId: conv.id },
      body: { emoji: null },
    });
    expect(removed.emoji).toBeNull();
    await ws.close();
  });

  it('refuses text, several emoji and direct chats', async () => {
    for (const emoji of ['ok', '??', `${rocket}${rocket}`]) {
      await expect(
        owner.api.call('updateConversation', {
          params: { conversationId: groupId },
          body: { emoji },
        }),
      ).rejects.toMatchObject({ status: 400, code: 'chat_invalid_emoji' });
    }
    await expect(
      owner.api.call('createConversation', {
        body: { type: 'group', userIds: [elifId, canId], emoji: 'x' },
      }),
    ).rejects.toMatchObject({ code: 'chat_invalid_emoji' });
    const direct = await owner.api.call('createConversation', {
      body: { type: 'direct', userId: elifId },
    });
    await expect(
      owner.api.call('updateConversation', {
        params: { conversationId: direct.id },
        body: { emoji: rocket },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('own messages are never unread', () => {
  it('reads everything before my message and never counts mine', async () => {
    const x = await send(owner, groupId, 'okunmamış soru');
    expect(
      (await can.api.call('getConversation', { params: { conversationId: groupId } })).my.unread,
    ).toBeGreaterThan(0);
    await send(can, groupId, 'cevap bir');
    const last = await send(can, groupId, 'cevap iki');
    const conv = await can.api.call('getConversation', { params: { conversationId: groupId } });
    expect(conv.my).toMatchObject({ unread: 0, unreadMentions: 0, lastReadSeq: last.seq });
    expect(conv.my.lastReadSeq).toBeGreaterThan(x.seq);
    const unreads = await can.api.call('getUnreads');
    expect(unreads.conversations.find((c) => c.conversationId === groupId)?.unread).toBe(0);
    // The other side sees only my two messages as unread, never their own.
    const other = await owner.api.call('getConversation', { params: { conversationId: groupId } });
    expect(other.my.unread).toBe(2);
  });
});

describe('mark as unread', () => {
  it('counts as unread even when only my own messages follow, until I read it', async () => {
    await send(owner, groupId, 'bir soru');
    const mine = await send(can, groupId, 'cevabım bu');
    const res = await can.api.call('markConversationUnread', {
      params: { conversationId: groupId },
      body: { fromSeq: mine.seq },
    });
    expect(res.unread).toBe(1);
    const conv = await can.api.call('getConversation', { params: { conversationId: groupId } });
    expect(conv.my).toMatchObject({ unread: 1, markedUnread: true });
    const unreads = await can.api.call('getUnreads');
    expect(unreads.conversations.find((c) => c.conversationId === groupId)?.unread).toBe(1);

    const read = await can.api.call('markConversationRead', {
      params: { conversationId: groupId },
      body: { seq: mine.seq },
    });
    expect(read.unread).toBe(0);
    const after = await can.api.call('getConversation', { params: { conversationId: groupId } });
    expect(after.my).toMatchObject({ unread: 0, markedUnread: false });

    // Writing a message reads it too.
    await can.api.call('markConversationUnread', {
      params: { conversationId: groupId },
      body: { fromSeq: mine.seq },
    });
    await send(can, groupId, 'bir şey daha');
    const sent = await can.api.call('getConversation', { params: { conversationId: groupId } });
    expect(sent.my).toMatchObject({ unread: 0, markedUnread: false });
  });
});

describe('message info', () => {
  it('tells the author who saw the message and first when, and who has not', async () => {
    const m = await send(owner, groupId, 'kim gördü?');
    await elif.api.call('markConversationRead', {
      params: { conversationId: groupId },
      body: { seq: m.seq },
    });
    const info = await owner.api.call('getMessageInfo', { params: { messageId: m.id } });
    expect(info).toMatchObject({ total: 2, seenCount: 1 });
    expect(info.seen[0]?.user.id).toBe(elifId);
    expect(info.seen[0]?.at).not.toBeNull();
    expect(info.notSeen.map((u) => u.id)).toEqual([canId]);
    // Reading again later keeps the first time.
    const first = info.seen[0]!.at;
    await elif.api.call('markConversationRead', {
      params: { conversationId: groupId },
      body: { seq: m.seq },
    });
    const again = await owner.api.call('getMessageInfo', { params: { messageId: m.id } });
    expect(again.seen[0]?.at).toBe(first);
    // Only the author asks.
    await expect(
      elif.api.call('getMessageInfo', { params: { messageId: m.id } }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('lists people with read receipts off too, and whispers only reach one', async () => {
    await can.api.call('updateChatSettings', { body: { readReceipts: false } });
    const m = await send(owner, groupId, 'herkes listede');
    const info = await owner.api.call('getMessageInfo', { params: { messageId: m.id } });
    expect(info.total).toBe(2);
    expect([...info.seen.map((s) => s.user.id), ...info.notSeen.map((u) => u.id)].sort()).toEqual(
      [elifId, canId].sort(),
    );
    await can.api.call('updateChatSettings', { body: { readReceipts: true } });
    const w = await send(owner, groupId, 'yalnız sana', { whisperTo: elifId });
    expect((await owner.api.call('getMessageInfo', { params: { messageId: w.id } })).total).toBe(1);
  });
});
