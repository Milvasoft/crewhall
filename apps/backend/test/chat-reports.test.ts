import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '@crewhall/api-client';
import type { PublicBootstrap } from '@crewhall/shared';
import { listen, uuid } from './chat-helpers';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/**
 * "Yöneticiye bildir": a message (that the reporter can read) or a person is reported to the
 * org's own owners and admins, who are notified and see, resolve or dismiss the reports.
 */

let app: TestApp;
let server: Awaited<ReturnType<typeof listen>>;
let owner: Client;
let ada: Client;
let elif: Client;
let can: Client;
let oguz: Client;
let ownerId: string;
let adaId: string;
let elifId: string;
let canId: string;
let oguzId: string;
let directId: string;
let messageId: string;

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

const reportNotes = async (c: Client) =>
  (await c.api.call('listNotifications', { query: {} })).items.filter(
    (n) => n.type === 'chat.report',
  );

beforeAll(async () => {
  app = await createTestApp();
  server = await listen(app);
  ({ owner } = await setupWithOwner(app));
  ownerId = (await owner.api.call('me')).user.id;
  const a = await join(app, owner, 'ada@milvasoft.com', 'admin');
  ada = a.person;
  adaId = a.me.user.id;
  // Admins fall under the org 2FA policy.
  await ada.enrolTotp();
  const e = await join(app, owner, 'elif@milvasoft.com', 'member');
  elif = e.person;
  elifId = e.me.user.id;
  const c = await join(app, owner, 'can@milvasoft.com', 'member');
  can = c.person;
  canId = c.me.user.id;
  const o = await join(app, owner, 'oguz@milvasoft.com', 'member');
  oguz = o.person;
  oguzId = o.me.user.id;

  // Elif and Can talk in private; nobody else (the admins included) is in the conversation.
  directId = (await elif.api.call('createConversation', { body: { type: 'direct', userId: canId } }))
    .id;
  messageId = (
    await can.api.call('sendMessage', {
      params: { conversationId: directId },
      body: { clientMsgId: uuid(), text: 'çok kaba bir mesaj' },
    })
  ).id;
});

afterAll(async () => {
  await server.close();
  await app.close();
});

describe('chat reports', () => {
  it('offers the capability', async () => {
    const boot = await elif.raw<PublicBootstrap>('GET', '/api/v1/bootstrap');
    expect(boot.body.server?.capabilities).toContain('chat.reports');
  });

  it('does not let anyone report a message they cannot read', async () => {
    await expectCode(
      oguz.api.call('reportChatMessage', { params: { messageId }, body: { reason: 'spam' } }),
      404,
      'not_found',
    );
    // Org admins do not read conversations they are not in either.
    await expectCode(
      ada.api.call('reportChatMessage', { params: { messageId }, body: { reason: 'spam' } }),
      404,
    );
    await expectCode(
      oguz.api.call('reportChatMessage', {
        params: { messageId: uuid() },
        body: { reason: 'spam' },
      }),
      404,
    );
  });

  it('does not let people report themselves or their own messages', async () => {
    await expectCode(
      can.api.call('reportChatMessage', { params: { messageId }, body: { reason: 'other' } }),
      400,
      'chat_report_self',
    );
    await expectCode(
      can.api.call('reportUser', { params: { userId: canId }, body: { reason: 'other' } }),
      400,
      'chat_report_self',
    );
  });

  it('reports a readable message and notifies every owner and admin once', async () => {
    const first = await elif.api.call('reportChatMessage', {
      params: { messageId },
      body: { reason: 'harassment', note: '  Sürekli böyle yazıyor.  ' },
    });
    expect(first.status).toBe('open');
    // Again while it is open: the same report, no second notification.
    const again = await elif.api.call('reportChatMessage', {
      params: { messageId },
      body: { reason: 'harassment' },
    });
    expect(again.id).toBe(first.id);

    for (const admin of [owner, ada]) {
      const notes = await reportNotes(admin);
      expect(notes).toHaveLength(1);
      expect(notes[0]!.target).toMatchObject({ type: 'report', id: first.id });
      expect(notes[0]!.data).toMatchObject({ kind: 'message', name: 'can' });
      expect(notes[0]!.url).toBe('/admin/reports');
      // The message's words stay out of the notification.
      expect(JSON.stringify(notes[0]!.data)).not.toContain('kaba');
    }
    expect(await reportNotes(elif)).toHaveLength(0);
    expect(await reportNotes(can)).toHaveLength(0);
  });

  it('reports a person', async () => {
    await expectCode(
      elif.api.call('reportUser', { params: { userId: uuid() }, body: { reason: 'spam' } }),
      404,
      'member_not_found',
    );
    const r = await elif.api.call('reportUser', {
      params: { userId: oguzId },
      body: { reason: 'spam' },
    });
    expect(r.status).toBe('open');
    const notes = await reportNotes(ada);
    expect(notes.map((n) => n.data.kind).sort()).toEqual(['message', 'user']);
  });

  it('lets only owners and admins list reports', async () => {
    await expectCode(elif.api.call('listChatReports', { query: {} }), 403, 'forbidden');
    const list = await ada.api.call('listChatReports', { query: {} });
    expect(list.items).toHaveLength(2);
    const [userReport, messageReport] = list.items;
    expect(userReport).toMatchObject({
      kind: 'user',
      reason: 'spam',
      reporter: { id: elifId },
      reportedUser: { id: oguzId },
      message: null,
    });
    // Admins see the words without being in the conversation.
    expect(messageReport).toMatchObject({
      kind: 'message',
      status: 'open',
      reason: 'harassment',
      note: 'Sürekli böyle yazıyor.',
      reporter: { id: elifId },
      reportedUser: { id: canId },
      message: {
        id: messageId,
        conversationId: directId,
        conversationType: 'direct',
        conversationTitle: null,
        excerpt: 'çok kaba bir mesaj',
        deleted: false,
      },
    });
    expect(messageReport!.message!.url).toContain(`/chat/c/${directId}`);

    // Cursor paging and the status filter.
    const one = await owner.api.call('listChatReports', { query: { limit: 1 } });
    expect(one.items.map((r) => r.id)).toEqual([userReport!.id]);
    const two = await owner.api.call('listChatReports', {
      query: { limit: 1, cursor: one.nextCursor! },
    });
    expect(two.items.map((r) => r.id)).toEqual([messageReport!.id]);
    expect(two.nextCursor).toBeNull();
    await expectCode(
      owner.api.call('listChatReports', { query: { cursor: 'not-a-cursor' } }),
      400,
    );
  });

  it('lets only owners and admins resolve, dismiss or reopen a report', async () => {
    const [userReport, messageReport] = (await ada.api.call('listChatReports', { query: {} }))
      .items;
    await expectCode(
      elif.api.call('resolveChatReport', {
        params: { reportId: messageReport!.id },
        body: { status: 'resolved' },
      }),
      403,
      'forbidden',
    );
    const resolved = await ada.api.call('resolveChatReport', {
      params: { reportId: messageReport!.id },
      body: { status: 'resolved' },
    });
    expect(resolved).toMatchObject({ status: 'resolved', resolvedBy: { id: adaId } });
    expect(resolved.resolvedAt).not.toBeNull();
    // A closed report leaves the other admins' bell too.
    const ownerNote = (await reportNotes(owner)).find((n) => n.target.id === messageReport!.id);
    expect(ownerNote!.readAt).not.toBeNull();

    await owner.api.call('resolveChatReport', {
      params: { reportId: userReport!.id },
      body: { status: 'dismissed' },
    });
    const open = await owner.api.call('listChatReports', { query: { status: 'open' } });
    expect(open.items).toHaveLength(0);
    const dismissed = await owner.api.call('listChatReports', { query: { status: 'dismissed' } });
    expect(dismissed.items.map((r) => r.id)).toEqual([userReport!.id]);
    expect(dismissed.items[0]!.resolvedBy?.id).toBe(ownerId);

    const reopened = await owner.api.call('resolveChatReport', {
      params: { reportId: userReport!.id },
      body: { status: 'open' },
    });
    expect(reopened).toMatchObject({ status: 'open', resolvedBy: null, resolvedAt: null });
    await expectCode(
      owner.api.call('resolveChatReport', { params: { reportId: uuid() }, body: { status: 'open' } }),
      404,
    );
  });

  it('keeps the reported words after the message is deleted, without a link', async () => {
    const id = (
      await can.api.call('sendMessage', {
        params: { conversationId: directId },
        body: { clientMsgId: uuid(), text: 'silinecek mesaj' },
      })
    ).id;
    const r = await elif.api.call('reportChatMessage', {
      params: { messageId: id },
      body: { reason: 'inappropriate' },
    });
    await can.api.call('deleteMessage', { params: { messageId: id } });
    const list = await owner.api.call('listChatReports', { query: { status: 'open' } });
    const report = list.items.find((x) => x.id === r.id)!;
    expect(report.message).toMatchObject({ excerpt: 'silinecek mesaj', deleted: true, url: null });
    // A deleted message cannot be reported anymore.
    await expectCode(
      elif.api.call('reportChatMessage', { params: { messageId: id }, body: { reason: 'spam' } }),
      404,
    );
  });

  it('notifies other admins when an admin reports', async () => {
    await expectCode(
      ada.api.call('reportUser', { params: { userId: adaId }, body: { reason: 'other' } }),
      400,
      'chat_report_self',
    );
    const before = (await reportNotes(owner)).length;
    const adaBefore = (await reportNotes(ada)).length;
    await ada.api.call('reportUser', { params: { userId: elifId }, body: { reason: 'other' } });
    expect(await reportNotes(owner)).toHaveLength(before + 1);
    expect(await reportNotes(ada)).toHaveLength(adaBefore);
  });
});
