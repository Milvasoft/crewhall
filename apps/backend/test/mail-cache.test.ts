import { and, eq } from 'drizzle-orm';
import { ImapFlow } from 'imapflow';
import MailComposer from 'nodemailer/lib/mail-composer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mailFolderState, mailHeaders } from '@crewhall/db';
import type { WsServerEvent } from '@crewhall/shared';
import { userTopic } from '../src/realtime/bus';
import { clearBodies } from '../src/services/mail/body';
import { closeAllMailConnections } from '../src/services/mail/imap';
import { settleLive } from '../src/services/mail/live';
import { INITIAL_SYNC_MAX } from '../src/services/mail/sync';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';
import { MAILBOXES, deliver, startGreenMail, withMailbox, type GreenMail } from './mail-containers';

/** Header cache, folder sync and IDLE push against GreenMail. */
describe('mail cache and sync', () => {
  let gm: GreenMail;
  let app: TestApp;
  let elif: Client;
  let elifId: string;
  const events: WsServerEvent[] = [];

  const raw = (i: number, extra: Record<string, unknown> = {}) =>
    new MailComposer({
      from: `Gönderen <g${i}@example.com>`,
      to: MAILBOXES.elif.address,
      subject: `Toplu ${i}`,
      text: `Gövde ${i}`,
      date: new Date(Date.now() - (10_000 - i) * 1000),
      ...extra,
    })
      .compile()
      .build();

  beforeAll(async () => {
    [gm, app] = await Promise.all([startGreenMail(), createTestApp()]);
    const { owner } = await setupWithOwner(app);
    const joined = await join(app, owner, 'elif@milvasoft.com', 'member');
    elif = joined.person;
    elifId = joined.me.user.id;
    app.deps.bus.subscribe(userTopic(elifId), (e) => events.push(e));
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
    await elif.api.call('mailConnectAccount', {
      body: { email: MAILBOXES.elif.address, password: MAILBOXES.elif.password },
    });
  });

  afterAll(async () => {
    await closeAllMailConnections();
    await app?.close();
    await gm?.container.stop();
  });

  const cachedCount = async (folder: string) =>
    (
      await app.deps.db
        .select()
        .from(mailHeaders)
        .where(and(eq(mailHeaders.folder, folder)))
    ).length;

  it('builds a large folder in the background and pages it from the cache', async () => {
    const n = INITIAL_SYNC_MAX + 60;
    await withMailbox(gm, MAILBOXES.elif, async (c) => {
      for (let i = 1; i <= n; i++) await c.append('INBOX', await raw(i));
    });
    // Too big for the request: answered live, newest first, while the cache builds.
    const live = await elif.api.call('mailMessages', { query: { folder: 'INBOX', limit: 50 } });
    expect(live.items.map((m) => m.subject).slice(0, 2)).toEqual([`Toplu ${n}`, `Toplu ${n - 1}`]);
    expect(live.nextCursor).not.toBeNull();
    await settleLive();
    const [state] = await app.deps.db
      .select()
      .from(mailFolderState)
      .where(eq(mailFolderState.folder, 'INBOX'));
    expect(state).toMatchObject({ complete: true });
    expect(await cachedCount('INBOX')).toBe(n);

    const page1 = await elif.api.call('mailMessages', { query: { folder: 'INBOX', limit: 50 } });
    expect(page1.items.map((m) => m.uid)).toEqual(live.items.map((m) => m.uid));
    const page2 = await elif.api.call('mailMessages', {
      query: { folder: 'INBOX', limit: 50, cursor: page1.nextCursor! },
    });
    expect(page2.items[0]!.subject).toBe(`Toplu ${n - 50}`);
    const unread = await elif.api.call('mailMessages', {
      query: { folder: 'INBOX', limit: 5, unread: 'true' },
    });
    expect(unread.items).toHaveLength(5);
  });

  it('sees new, changed and removed mail from other devices', async () => {
    const before = await elif.api.call('mailMessages', { query: { folder: 'INBOX', limit: 3 } });
    const newest = before.items[0]!;
    await withMailbox(gm, MAILBOXES.elif, async (c) => {
      const lock = await c.getMailboxLock('INBOX');
      try {
        await c.messageFlagsAdd([newest.uid], ['\\Seen', '\\Flagged'], { uid: true });
        await c.messageDelete([before.items[1]!.uid], { uid: true });
      } finally {
        lock.release();
      }
    });
    await deliver(gm, {
      from: 'Yeni <yeni@example.com>',
      to: MAILBOXES.elif.address,
      subject: 'Başka cihazdan sonra gelen',
      text: 'x',
    });
    // The next read asks the server (STATUS); what it does not wait for finishes right after.
    await elif.api.call('mailMessages', { query: { folder: 'INBOX', limit: 3 } });
    await settleLive();
    const after = await elif.api.call('mailMessages', { query: { folder: 'INBOX', limit: 3 } });
    expect(after.items[0]!.subject).toBe('Başka cihazdan sonra gelen');
    expect(after.items.map((m) => m.uid)).not.toContain(before.items[1]!.uid);
    // Flags of old messages: CONDSTORE right away, otherwise the background refresh.
    await settleLive();
    await app.deps.db
      .update(mailFolderState)
      .set({ flagsSyncedAt: new Date(0) })
      .where(eq(mailFolderState.folder, 'INBOX'));
    await elif.api.call('mailMessages', { query: { folder: 'INBOX', limit: 3 } });
    await settleLive();
    const flagged = await elif.api.call('mailMessages', {
      query: { folder: 'INBOX', flagged: 'true' },
    });
    expect(flagged.items.map((m) => m.uid)).toEqual([newest.uid]);
    expect(flagged.items[0]!.seen).toBe(true);
  });

  it('pushes mail.changed when new mail arrives (IDLE on INBOX)', async () => {
    events.length = 0;
    await elif.api.call('mailFolders');
    // Give the background connection a moment to sit in IDLE.
    await new Promise((r) => setTimeout(r, 1500));
    await deliver(gm, {
      from: 'Anlık <anlik@example.com>',
      to: MAILBOXES.elif.address,
      subject: 'Anlık bildirim',
      text: 'x',
    });
    for (let i = 0; i < 50 && !events.some((e) => e.type === 'mail.changed'); i++) {
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(events).toContainEqual({ type: 'mail.changed', folder: 'INBOX' });
    await settleLive();
    const [row] = await app.deps.db
      .select()
      .from(mailHeaders)
      .where(eq(mailHeaders.subject, 'Anlık bildirim'));
    expect(row).toBeDefined();
  });

  it('answers from the cache when the server is slow, and tells the client later', async () => {
    await settleLive();
    await deliver(gm, {
      from: 'Geç <gec@example.com>',
      to: MAILBOXES.elif.address,
      subject: 'Yavaş sunucudan',
      text: 'x',
    });
    events.length = 0;
    const realStatus = ImapFlow.prototype.status;
    const slow = vi.spyOn(ImapFlow.prototype, 'status').mockImplementation(async function (
      this: ImapFlow,
      ...args
    ) {
      await new Promise((r) => setTimeout(r, 700));
      return realStatus.apply(this, args);
    });
    try {
      const t0 = Date.now();
      const page = await elif.api.call('mailMessages', { query: { folder: 'INBOX', limit: 5 } });
      expect(Date.now() - t0).toBeLessThan(600);
      expect(page.items.map((m) => m.subject)).not.toContain('Yavaş sunucudan');
      // The check finishes in the background and the client hears about it.
      for (let i = 0; i < 50 && !events.some((e) => e.type === 'mail.changed'); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(events).toContainEqual({ type: 'mail.changed', folder: 'INBOX' });
    } finally {
      slow.mockRestore();
    }
    await settleLive();
    const after = await elif.api.call('mailMessages', { query: { folder: 'INBOX', limit: 5 } });
    expect(after.items[0]!.subject).toBe('Yavaş sunucudan');
  });

  it('opens a prefetched message without touching IMAP', async () => {
    clearBodies();
    const page = await elif.api.call('mailMessages', { query: { folder: 'INBOX', limit: 5 } });
    await settleLive();
    // A break: the pooled connection is gone. The newest bodies were fetched ahead.
    await closeAllMailConnections();
    const t0 = Date.now();
    const res = await elif.fetch(
      `http://localhost:3000/api/v1/mail/thread?folder=INBOX&uid=${page.items[0]!.uid}&markSeen=false`,
    );
    expect(Date.now() - t0).toBeLessThan(300);
    const thread = (await res.json()) as { items: { subject: string }[] };
    expect(thread.items.at(-1)!.subject).toBe(page.items[0]!.subject);
    // Server-Timing tells the request waited for no connection and sent no IMAP command.
    const timing = res.headers.get('server-timing') ?? '';
    expect(timing).toMatch(/total;dur=/);
    expect(timing).not.toMatch(/connect|imap/);
  });

  it('opens a message from the text parts only, decoded, and caches the body', async () => {
    await withMailbox(gm, MAILBOXES.elif, async (c) => {
      await c.append(
        'INBOX',
        await raw(99_999, {
          subject: 'Kodlama',
          html: '<p>Çağrı şöyle dedi: “ığüşöç”</p><img src="cid:logo@x">',
          text: 'Çağrı şöyle dedi',
          textEncoding: 'quoted-printable',
          attachments: [
            { filename: 'buyuk.bin', content: Buffer.alloc(400 * 1024, 1) },
            {
              filename: 'logo.png',
              cid: 'logo@x',
              contentType: 'image/png',
              content: Buffer.from(
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
                'base64',
              ),
            },
          ],
        }),
      );
    });
    const list = await elif.api.call('mailMessages', { query: { q: 'Kodlama' } });
    const uid = list.items[0]!.uid;
    clearBodies();
    const thread = await elif.api.call('mailThread', { query: { folder: 'INBOX', uid } });
    const msg = thread.items[0]!;
    expect(msg.html).toContain('Çağrı şöyle dedi: “ığüşöç”');
    expect(msg.html).toContain('data:image/png;base64,');
    expect(msg.text).toBe('Çağrı şöyle dedi');
    expect(msg.attachments.find((a) => a.filename === 'buyuk.bin')).toMatchObject({
      inline: false,
    });
    expect(msg.attachments.find((a) => a.filename === 'logo.png')?.inline).toBe(true);
    // The 400 KB attachment downloads only when asked, still decoded.
    const file = msg.attachments.find((a) => a.filename === 'buyuk.bin')!;
    const res = await elif.fetch(
      `http://localhost:3000/api/mail/attachment?folder=INBOX&uid=${uid}&part=${file.part}`,
    );
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.alloc(400 * 1024, 1))).toBe(true);
  });

  it('keeps the cache right after its own changes', async () => {
    const page = await elif.api.call('mailMessages', { query: { folder: 'INBOX', limit: 2 } });
    const [a, b] = page.items;
    await elif.api.call('mailUpdateFlags', {
      body: { folder: 'INBOX', uids: [a!.uid], seen: false, flagged: true },
    });
    const [row] = await app.deps.db
      .select()
      .from(mailHeaders)
      .where(and(eq(mailHeaders.folder, 'INBOX'), eq(mailHeaders.uid, a!.uid)));
    expect(row).toMatchObject({ seen: false, flagged: true });
    await elif.api.call('mailDeleteMessages', { body: { folder: 'INBOX', uids: [b!.uid] } });
    const [gone] = await app.deps.db
      .select()
      .from(mailHeaders)
      .where(and(eq(mailHeaders.folder, 'INBOX'), eq(mailHeaders.uid, b!.uid)));
    expect(gone).toBeUndefined();
    const folders = await elif.api.call('mailFolders');
    expect(folders.items.find((f) => f.specialUse === 'trash' || f.path === 'Trash')?.total).toBe(
      1,
    );
  });
});
