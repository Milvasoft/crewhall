import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scheduledMessages } from '@crewhall/db';
import { serviceDeps } from '../src/jobs/service-deps';
import { deliverDue } from '../src/services/chat/scheduled';
import { uuid } from './chat-helpers';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/** Scheduled messages: "Daha sonra gönder" and /zamanla. */

let app: TestApp;
let owner: Client;
let elif: Client;
let can: Client;
let elifId: string;
let canId: string;
let groupId: string;

const MIN = 60_000;
const at = (ms: number) => new Date(Date.now() + ms).toISOString();
const sweep = (ms: number) => deliverDue(serviceDeps(app.deps), new Date(Date.now() + ms));
const statusOf = async (id: string) =>
  (await app.deps.db.select().from(scheduledMessages).where(eq(scheduledMessages.id, id)))[0]!;

beforeAll(async () => {
  app = await createTestApp();
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
  await app.close();
});

describe('scheduled messages', () => {
  it('is created, listed, edited and cancelled by its author only', async () => {
    const s = await elif.api.call('createScheduledMessage', {
      params: { conversationId: groupId },
      body: { text: 'Toplantıyı unutmayın', sendAt: at(60 * MIN) },
    });
    expect(s.status).toBe('scheduled');
    const list = await elif.api.call('listScheduledMessages', {
      params: { conversationId: groupId },
    });
    expect(list.items.map((x) => x.id)).toEqual([s.id]);
    // Others don't see or touch it.
    expect(
      (await can.api.call('listScheduledMessages', { params: { conversationId: groupId } })).items,
    ).toHaveLength(0);
    await expect(
      can.api.call('deleteScheduledMessage', { params: { scheduledId: s.id } }),
    ).rejects.toMatchObject({ status: 404 });

    const edited = await elif.api.call('updateScheduledMessage', {
      params: { scheduledId: s.id },
      body: { text: 'Toplantı 10:00', sendAt: at(90 * MIN) },
    });
    expect(edited.text).toBe('Toplantı 10:00');
    await elif.api.call('deleteScheduledMessage', { params: { scheduledId: s.id } });
    expect((await statusOf(s.id)).status).toBe('cancelled');
    await expect(
      elif.api.call('updateScheduledMessage', {
        params: { scheduledId: s.id },
        body: { text: 'x' },
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('refuses times in the past or more than a year ahead, and empty messages', async () => {
    for (const sendAt of [at(-10 * MIN), at(400 * 24 * 60 * MIN)]) {
      await expect(
        elif.api.call('createScheduledMessage', {
          params: { conversationId: groupId },
          body: { text: 'x', sendAt },
        }),
      ).rejects.toMatchObject({ status: 422 });
    }
    await expect(
      elif.api.call('createScheduledMessage', {
        params: { conversationId: groupId },
        body: { text: '  ', sendAt: at(MIN) },
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('posts on time as a normal message with mentions and replies', async () => {
    const first = await owner.api.call('sendMessage', {
      params: { conversationId: groupId },
      body: { clientMsgId: uuid(), text: 'Soru: kim geliyor?' },
    });
    const s = await elif.api.call('createScheduledMessage', {
      params: { conversationId: groupId },
      body: { text: `Ben geliyorum <@${canId}>`, replyToId: first.id, sendAt: at(30 * MIN) },
    });
    expect(await sweep(10 * MIN)).toBe(0);
    expect(await sweep(31 * MIN)).toBe(1);
    const row = await statusOf(s.id);
    expect(row.status).toBe('sent');
    const page = await can.api.call('listMessages', { params: { conversationId: groupId } });
    const posted = page.items.find((m) => m.id === row.messageId)!;
    expect(posted).toMatchObject({ text: `Ben geliyorum <@${canId}>` });
    expect(posted.author?.id).toBe(elifId);
    expect(posted.replyTo?.id).toBe(first.id);
    const bell = await can.api.call('listNotifications');
    expect(bell.items.some((n) => n.type === 'chat.mention' && n.target.id === posted.id)).toBe(
      true,
    );
    // Swept twice: still one message.
    expect(await sweep(32 * MIN)).toBe(0);
  });

  it('sends at once on "Şimdi gönder"', async () => {
    const s = await elif.api.call('createScheduledMessage', {
      params: { conversationId: groupId },
      body: { text: 'Hemen', sendAt: at(5 * 24 * 60 * MIN) },
    });
    const msg = await elif.api.call('sendScheduledMessageNow', { params: { scheduledId: s.id } });
    expect(msg.text).toBe('Hemen');
    expect((await statusOf(s.id)).status).toBe('sent');
  });

  it('fails and tells the author when they left the conversation meanwhile', async () => {
    const s = await can.api.call('createScheduledMessage', {
      params: { conversationId: groupId },
      body: { text: 'Geç kalacağım', sendAt: at(20 * MIN) },
    });
    await owner.api.call('removeConversationMember', {
      params: { conversationId: groupId, userId: canId },
    });
    expect(await sweep(21 * MIN)).toBe(0);
    const row = await statusOf(s.id);
    expect(row).toMatchObject({ status: 'failed', error: 'not_member' });
    const bell = await can.api.call('listNotifications');
    const note = bell.items.find((n) => n.type === 'chat.scheduled_failed');
    expect(note?.data.excerpt).toBe('Geç kalacağım');
  });
});
