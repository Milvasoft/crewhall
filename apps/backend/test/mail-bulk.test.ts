import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mailBulkJobs } from '@crewhall/db';
import { closeAllMailConnections } from '../src/services/mail/imap';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';
import { MAILBOXES, deliver, startGreenMail, withMailbox, type GreenMail } from './mail-containers';

describe('mail bulk jobs (GreenMail)', () => {
  let gm: GreenMail;
  let app: TestApp;
  let owner: Client;
  let elif: Client;

  const countIn = (folder: string) =>
    withMailbox(gm, MAILBOXES.elif, async (c) => {
      const s = await c.status(folder, { unseen: true, messages: true });
      return { unread: s ? (s.unseen ?? 0) : 0, total: s ? (s.messages ?? 0) : 0 };
    });

  beforeAll(async () => {
    [gm, app] = await Promise.all([startGreenMail(), createTestApp()]);
    ({ owner } = await setupWithOwner(app));
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
    for (let i = 1; i <= 7; i++) {
      await deliver(gm, {
        from: 'Bülten <news@example.com>',
        to: MAILBOXES.elif.address,
        subject: `Duyuru ${i}`,
        text: `Gövde ${i}`,
      });
    }
  });

  afterAll(async () => {
    await closeAllMailConnections();
    await app?.close();
    await gm?.container.stop();
  });

  it('marks a whole folder read and unread with progress', async () => {
    expect(await countIn('INBOX')).toEqual({ unread: 7, total: 7 });
    const job = await elif.api.call('mailStartBulk', {
      body: { folder: 'INBOX', action: 'seen' },
      idempotencyKey: 'bulk-seen-1',
    });
    expect(job).toMatchObject({ status: 'done', total: 7, done: 7, error: null });
    expect(await countIn('INBOX')).toEqual({ unread: 0, total: 7 });
    const folders = await elif.api.call('mailFolders');
    expect(folders.items.find((f) => f.path === 'INBOX')?.unread).toBe(0);

    // Nothing left to change: the second run counts 0.
    const again = await elif.api.call('mailStartBulk', {
      body: { folder: 'INBOX', action: 'seen' },
    });
    expect(again).toMatchObject({ status: 'done', total: 0, done: 0 });

    const unseen = await elif.api.call('mailStartBulk', {
      body: { folder: 'INBOX', action: 'unseen' },
    });
    expect(unseen).toMatchObject({ status: 'done', total: 7 });
    expect(await countIn('INBOX')).toEqual({ unread: 7, total: 7 });
    expect(await elif.api.call('mailBulkJob', { params: { jobId: job.id } })).toMatchObject({
      id: job.id,
      status: 'done',
    });
  });

  it('keeps jobs private and replays an idempotent start', async () => {
    const replay = await elif.api.call('mailStartBulk', {
      body: { folder: 'INBOX', action: 'seen' },
      idempotencyKey: 'bulk-seen-1',
    });
    const [first] = await app.deps.db
      .select()
      .from(mailBulkJobs)
      .where(eq(mailBulkJobs.id, replay.id));
    expect(first).toBeDefined();
    expect(await app.deps.db.select().from(mailBulkJobs)).toHaveLength(3);
    await expect(
      owner.api.call('mailBulkJob', { params: { jobId: replay.id } }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('moves and deletes a whole folder', async () => {
    await withMailbox(gm, MAILBOXES.elif, (c) => c.mailboxCreate('Arsiv'));
    const moved = await elif.api.call('mailStartBulk', {
      body: { folder: 'INBOX', action: 'move', target: 'Arsiv' },
    });
    expect(moved).toMatchObject({ status: 'done', total: 7, done: 7 });
    expect((await countIn('INBOX')).total).toBe(0);
    expect((await countIn('Arsiv')).total).toBe(7);

    const deleted = await elif.api.call('mailStartBulk', {
      body: { folder: 'Arsiv', action: 'delete' },
    });
    expect(deleted).toMatchObject({ status: 'done', total: 7 });
    expect((await countIn('Trash')).total).toBe(7);
    const purged = await elif.api.call('mailStartBulk', {
      body: { folder: 'Trash', action: 'delete' },
    });
    expect(purged).toMatchObject({ status: 'done', total: 7 });
    expect((await countIn('Trash')).total).toBe(0);
  });

  it('fails with the error code for a missing folder or target', async () => {
    const missing = await elif.api.call('mailStartBulk', {
      body: { folder: 'Yok', action: 'seen' },
    });
    expect(missing).toMatchObject({ status: 'failed', error: 'mail_folder_not_found' });
    const target = await elif.api.call('mailStartBulk', {
      body: { folder: 'INBOX', action: 'move', target: 'Yok' },
    });
    expect(target).toMatchObject({ status: 'failed', error: 'mail_folder_not_found' });
    await expect(
      elif.api.call('mailStartBulk', { body: { folder: 'INBOX', action: 'move' } }),
    ).rejects.toMatchObject({ status: 422 });
    const [row] = await app.deps.db
      .select()
      .from(mailBulkJobs)
      .where(eq(mailBulkJobs.id, missing.id));
    expect(row!.finishedAt).not.toBeNull();
  });

  it('stops while the module is off', async () => {
    await owner.api.call('updateOrg', { body: { settings: { modules: { mail: false } } } });
    await expect(
      elif.api.call('mailStartBulk', { body: { folder: 'INBOX', action: 'seen' } }),
    ).rejects.toMatchObject({ status: 403, code: 'module_disabled' });
    await owner.api.call('updateOrg', { body: { settings: { modules: { mail: true } } } });
  });
});
