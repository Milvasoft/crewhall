import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mailConversations, notifications } from '@crewhall/db';
import type { MailInbox, WsServerEvent } from '@crewhall/shared';
import { userTopic } from '../src/realtime/bus';
import { closeAllMailConnections } from '../src/services/mail/imap';
import { settleLive } from '../src/services/mail/live';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';
import { MAILBOXES, deliver, startGreenMail, withMailbox, type GreenMail } from './mail-containers';

/** Shared inbox (sonraki-isler.md "Ortak gelen kutusu") against GreenMail. */
describe('shared inbox', () => {
  let gm: GreenMail;
  let app: TestApp;
  let owner: Client;
  let ayse: Client;
  let ayseId: string;
  let viewer: Client;
  let outsider: Client;
  let spaceId: string;
  let inbox: MailInbox;
  const events: WsServerEvent[] = [];

  beforeAll(async () => {
    [gm, app] = await Promise.all([startGreenMail(), createTestApp()]);
    ({ owner } = await setupWithOwner(app));
    await owner.api.call('mailUpdateServerSettings', {
      body: {
        imapHost: gm.host,
        imapPort: gm.imapPort,
        imapSecurity: 'none',
        smtpHost: gm.host,
        smtpPort: gm.smtpPort,
        smtpSecurity: 'none',
        authMode: 'password',
      },
    });
    spaceId = (await owner.api.call('createSpace', { body: { name: 'Destek', color: 's3' } })).id;
    const a = await join(app, owner, 'ayse@milvasoft.com', 'member');
    ayse = a.person;
    ayseId = a.me.user.id;
    const v = await join(app, owner, 'veli@milvasoft.com', 'member');
    viewer = v.person;
    outsider = (await join(app, owner, 'dis@milvasoft.com', 'member')).person;
    await owner.api.call('addSpaceMember', {
      params: { spaceId },
      body: { userId: ayseId, role: 'editor' },
    });
    await owner.api.call('addSpaceMember', {
      params: { spaceId },
      body: { userId: v.me.user.id, role: 'viewer' },
    });
    app.deps.bus.subscribe(userTopic(ayseId), (e) => events.push(e));
  });

  afterAll(async () => {
    await closeAllMailConnections();
    await app?.close();
    await gm?.container.stop();
  });

  const conversations = (c: Client, query: Record<string, string> = {}) =>
    c.api.call('mailInboxConversations', { params: { inboxId: inbox.id }, query });
  /** After new mail: a read waits for the server only briefly, the rest ends in the background. */
  const afterMail = async (c: Client, query: Record<string, string> = {}) => {
    await conversations(c, query);
    await settleLive();
    return conversations(c, query);
  };

  it('adds an inbox to a space after checking its password', async () => {
    await expect(
      ayse.api.call('mailCreateInbox', {
        body: {
          spaceId,
          name: 'Destek',
          email: MAILBOXES.destek.address,
          password: MAILBOXES.destek.password,
        },
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      owner.api.call('mailCreateInbox', {
        body: { spaceId, name: 'Destek', email: MAILBOXES.destek.address, password: 'yanlış' },
      }),
    ).rejects.toMatchObject({ code: 'mail_auth_failed' });
    inbox = await owner.api.call('mailCreateInbox', {
      body: {
        spaceId,
        name: 'Destek',
        email: MAILBOXES.destek.address,
        password: MAILBOXES.destek.password,
        slaFirstResponseMinutes: 60,
      },
    });
    expect(inbox).toMatchObject({ name: 'Destek', canManage: true, slaFirstResponseMinutes: 60 });
    await expect(
      owner.api.call('mailCreateInbox', {
        body: {
          spaceId,
          name: 'İkinci',
          email: MAILBOXES.destek.address,
          password: MAILBOXES.destek.password,
        },
      }),
    ).rejects.toMatchObject({ code: 'mail_inbox_exists' });
    // Members of the space see it; others do not learn it exists.
    expect((await ayse.api.call('mailInboxes')).items.map((i) => i.id)).toEqual([inbox.id]);
    expect((await viewer.api.call('mailInboxes')).items[0]).toMatchObject({
      canWork: false,
      canManage: false,
    });
    expect((await outsider.api.call('mailInboxes')).items).toEqual([]);
    await expect(conversations(outsider)).rejects.toMatchObject({ status: 404 });
    // A personal mailbox is unaffected: Ayşe has none.
    await expect(ayse.api.call('mailFolders')).rejects.toMatchObject({
      code: 'mail_account_required',
    });
  });

  it('turns incoming threads into open conversations', async () => {
    await deliver(gm, {
      from: 'Müşteri <musteri@example.com>',
      to: MAILBOXES.destek.address,
      subject: 'Faturam gelmedi',
      text: 'Merhaba, ekim faturası gelmedi.',
      messageId: '<fatura-1@example.com>',
    });
    await deliver(gm, {
      from: 'Başka <baska@example.com>',
      to: MAILBOXES.destek.address,
      subject: 'Şifre sıfırlama',
      text: 'Giriş yapamıyorum.',
    });
    const list = await conversations(ayse);
    expect(list.items.map((c) => c.subject).sort()).toEqual(['Faturam gelmedi', 'Şifre sıfırlama']);
    const fatura = list.items.find((c) => c.subject === 'Faturam gelmedi')!;
    expect(fatura).toMatchObject({
      status: 'open',
      assignee: null,
      unread: true,
      customer: { address: 'musteri@example.com', name: 'Müşteri' },
      firstResponseAt: null,
      sla: { breached: false },
    });
    expect(fatura.sla.dueAt).not.toBeNull();
    const counts = (await ayse.api.call('mailInboxes')).items[0]!.counts;
    expect(counts).toMatchObject({ open: 2, unassigned: 2, mine: 0 });
  });

  it('assigns, tags, notes, and keeps notes from the customer', async () => {
    const [c] = (await conversations(ayse, { q: 'fatura' })).items;
    await expect(
      viewer.api.call('mailUpdateInboxConversation', {
        params: { inboxId: inbox.id, conversationId: c!.id },
        body: { status: 'pending' },
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      ayse.api.call('mailUpdateInboxConversation', {
        params: { inboxId: inbox.id, conversationId: c!.id },
        body: { assigneeId: (await outsider.api.call('me')).user.id },
      }),
    ).rejects.toMatchObject({ code: 'mail_inbox_assignee_invalid' });
    const updated = await owner.api.call('mailUpdateInboxConversation', {
      params: { inboxId: inbox.id, conversationId: c!.id },
      body: { assigneeId: ayseId, tags: ['fatura', 'acil'] },
    });
    expect(updated).toMatchObject({ assignee: { id: ayseId }, tags: ['fatura', 'acil'] });
    // The assignee hears about it.
    const [n] = await app.deps.db
      .select()
      .from(notifications)
      .where(eq(notifications.type, 'mail.inbox.assigned'));
    expect(n).toMatchObject({ userId: ayseId });
    expect((await conversations(ayse, { assignee: 'me' })).items.map((x) => x.id)).toEqual([c!.id]);
    expect((await conversations(ayse, { tag: 'acil' })).items.map((x) => x.id)).toEqual([c!.id]);
    expect((await ayse.api.call('mailInboxTags', { params: { inboxId: inbox.id } })).items).toEqual(
      ['acil', 'fatura'],
    );

    const note = await ayse.api.call('mailAddInboxNote', {
      params: { inboxId: inbox.id, conversationId: c!.id },
      body: { body: 'Muhasebeye sordum.' },
    });
    const open = await viewer.api.call('mailInboxConversation', {
      params: { inboxId: inbox.id, conversationId: c!.id },
      query: {},
    });
    expect(open.notes.map((x) => x.body)).toEqual(['Muhasebeye sordum.']);
    expect(open.messages.map((m) => m.subject)).toEqual(['Faturam gelmedi']);
    await expect(
      viewer.api.call('mailDeleteInboxNote', {
        params: { inboxId: inbox.id, conversationId: c!.id, noteId: note.id },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('shows who is replying right now', async () => {
    const [c] = (await conversations(ayse, { q: 'şifre' })).items;
    events.length = 0;
    await owner.api.call('mailInboxReplying', {
      params: { inboxId: inbox.id, conversationId: c!.id },
      body: { active: true },
    });
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'mail.inbox.replying', conversationId: c!.id, active: true }),
    );
    const open = await ayse.api.call('mailInboxConversation', {
      params: { inboxId: inbox.id, conversationId: c!.id },
      query: {},
    });
    expect(open.replying.map((p) => p.name)).toEqual(['Ahmet Buğra Kösen']);
    await owner.api.call('mailInboxReplying', {
      params: { inboxId: inbox.id, conversationId: c!.id },
      body: { active: false },
    });
    const after = await ayse.api.call('mailInboxConversation', {
      params: { inboxId: inbox.id, conversationId: c!.id },
      query: {},
    });
    expect(after.replying).toEqual([]);
  });

  it('replies from the inbox address, measures the first response and reopens on an answer', async () => {
    const [c] = (await conversations(ayse, { q: 'fatura' })).items;
    const canned = await ayse.api.call('mailCreateCannedResponse', {
      params: { inboxId: inbox.id },
      body: { title: 'Fatura', html: '<p>Faturanız yeniden gönderildi.</p><script>x</script>' },
    });
    expect(canned.html).not.toContain('script');
    expect(
      (await viewer.api.call('mailCannedResponses', { params: { inboxId: inbox.id } })).items,
    ).toHaveLength(1);

    const sent = await ayse.api.call('mailInboxReply', {
      params: { inboxId: inbox.id, conversationId: c!.id },
      body: {
        to: [{ address: 'musteri@example.com' }],
        subject: 'Ynt: Faturam gelmedi',
        html: canned.html,
        status: 'pending',
      },
    });
    expect(sent.savedToSent).toBe(true);
    const after = await ayse.api.call('mailInboxConversation', {
      params: { inboxId: inbox.id, conversationId: c!.id },
      query: {},
    });
    expect(after.status).toBe('pending');
    expect(after.firstResponseAt).not.toBeNull();
    expect(after.sla.breached).toBe(false);
    expect(after.messages.map((m) => m.from?.address)).toEqual([
      'musteri@example.com',
      MAILBOXES.destek.address,
    ]);
    // The reply went out under the inbox's name and threads on the customer's message.
    const reply = after.messages[1]!;
    expect(reply.from).toMatchObject({ name: 'Destek', address: MAILBOXES.destek.address });
    expect(reply.references).toContain('<fatura-1@example.com>');

    // The customer answers: the conversation opens again.
    await deliver(gm, {
      from: 'Müşteri <musteri@example.com>',
      to: MAILBOXES.destek.address,
      subject: 'Re: Faturam gelmedi',
      text: 'Hâlâ gelmedi.',
      inReplyTo: '<fatura-1@example.com>',
      references: '<fatura-1@example.com>',
    });
    const reopened = (await afterMail(ayse, { status: 'all', q: 'fatura' })).items[0]!;
    expect(reopened).toMatchObject({ id: c!.id, status: 'open', messageCount: 3 });
  });

  it('marks SLA breaches and resolves', async () => {
    const [c] = (await conversations(ayse, { q: 'şifre' })).items;
    await app.deps.db
      .update(mailConversations)
      .set({ firstInboundAt: new Date(Date.now() - 2 * 3600_000) })
      .where(eq(mailConversations.id, c!.id));
    const late = (await conversations(ayse, { q: 'şifre' })).items[0]!;
    expect(late.sla.breached).toBe(true);
    await ayse.api.call('mailUpdateInboxConversation', {
      params: { inboxId: inbox.id, conversationId: c!.id },
      body: { status: 'resolved' },
    });
    expect((await conversations(ayse, { q: 'şifre' })).items).toEqual([]);
    expect((await conversations(ayse, { status: 'resolved' })).items.map((x) => x.id)).toEqual([
      c!.id,
    ]);
  });

  it('serves attachments of inbox messages to its members only', async () => {
    await deliver(gm, {
      from: 'Ekli <ekli@example.com>',
      to: MAILBOXES.destek.address,
      subject: 'Ekran görüntüsü',
      text: 'Ekte.',
      attachments: [{ filename: 'hata.txt', content: 'hata kaydı' }],
    });
    const [c] = (await afterMail(ayse, { q: 'ekran' })).items;
    const open = await ayse.api.call('mailInboxConversation', {
      params: { inboxId: inbox.id, conversationId: c!.id },
      query: {},
    });
    const m = open.messages[0]!;
    const file = m.attachments.find((a) => a.filename === 'hata.txt')!;
    const url = `http://localhost:3000/api/mail/attachment?folder=INBOX&uid=${m.uid}&part=${file.part}&inboxId=${inbox.id}`;
    const res = await ayse.fetch(url);
    expect(await res.text()).toBe('hata kaydı');
    expect((await outsider.fetch(url)).status).toBe(404);
  });

  it('removes the inbox with its conversations', async () => {
    await withMailbox(gm, MAILBOXES.destek, async () => undefined);
    await expect(
      ayse.api.call('mailDeleteInbox', { params: { inboxId: inbox.id } }),
    ).rejects.toMatchObject({ status: 403 });
    await owner.api.call('mailDeleteInbox', { params: { inboxId: inbox.id } });
    expect((await ayse.api.call('mailInboxes')).items).toEqual([]);
    expect(await app.deps.db.select().from(mailConversations)).toEqual([]);
  });

  it('stops while the module is off', async () => {
    await owner.api.call('updateOrg', { body: { settings: { modules: { mail: false } } } });
    await expect(ayse.api.call('mailInboxes')).rejects.toMatchObject({
      status: 403,
      code: 'module_disabled',
    });
    await owner.api.call('updateOrg', { body: { settings: { modules: { mail: true } } } });
  });
});
