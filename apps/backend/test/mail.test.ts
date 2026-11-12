import { simpleParser } from 'mailparser';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLogs, mailAccounts, nodes, notifications } from '@crewhall/db';
import { sealSecret } from '../src/services/mail/crypto';
import { closeAllMailConnections } from '../src/services/mail/imap';
import { checkMailboxes } from '../src/services/mail/poll';
import { Client, join, setupWithOwner, uploadFile, type TestApp, createTestApp } from './helpers';
import { MAILBOXES, deliver, startGreenMail, withMailbox, type GreenMail } from './mail-containers';

/** 1x1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('mail module (IMAP/SMTP against GreenMail)', () => {
  let gm: GreenMail;
  let app: TestApp;
  let owner: Client;
  let orgId: string;
  let elif: Client;
  let elifId: string;
  let guest: Client;

  const settings = () => ({
    imapHost: gm.host,
    imapPort: gm.imapPort,
    imapSecurity: 'none' as const,
    smtpHost: gm.host,
    smtpPort: gm.smtpPort,
    smtpSecurity: 'none' as const,
    authMode: 'password' as const,
    usernameFormat: 'email' as const,
    saveSentCopy: true,
    allowRemoteImages: true,
    pollMinutes: 1,
  });

  beforeAll(async () => {
    [gm, app] = await Promise.all([startGreenMail(), createTestApp()]);
    ({ owner, orgId } = await setupWithOwner(app));
    const joined = await join(app, owner, 'elif@milvasoft.com', 'member');
    elif = joined.person;
    elifId = joined.me.user.id;
    ({ person: guest } = await join(app, owner, 'misafir@example.com', 'guest'));
  });

  afterAll(async () => {
    await closeAllMailConnections();
    await app?.close();
    await gm?.container.stop();
  });

  it('starts unconfigured and keeps guests and members out of the admin settings', async () => {
    const state = await elif.api.call('mailAccount');
    expect(state.server.configured).toBe(false);
    expect(state.account).toBeNull();
    await expect(elif.api.call('mailFolders')).rejects.toMatchObject({
      status: 409,
      code: 'mail_not_configured',
    });
    await expect(elif.api.call('mailServerSettings')).rejects.toMatchObject({ status: 403 });
    await expect(guest.api.call('mailAccount')).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    });
  });

  it('tests the servers from the admin form', async () => {
    const base = settings();
    const good = await owner.api.call('mailTestServer', {
      body: { ...base, username: MAILBOXES.elif.address, password: MAILBOXES.elif.password },
    });
    expect(good.imap).toMatchObject({ ok: true });
    expect(good.smtp).toMatchObject({ ok: true });

    const greeting = await owner.api.call('mailTestServer', { body: base });
    expect(greeting.imap.ok).toBe(true);

    const wrong = await owner.api.call('mailTestServer', {
      body: { ...base, username: MAILBOXES.elif.address, password: 'nope' },
    });
    expect(wrong.imap).toMatchObject({ ok: false, error: 'mail_auth_failed' });

    const closed = await owner.api.call('mailTestServer', {
      body: { ...base, imapHost: '127.0.0.1', imapPort: 1, smtpHost: '127.0.0.1', smtpPort: 1 },
    });
    expect(closed.imap).toMatchObject({ ok: false, error: 'mail_server_unreachable' });
    expect(closed.smtp).toMatchObject({ ok: false, error: 'mail_server_unreachable' });
  });

  it('saves the server settings (admins only, audited)', async () => {
    await expect(
      elif.api.call('mailUpdateServerSettings', { body: settings() }),
    ).rejects.toMatchObject({ status: 403 });
    const saved = await owner.api.call('mailUpdateServerSettings', { body: settings() });
    expect(saved).toMatchObject({ configured: true, imapHost: gm.host, authMode: 'password' });
    expect(saved.oauthRedirectUri).toBe('http://localhost:3000/api/mail/oauth/callback');
    const rows = await app.deps.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'mail.settings.update'));
    expect(rows).toHaveLength(1);
  });

  it('connects a mailbox with an app password and stores it encrypted', async () => {
    await expect(
      elif.api.call('mailConnectAccount', {
        body: { email: MAILBOXES.elif.address, password: 'wrong' },
      }),
    ).rejects.toMatchObject({ status: 422, code: 'mail_auth_failed' });

    const account = await elif.api.call('mailConnectAccount', {
      body: { email: MAILBOXES.elif.address, password: MAILBOXES.elif.password },
    });
    expect(account).toMatchObject({
      email: MAILBOXES.elif.address,
      username: MAILBOXES.elif.address,
      status: 'ok',
      authMode: 'password',
    });
    expect(JSON.stringify(account)).not.toContain(MAILBOXES.elif.password);
    const [row] = await app.deps.db
      .select()
      .from(mailAccounts)
      .where(eq(mailAccounts.userId, elifId));
    expect(row!.passwordEnc).toMatch(/^v1\./);
    expect(row!.passwordEnc).not.toContain(MAILBOXES.elif.password);
  });

  it('lists folders and messages, pages and searches them', async () => {
    for (const n of [1, 2, 3]) {
      await deliver(gm, {
        from: 'Deniz <deniz@crewhall.test>',
        to: MAILBOXES.elif.address,
        subject: `Haftalık rapor ${n}`,
        text: `Rapor gövdesi ${n}`,
      });
    }
    const folders = await elif.api.call('mailFolders');
    const inbox = folders.items.find((f) => f.specialUse === 'inbox');
    expect(inbox).toMatchObject({ path: 'INBOX', total: 3, unread: 3 });

    const first = await elif.api.call('mailMessages', { query: { folder: 'INBOX', limit: 2 } });
    expect(first.items.map((m) => m.subject)).toEqual(['Haftalık rapor 3', 'Haftalık rapor 2']);
    expect(first.items[0]).toMatchObject({
      seen: false,
      from: { address: 'deniz@crewhall.test', name: 'Deniz' },
    });
    expect(first.nextCursor).not.toBeNull();
    const second = await elif.api.call('mailMessages', {
      query: { folder: 'INBOX', limit: 2, cursor: first.nextCursor! },
    });
    expect(second.items.map((m) => m.subject)).toEqual(['Haftalık rapor 1']);
    expect(second.nextCursor).toBeNull();

    const found = await elif.api.call('mailMessages', { query: { q: 'rapor 2' } });
    expect(found.items.map((m) => m.subject)).toEqual(['Haftalık rapor 2']);

    await expect(elif.api.call('mailMessages', { query: { folder: 'Yok' } })).rejects.toMatchObject(
      { status: 404, code: 'mail_folder_not_found' },
    );
  });

  it('shows HTML mail safely: no scripts, remote images off, inline images embedded', async () => {
    await deliver(gm, {
      from: 'Bülten <news@example.com>',
      to: MAILBOXES.elif.address,
      subject: 'Bülten',
      html: [
        '<p onclick="steal()">Merhaba <b>Elif</b></p>',
        '<script>alert(1)</script>',
        '<img src="https://tracker.example.com/pixel.gif" onerror="steal()">',
        '<img src="cid:logo@crewhall">',
        '<a href="javascript:alert(1)">tıkla</a>',
        '<a href="https://crewhall.example/">site</a>',
        '<iframe src="https://evil.example"></iframe>',
        '<div style="background:url(https://tracker.example.com/bg.png)">x</div>',
        '<form action="https://evil.example"><input name="p"></form>',
      ].join(''),
      attachments: [
        { filename: 'logo.png', content: PNG, cid: 'logo@crewhall', contentType: 'image/png' },
        { filename: 'teklif.txt', content: 'Teklif metni', contentType: 'text/plain' },
      ],
    });
    const list = await elif.api.call('mailMessages', { query: { q: 'Bülten' } });
    const summary = list.items[0]!;
    expect(summary.hasAttachments).toBe(true);

    const msg = await elif.api.call('mailMessage', {
      query: { folder: 'INBOX', uid: summary.uid },
    });
    expect(msg.seen).toBe(true);
    expect(msg.html).toContain('<b>Elif</b>');
    expect(msg.html).not.toMatch(/script|onclick|onerror|javascript:|iframe|<form|<input/i);
    expect(msg.html).not.toContain('tracker.example.com');
    expect(msg.html).toContain('data:image/png;base64,');
    expect(msg.html).toContain('rel="noopener noreferrer nofollow"');
    expect(msg.blockedImages).toBe(2);
    const file = msg.attachments.find((a) => a.filename === 'teklif.txt');
    expect(file).toMatchObject({ inline: false, contentType: 'text/plain' });
    expect(msg.attachments.find((a) => a.filename === 'logo.png')?.inline).toBe(true);

    const withImages = await elif.api.call('mailMessage', {
      query: { folder: 'INBOX', uid: summary.uid, remoteImages: 'true' },
    });
    expect(withImages.html).toContain('https://tracker.example.com/pixel.gif');
    expect(withImages.blockedImages).toBe(0);

    // Download through the raw route.
    const res = await elif.fetch(
      `http://localhost:3000/api/mail/attachment?folder=INBOX&uid=${summary.uid}&part=${file!.part}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toContain('teklif.txt');
    expect(await res.text()).toBe('Teklif metni');

    // Save it to Drive: the personal space, "E-posta ekleri".
    const saved = await elif.api.call('mailSaveAttachment', {
      body: { folder: 'INBOX', uid: summary.uid, part: file!.part },
    });
    expect(saved.name).toBe('teklif.txt');
    const [node] = await app.deps.db.select().from(nodes).where(eq(nodes.id, saved.nodeId));
    expect(node).toMatchObject({ type: 'file', sizeBytes: 'Teklif metni'.length });
    const [folder] = await app.deps.db.select().from(nodes).where(eq(nodes.id, node!.parentId!));
    expect(folder!.name).toBe('E-posta ekleri');
  });

  it('refuses remote images when the org turned them off', async () => {
    await owner.api.call('mailUpdateServerSettings', {
      body: { ...settings(), allowRemoteImages: false },
    });
    const list = await elif.api.call('mailMessages', { query: { q: 'Bülten' } });
    await expect(
      elif.api.call('mailMessage', {
        query: { folder: 'INBOX', uid: list.items[0]!.uid, remoteImages: 'true' },
      }),
    ).rejects.toMatchObject({ status: 403, code: 'mail_remote_images_disabled' });
    await owner.api.call('mailUpdateServerSettings', { body: settings() });
  });

  it('sends with Drive and local attachments, keeps a Sent copy and threads replies', async () => {
    const spaces = await elif.api.call('listSpaces');
    const personal = spaces.items.find((s) => s.kind === 'personal')!;
    const driveFile = await uploadFile(elif, {
      spaceId: personal.id,
      name: 'butce.csv',
      content: Buffer.from('kalem,tutar\nsunucu,100\n'),
      mime: 'text/csv',
    });

    const sent = await elif.api.call('mailSend', {
      body: {
        to: [{ name: 'Deniz', address: MAILBOXES.deniz.address }],
        subject: 'Bütçe',
        html: '<p>Merhaba Deniz,</p><p>Bütçe ekte.</p><script>x()</script>',
        attachments: [
          { kind: 'drive', nodeId: driveFile.node.id },
          {
            kind: 'upload',
            filename: 'not.txt',
            contentType: 'text/plain',
            data: Buffer.from('yerel dosya').toString('base64'),
          },
        ],
      },
    });
    expect(sent.savedToSent).toBe(true);

    const got = await withMailbox(gm, MAILBOXES.deniz, async (c) => {
      const lock = await c.getMailboxLock('INBOX');
      try {
        const m = await c.fetchOne('*', { source: true });
        return simpleParser(m ? m.source! : Buffer.alloc(0));
      } finally {
        lock.release();
      }
    });
    expect(got.subject).toBe('Bütçe');
    expect(got.from?.value[0]).toMatchObject({ address: MAILBOXES.elif.address });
    expect(got.html).toContain('Bütçe ekte.');
    expect(got.html).not.toContain('script');
    expect(got.text).toContain('Bütçe ekte.');
    expect(got.attachments.map((a) => a.filename).sort()).toEqual(['butce.csv', 'not.txt']);
    expect(got.messageId).toBe(sent.messageId);

    const folders = await elif.api.call('mailFolders');
    const sentFolder = folders.items.find((f) => f.specialUse === 'sent' || f.path === 'Sent')!;
    const sentList = await elif.api.call('mailMessages', { query: { folder: sentFolder.path } });
    expect(sentList.items[0]).toMatchObject({ subject: 'Bütçe', seen: true });

    // Deniz answers; Elif replies to that answer from Crewhall.
    await deliver(gm, {
      from: MAILBOXES.deniz.address,
      to: MAILBOXES.elif.address,
      subject: 'Re: Bütçe',
      text: 'Teşekkürler, inceliyorum.',
      inReplyTo: sent.messageId,
      references: [sent.messageId],
    });
    const inbox = await elif.api.call('mailMessages', { query: { q: 'inceliyorum' } });
    const answer = inbox.items[0]!;
    expect(answer.threadId).toBe(sent.messageId.toLowerCase());

    const reply = await elif.api.call('mailSend', {
      body: {
        to: [{ address: MAILBOXES.deniz.address }],
        subject: 'Re: Bütçe',
        html: '<p>Tamam.</p>',
        source: { folder: 'INBOX', uid: answer.uid, mode: 'reply' },
      },
    });
    const replied = await withMailbox(gm, MAILBOXES.deniz, async (c) => {
      const lock = await c.getMailboxLock('INBOX');
      try {
        const m = await c.fetchOne('*', { source: true });
        return simpleParser(m ? m.source! : Buffer.alloc(0));
      } finally {
        lock.release();
      }
    });
    expect(replied.messageId).toBe(reply.messageId);
    expect(replied.inReplyTo).toBeTruthy();
    expect(String(replied.references)).toContain(sent.messageId);

    const original = await elif.api.call('mailMessages', { query: { q: 'inceliyorum' } });
    expect(original.items[0]!.answered).toBe(true);

    const thread = await elif.api.call('mailThread', {
      query: { folder: 'INBOX', uid: answer.uid },
    });
    expect(thread.items.map((m) => m.subject)).toEqual(['Bütçe', 'Re: Bütçe', 'Re: Bütçe']);
    expect(thread.items.map((m) => m.folder)).toEqual([sentFolder.path, 'INBOX', sentFolder.path]);

    const suggestions = await elif.api.call('mailRecipients', { query: { q: 'deniz' } });
    expect(suggestions.items[0]).toMatchObject({
      address: MAILBOXES.deniz.address,
      source: 'recent',
    });
    const people = await elif.api.call('mailRecipients', { query: { q: 'bugra' } });
    expect(people.items[0]).toMatchObject({ address: 'bugra@milvasoft.com', source: 'member' });
  });

  it('suggests external contacts from the contacts module', async () => {
    await elif.api.call('createContact', {
      body: {
        displayName: 'İnci Tedarik',
        emails: [{ type: 'work', value: 'satis@inci-tedarik.example' }],
      },
    });
    const found = await elif.api.call('mailRecipients', { query: { q: 'inci' } });
    expect(found.items).toContainEqual({
      name: 'İnci Tedarik',
      address: 'satis@inci-tedarik.example',
      source: 'contact',
    });
  });

  it('refuses a message without recipients', async () => {
    await expect(
      elif.api.call('mailSend', { body: { subject: 'x', html: '<p>x</p>' } }),
    ).rejects.toMatchObject({ status: 422, code: 'mail_recipients_required' });
  });

  it('flags, moves and deletes (Trash first, then for good)', async () => {
    const list = await elif.api.call('mailMessages', { query: { q: 'rapor 1' } });
    const uid = list.items[0]!.uid;
    await elif.api.call('mailUpdateFlags', {
      body: { folder: 'INBOX', uids: [uid], flagged: true, seen: true },
    });
    const flagged = await elif.api.call('mailMessages', { query: { flagged: 'true' } });
    expect(flagged.items.map((m) => m.uid)).toEqual([uid]);
    expect(flagged.items[0]!.seen).toBe(true);

    await withMailbox(gm, MAILBOXES.elif, (c) => c.mailboxCreate('Projeler'));
    await elif.api.call('mailMoveMessages', {
      body: { folder: 'INBOX', uids: [uid], target: 'Projeler' },
    });
    const moved = await elif.api.call('mailMessages', { query: { folder: 'Projeler' } });
    expect(moved.items.map((m) => m.subject)).toEqual(['Haftalık rapor 1']);
    await expect(
      elif.api.call('mailMoveMessages', {
        body: { folder: 'Projeler', uids: [moved.items[0]!.uid], target: 'Yok' },
      }),
    ).rejects.toMatchObject({ code: 'mail_folder_not_found' });

    const toTrash = await elif.api.call('mailDeleteMessages', {
      body: { folder: 'Projeler', uids: [moved.items[0]!.uid] },
    });
    expect(toTrash.permanent).toBe(false);
    const folders = await elif.api.call('mailFolders');
    const trash = folders.items.find((f) => f.specialUse === 'trash' || f.path === 'Trash')!;
    const inTrash = await elif.api.call('mailMessages', { query: { folder: trash.path } });
    expect(inTrash.items).toHaveLength(1);
    const gone = await elif.api.call('mailDeleteMessages', {
      body: { folder: trash.path, uids: [inTrash.items[0]!.uid] },
    });
    expect(gone.permanent).toBe(true);
    const empty = await elif.api.call('mailMessages', { query: { folder: trash.path } });
    expect(empty.items).toHaveLength(0);
  });

  it('notifies about new mail from the worker check', async () => {
    const jobDeps = { ...app.deps };
    // First check only sets the watermark.
    await app.deps.db.update(mailAccounts).set({ lastCheckedAt: null });
    expect(await checkMailboxes(jobDeps)).toBe(1);
    const none = await app.deps.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, elifId), eq(notifications.type, 'mail.new')));
    expect(none).toHaveLength(0);

    await deliver(gm, {
      from: 'Müşteri <musteri@example.com>',
      to: MAILBOXES.elif.address,
      subject: 'Acil: sipariş',
      text: 'Merhaba',
    });
    // Not due yet within the interval.
    expect(await checkMailboxes(jobDeps)).toBe(0);
    expect(await checkMailboxes(jobDeps, new Date(Date.now() + 61_000))).toBe(1);
    const rows = await app.deps.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, elifId), eq(notifications.type, 'mail.new')));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ title: 'Acil: sipariş', authorName: 'Müşteri' });
    expect(rows[0]!.url).toMatch(/^\/mail\?folder=INBOX&uid=\d+$/);
  });

  it('turns off with the module switch (endpoints and worker)', async () => {
    await owner.api.call('updateOrg', { body: { settings: { modules: { mail: false } } } });
    await expect(elif.api.call('mailFolders')).rejects.toMatchObject({
      status: 403,
      code: 'module_disabled',
    });
    await app.deps.db.update(mailAccounts).set({ lastCheckedAt: null });
    expect(await checkMailboxes({ ...app.deps })).toBe(0);
    await owner.api.call('updateOrg', { body: { settings: { modules: { mail: true } } } });
  });

  it('marks the account when the server stops accepting the password', async () => {
    const [row] = await app.deps.db
      .select()
      .from(mailAccounts)
      .where(eq(mailAccounts.userId, elifId));
    await closeAllMailConnections();
    // The password changed on the mail server: the stored one is refused by IMAP.
    await app.deps.db
      .update(mailAccounts)
      .set({ passwordEnc: sealSecret(app.env.AUTH_SECRET, 'old-password') })
      .where(eq(mailAccounts.id, row!.id));
    // A full-text search always asks the server (a folder list may come from the kept copy).
    await expect(
      elif.api.call('mailMessages', { query: { folder: 'INBOX', q: 'şifre' } }),
    ).rejects.toMatchObject({
      status: 422,
      code: 'mail_auth_failed',
    });
    expect((await elif.api.call('mailAccount')).account?.status).toBe('auth_failed');
    await elif.api.call('mailUpdateAccount', { body: { password: MAILBOXES.elif.password } });
    const state = await elif.api.call('mailAccount');
    expect(state.account?.status).toBe('ok');
  });

  it('keeps a sanitized signature and disconnects', async () => {
    const updated = await elif.api.call('mailUpdateAccount', {
      body: { signatureHtml: '<p>Elif <img src=x onerror=alert(1)></p>', displayName: 'Elif Y.' },
    });
    expect(updated.signatureHtml).not.toContain('onerror');
    expect(updated.displayName).toBe('Elif Y.');
    await elif.api.call('mailDisconnectAccount');
    const state = await elif.api.call('mailAccount');
    expect(state.account).toBeNull();
    expect(orgId).toBeTruthy();
  });
});
