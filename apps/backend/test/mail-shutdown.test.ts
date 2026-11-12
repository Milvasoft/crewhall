import MailComposer from 'nodemailer/lib/mail-composer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mailHeaders } from '@crewhall/db';
import { closeAllMailConnections } from '../src/services/mail/imap';
import { liveCount } from '../src/services/mail/live';
import { INITIAL_SYNC_MAX } from '../src/services/mail/sync';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';
import { MAILBOXES, deliver, startGreenMail, withMailbox, type GreenMail } from './mail-containers';

/**
 * The background mail watchers write to the database from IDLE events and long syncs. Closing
 * the app (SIGTERM, a test's afterAll) must stop them before the pool ends: no write may land
 * on a closed pool, and nothing may keep running afterwards.
 */
describe('mail shutdown', () => {
  let gm: GreenMail;
  let app: TestApp;
  let elif: Client;
  let closed = false;
  const failures: unknown[] = [];
  const onRejection = (reason: unknown) => failures.push(reason);

  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const rows = async () => (await app.deps.db.select().from(mailHeaders)).length;

  beforeAll(async () => {
    process.on('unhandledRejection', onRejection);
    [gm, app] = await Promise.all([startGreenMail(), createTestApp()]);
    const { owner } = await setupWithOwner(app);
    ({ person: elif } = await join(app, owner, 'elif@milvasoft.com', 'member'));
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
    process.off('unhandledRejection', onRejection);
    if (!closed) await app?.close();
    await gm?.container.stop();
  });

  it('stops a long first sync between chunks and writes nothing after', async () => {
    await withMailbox(gm, MAILBOXES.elif, async (c) => {
      for (let i = 1; i <= INITIAL_SYNC_MAX + 600; i++) {
        const raw = await new MailComposer({
          from: 'a@example.com',
          to: MAILBOXES.elif.address,
          subject: `Toplu ${i}`,
          text: 'x',
        })
          .compile()
          .build();
        await c.append('INBOX', raw);
      }
    });
    // Too big for the request: the background starts the first sync.
    await elif.api.call('mailMessages', { query: { folder: 'INBOX', limit: 10 } });
    for (let i = 0; i < 100 && (await rows()) === 0; i++) await pause(50);
    expect(await rows()).toBeGreaterThan(0);

    const started = Date.now();
    await closeAllMailConnections();
    expect(Date.now() - started).toBeLessThan(6_000);
    expect(liveCount()).toBe(0);
    const after = await rows();
    await pause(1_500);
    expect(await rows()).toBe(after);
    expect(after).toBeLessThan(INITIAL_SYNC_MAX + 600);
  });

  it('closes the app while IDLE reports a flag change, without writing to the ended pool', async () => {
    await deliver(gm, {
      from: 'b@example.com',
      to: MAILBOXES.elif.address,
      subject: 'Kapanış',
      text: 'x',
    });
    // Start the watcher and let it sit in IDLE on INBOX.
    await elif.api.call('mailFolders');
    await pause(1_500);
    expect(liveCount()).toBe(1);
    // Another device marks every message read: a burst of FLAGS updates on the watcher…
    await withMailbox(gm, MAILBOXES.elif, async (c) => {
      const lock = await c.getMailboxLock('INBOX');
      try {
        await c.messageFlagsAdd('1:*', ['\\Seen']);
      } finally {
        lock.release();
      }
    });
    // …and the app closes right then (what SIGTERM does).
    await app.close();
    closed = true;
    expect(liveCount()).toBe(0);
    // Late callbacks would land on the ended pool now: give them the chance to fail.
    await pause(2_000);
    expect(failures).toEqual([]);
  });
});
