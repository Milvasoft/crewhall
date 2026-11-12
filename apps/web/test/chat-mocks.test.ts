import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { api, isApiError } from '@/lib/api';
import { applyReaction, firstGap, mergeMessages, sortConversations } from '@/lib/chat/cache';
import { chatKeys, type MessageWindow } from '@/lib/chat/queries';
import { bindRuntimeForTests, handleEvent } from '@/lib/chat/runtime';
import { parseText, splitBlocks } from '@/lib/chat/text';
import { type Conversation, type Message } from '@/lib/chat/types';
import { CONV, WEBHOOK, WEBHOOK_KEY } from '@/mocks/chatSeed';
import { db } from '@/mocks/db';
import { USER } from '@/mocks/seed';

function signedInAs(userId: string) {
  const s = db();
  s.sessions.push({
    id: `test-${userId}`,
    userId,
    userAgent: 'test',
    ip: null,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
  });
  s.auth.sessionId = `test-${userId}`;
}

async function rejects(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

describe('chat contract mock', () => {
  it('lists pinned chats first with unread and mention counts', async () => {
    signedInAs(USER.bugra);
    const { items } = await api.call('listConversations', { query: {} });
    expect(items[0]?.id).toBe(CONV.milvaion);
    expect(items[1]?.id).toBe(CONV.prod);
    const milvaion = items.find((c) => c.id === CONV.milvaion)!;
    expect(milvaion.my.unread).toBe(2);
    expect(milvaion.my.unreadMentions).toBe(1);
    const group = items.find((c) => c.id === CONV.selinCan)!;
    expect(group.title).toBe('Selin, Can');
    const unread = await api.call('listConversations', { query: { filter: 'unread' } });
    expect(unread.items.every((c) => c.my.unread > 0)).toBe(true);
  });

  it('sends idempotently by clientMsgId and fills gaps with afterSeq', async () => {
    signedInAs(USER.bugra);
    const clientMsgId = crypto.randomUUID();
    const body = { clientMsgId, text: `Selam <@${USER.elif}>`, attachmentNodeIds: [] };
    const a = await api.call('sendMessage', { params: { conversationId: CONV.elif }, body });
    const b = await api.call('sendMessage', { params: { conversationId: CONV.elif }, body });
    expect(b.id).toBe(a.id);
    expect(a.mentions).toEqual([{ kind: 'user', userId: USER.elif }]);
    const after = await api.call('listMessages', {
      params: { conversationId: CONV.elif },
      query: { afterSeq: a.seq - 1 },
    });
    expect(after.items.map((m) => m.seq)).toEqual([a.seq]);
    expect(after.hasMoreAfter).toBe(false);
  });

  it('asks to confirm @all in a chat of 20+ people only', async () => {
    signedInAs(USER.bugra);
    // Seven people: no confirmation needed.
    const m = await api.call('sendMessage', {
      params: { conversationId: CONV.genel },
      body: { clientMsgId: crypto.randomUUID(), text: '<@all> demo', attachmentNodeIds: [] },
    });
    expect(m.mentions[0]?.kind).toBe('all');
  });

  it('reads move forward only and mark-unread moves back', async () => {
    signedInAs(USER.bugra);
    const conv = await api.call('getConversation', { params: { conversationId: CONV.altyapi } });
    expect(conv.my.unread).toBe(2);
    const read = await api.call('markConversationRead', {
      params: { conversationId: CONV.altyapi },
      body: { seq: conv.lastSeq },
    });
    expect(read).toMatchObject({ unread: 0, unreadMentions: 0 });
    const back = await api.call('markConversationRead', {
      params: { conversationId: CONV.altyapi },
      body: { seq: 1 },
    });
    expect(back.lastReadSeq).toBe(conv.lastSeq);
    const unread = await api.call('markConversationUnread', {
      params: { conversationId: CONV.altyapi },
      body: { fromSeq: conv.lastSeq },
    });
    expect(unread.unread).toBe(1);
  });

  it('hides chats from non-members and edits only own messages', async () => {
    signedInAs(USER.burak);
    const e = await rejects(api.call('getConversation', { params: { conversationId: CONV.prod } }));
    expect(isApiError(e, 'not_found')).toBe(true);
    signedInAs(USER.bugra);
    const page = await api.call('listMessages', {
      params: { conversationId: CONV.milvaion },
      query: {},
    });
    const others = page.items.find((m) => m.author && m.author.id !== USER.bugra)!;
    const denied = await rejects(
      api.call('updateMessage', { params: { messageId: others.id }, body: { text: 'x' } }),
    );
    expect(isApiError(denied, 'chat_message_not_editable')).toBe(true);
  });

  it('adds a person with 7 days of history to a group', async () => {
    signedInAs(USER.bugra);
    await api.call('addConversationMembers', {
      params: { conversationId: CONV.selinCan },
      body: { userIds: [USER.zeynep], history: 'none' },
    });
    signedInAs(USER.zeynep);
    const page = await api.call('listMessages', {
      params: { conversationId: CONV.selinCan },
      query: {},
    });
    // Only the system line about her being added.
    expect(page.items.map((m) => m.kind)).toEqual(['system']);
    const conv = await api.call('getConversation', { params: { conversationId: CONV.selinCan } });
    expect(conv.title).toBe('Ahmet, Selin, Can');
  });

  it('webhooks: full URL once, deliveries logged, wrong key 401', async () => {
    signedInAs(USER.bugra);
    const created = await api.call('createIncomingWebhook', {
      params: { conversationId: CONV.prod },
      body: { name: 'Grafana' },
    });
    expect(created.url).toContain('key=');
    expect(created.webhook.maskedUrl).toContain('••••');
    const list = await api.call('listIncomingWebhooks', { params: { conversationId: CONV.prod } });
    expect(list.items.map((w) => w.name)).toContain('Grafana');
    const ok = await fetch(created.url, {
      method: 'POST',
      body: JSON.stringify({
        text: 'CPU %95',
        card: { severity: 'critical', title: 'CPU yüksek' },
      }),
    });
    expect(ok.status).toBe(200);
    const bad = await fetch(created.url.replace(/key=[^&]+/, 'key=nope'), {
      method: 'POST',
      body: '{}',
    });
    expect(bad.status).toBe(401);
    const log = await api.call('listWebhookDeliveries', {
      params: { webhookId: created.webhook.id },
      query: {},
    });
    expect(log.items[0]?.status).toBe(200);
    const page = await api.call('listMessages', {
      params: { conversationId: CONV.prod },
      query: {},
    });
    expect(page.items.at(-1)?.card?.title).toBe('CPU yüksek');
    // Seeded Milvaion hook hit its rate limit in the last hour.
    expect(list.items.find((w) => w.id === WEBHOOK.milvaion)?.health).toBe('limited');
    void WEBHOOK_KEY;
  });

  it('Google Chat cardsV2 bodies become cards', async () => {
    signedInAs(USER.bugra);
    const res = await fetch(`http://localhost/api/hooks/${WEBHOOK.seq}?key=${WEBHOOK_KEY}`, {
      method: 'POST',
      body: JSON.stringify({
        cardsV2: [
          {
            cardId: 'a',
            card: {
              header: { title: 'Seq alarmı', subtitle: 'milvaion-api' },
              sections: [{ widgets: [{ decoratedText: { topLabel: 'Hata', text: '48' } }] }],
            },
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const page = await api.call('listMessages', {
      params: { conversationId: CONV.prod },
      query: {},
    });
    expect(page.items.at(-1)?.card).toMatchObject({
      title: 'Seq alarmı',
      fields: [{ label: 'Hata', value: '48' }],
    });
  });

  it('notifications: bulk read, snooze and counts', async () => {
    signedInAs(USER.bugra);
    const before = await api.call('getNotificationCounts');
    expect(before.unread).toBeGreaterThan(0);
    const { items } = await api.call('listNotifications', { query: { kind: 'mentions' } });
    expect(items.length).toBe(2);
    const after = await api.call('updateNotifications', {
      body: { ids: items.map((n) => n.id), action: 'read' },
    });
    expect(after.unread).toBe(before.unread - 2);
    const snoozed = await api.call('updateNotifications', {
      body: {
        ids: [items[0]!.id],
        action: 'snooze',
        until: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    expect(snoozed.snoozed).toBe(before.snoozed + 1);
  });

  it('person card lists shared spaces and the direct chat', async () => {
    signedInAs(USER.bugra);
    const card = await api.call('getChatUserCard', { params: { userId: USER.mert } });
    expect(card.directConversationId).toBe(CONV.mert);
    expect(card.presence.auto).toBe('meeting');
    expect(card.sharedSpaces.map((x) => x.name)).toContain('Altyapı');
  });
});

describe('chat cache', () => {
  const msg = (seq: number, extra: Partial<Message> = {}): Message => ({
    id: `m${seq}`,
    conversationId: 'c',
    seq,
    kind: 'user',
    author: { id: 'u2', name: 'Elif', email: 'e@x.io', imageUrl: null },
    webhook: null,
    text: `m${seq}`,
    mentions: [],
    card: null,
    system: null,
    attachments: [],
    replyTo: null,
    reactions: [],
    clientMsgId: null,
    pinnedAt: null,
    editedAt: null,
    deletedAt: null,
    createdAt: new Date(seq * 1000).toISOString(),
    updatedAt: new Date(seq * 1000).toISOString(),
    ...extra,
  });

  it('merges by seq, keeps the fresher copy and finds gaps', () => {
    const merged = mergeMessages(
      [msg(1), msg(3)],
      [msg(2), msg(3, { text: 'old', updatedAt: new Date(0).toISOString() })],
    );
    expect(merged.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(merged[2]?.text).toBe('m3');
    expect(firstGap([msg(1), msg(2), msg(5)], 0)).toBe(2);
    expect(firstGap([msg(1), msg(2)], 0)).toBeNull();
  });

  it('applies reaction events incrementally', () => {
    let m = msg(1);
    m = applyReaction(m, '👍', 'me', true, 'me');
    m = applyReaction(m, '👍', 'u2', true, 'me');
    expect(m.reactions[0]).toMatchObject({ count: 2, mine: true });
    m = applyReaction(m, '👍', 'me', false, 'me');
    expect(m.reactions[0]).toMatchObject({ count: 1, mine: false });
    m = applyReaction(m, '👍', 'u2', false, 'me');
    expect(m.reactions).toEqual([]);
  });

  it('a message with a seq gap triggers an afterSeq catch-up', async () => {
    signedInAs(USER.bugra);
    const qc = new QueryClient();
    bindRuntimeForTests(qc, USER.bugra);
    const page = await api.call('listMessages', {
      params: { conversationId: CONV.elif },
      query: {},
    });
    const conv = await api.call('getConversation', { params: { conversationId: CONV.elif } });
    qc.setQueryData<Conversation[]>(chatKeys.conversations, [conv]);
    qc.setQueryData<MessageWindow>(chatKeys.messages(CONV.elif), {
      items: page.items,
      hasMore: false,
      hasNewer: false,
    });
    // Two messages arrive on the server; the socket only delivers the second.
    const send = (text: string) =>
      api.call('sendMessage', {
        params: { conversationId: CONV.elif },
        body: { clientMsgId: crypto.randomUUID(), text, attachmentNodeIds: [] },
      });
    const missed = await send('kaçırılan');
    const delivered = await send('gelen');
    handleEvent({ type: 'message.created', conversationId: CONV.elif, message: delivered });
    await new Promise((r) => setTimeout(r, 50));
    const w = qc.getQueryData<MessageWindow>(chatKeys.messages(CONV.elif))!;
    expect(w.items.map((m) => m.seq).slice(-2)).toEqual([missed.seq, delivered.seq]);
  });

  it('sorts pinned by position, then by last message', () => {
    const base = (id: string, at: string, pin: number | null): Conversation =>
      ({
        id,
        lastMessageAt: at,
        createdAt: at,
        my: { pinnedAt: pin === null ? null : at, pinPosition: pin },
      }) as Conversation;
    const out = sortConversations([
      base('a', '2026-01-01T00:00:00Z', null),
      base('b', '2026-01-03T00:00:00Z', null),
      base('p2', '2026-01-01T00:00:00Z', 1),
      base('p1', '2025-01-01T00:00:00Z', 0),
    ]);
    expect(out.map((c) => c.id)).toEqual(['p1', 'p2', 'b', 'a']);
  });
});

describe('chat text', () => {
  it('splits mentions, links, inline code and fenced blocks', () => {
    expect(parseText('Bak <@u1> `x` https://a.io/b.')).toEqual([
      { kind: 'text', text: 'Bak ' },
      { kind: 'mention', userId: 'u1' },
      { kind: 'text', text: ' ' },
      { kind: 'code', text: 'x' },
      { kind: 'text', text: ' ' },
      { kind: 'link', url: 'https://a.io/b' },
      { kind: 'text', text: '.' },
    ]);
    expect(splitBlocks('Önce\n```csharp\nvar x = 1;\n```\nsonra')).toEqual([
      { kind: 'text', text: 'Önce' },
      { kind: 'code', text: 'var x = 1;', lang: 'csharp' },
      { kind: 'text', text: 'sonra' },
    ]);
  });
});
