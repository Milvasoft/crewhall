import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mailAccounts, mailFolderState } from '@crewhall/db';
import type { MailInbox } from '@crewhall/shared';
import { closeAllMailConnections } from '../src/services/mail/imap';
import { settleLive } from '../src/services/mail/live';
import { setOauthFetch } from '../src/services/mail/oauth';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';
import { MAILBOXES, deliver, startGreenMail, type GreenMail } from './mail-containers';

/**
 * A shared inbox in an org that signs in with Microsoft 365: no app password; a space admin
 * signs it in with their own account (Full Access to the shared mailbox in Exchange). GreenMail
 * checks an XOAUTH2 token like a password, so the fake Entra hands out the inbox's password.
 */
describe('shared inbox with Microsoft 365 sign-in', () => {
  let gm: GreenMail;
  let app: TestApp;
  let owner: Client;
  let ayse: Client;
  let spaceId: string;
  let inbox: MailInbox;
  const calls: URLSearchParams[] = [];

  const entra = async (_input: unknown, init?: RequestInit) => {
    const form = new URLSearchParams(String(init?.body));
    calls.push(form);
    if (form.get('grant_type') === 'authorization_code' && form.get('code') !== 'good-code') {
      return Response.json({ error: 'invalid_grant' }, { status: 400 });
    }
    return Response.json({
      access_token: MAILBOXES.destek.password,
      refresh_token: `refresh-${calls.length}`,
      expires_in: 3600,
    });
  };

  beforeAll(async () => {
    [gm, app] = await Promise.all([startGreenMail(), createTestApp()]);
    ({ owner } = await setupWithOwner(app));
    setOauthFetch(entra);
    await owner.api.call('mailUpdateServerSettings', {
      body: {
        imapHost: gm.host,
        imapPort: gm.imapPort,
        imapSecurity: 'none',
        smtpHost: gm.host,
        smtpPort: gm.smtpPort,
        smtpSecurity: 'none',
        authMode: 'oauth_microsoft',
        oauthClientId: 'entra-app-id',
        oauthClientSecret: 'entra-secret',
        oauthTenant: 'contoso.onmicrosoft.com',
      },
    });
    spaceId = (await owner.api.call('createSpace', { body: { name: 'Destek', color: 's3' } })).id;
    const a = await join(app, owner, 'ayse@milvasoft.com', 'member');
    ayse = a.person;
    await owner.api.call('addSpaceMember', {
      params: { spaceId },
      body: { userId: a.me.user.id, role: 'editor' },
    });
  });

  afterAll(async () => {
    setOauthFetch(null);
    await closeAllMailConnections();
    await app?.close();
    await gm?.container.stop();
  });

  const startUrl = () =>
    `http://localhost:3000/api/mail/inbox-oauth/start?inboxId=${encodeURIComponent(inbox.id)}`;
  const list = () =>
    ayse.api.call('mailInboxConversations', { params: { inboxId: inbox.id }, query: {} });

  it('adds the inbox without a password, waiting for a sign-in', async () => {
    inbox = await owner.api.call('mailCreateInbox', {
      body: { spaceId, name: 'Destek', email: MAILBOXES.destek.address },
    });
    expect(inbox).toMatchObject({ authMode: 'oauth_microsoft', needsSignIn: true });
    // Nothing to read before the sign-in, and no IMAP attempt that would fail.
    expect((await list()).items).toEqual([]);
  });

  it('lets only the space admins start the sign-in, then reads with XOAUTH2', async () => {
    const refused = await ayse.fetch(startUrl(), { redirect: 'manual' });
    expect(refused.status).toBe(403);
    const start = await owner.fetch(startUrl(), { redirect: 'manual' });
    expect(start.status).toBe(302);
    const url = new URL(start.headers.get('location')!);
    expect(url.origin + url.pathname).toBe(
      'https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/authorize',
    );
    expect(url.searchParams.get('scope')).toContain(
      'https://outlook.office.com/IMAP.AccessAsUser.All',
    );
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const state = url.searchParams.get('state')!;

    const done = await owner.fetch(
      `http://localhost:3000/api/mail/oauth/callback?code=good-code&state=${encodeURIComponent(state)}`,
      { redirect: 'manual' },
    );
    expect(done.headers.get('location')).toBe(
      `http://localhost:5173/mail/inbox/${inbox.id}?connected=1`,
    );
    const [view] = (await ayse.api.call('mailInboxes')).items;
    expect(view).toMatchObject({ id: inbox.id, needsSignIn: false, status: 'ok' });
    // The owner's own mailbox stays unconnected: the token belongs to the inbox.
    expect((await owner.api.call('mailAccount')).account).toBeNull();

    await deliver(gm, {
      from: 'Müşteri <musteri@example.com>',
      to: MAILBOXES.destek.address,
      subject: 'Sipariş durumu',
      text: 'Siparişim nerede?',
    });
    await list();
    await settleLive();
    expect((await list()).items.map((c) => c.subject)).toEqual(['Sipariş durumu']);
  });

  it('renews an expired token, and asks for a new sign-in when it is refused', async () => {
    const expire = () =>
      app.deps.db
        .update(mailAccounts)
        .set({ oauthExpiresAt: new Date(Date.now() - 1000) })
        .where(eq(mailAccounts.kind, 'shared'));
    await closeAllMailConnections();
    await expire();
    const before = calls.length;
    await list();
    await settleLive();
    expect(calls.slice(before).map((f) => f.get('grant_type'))).toContain('refresh_token');

    await closeAllMailConnections();
    await expire();
    setOauthFetch(async () => Response.json({ error: 'invalid_grant' }, { status: 400 }));
    try {
      await list().catch(() => undefined);
      await settleLive();
    } finally {
      setOauthFetch(entra);
    }
    const [view] = (await ayse.api.call('mailInboxes')).items;
    expect(view).toMatchObject({ needsSignIn: true, status: 'auth_failed' });
  });

  it('leaves no unhandled rejection when a renewal is refused during the state check', async () => {
    const shared = eq(mailAccounts.kind, 'shared');
    const status = async () =>
      (await app.deps.db.select().from(mailAccounts).where(shared))[0]?.status;
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);

    await closeAllMailConnections();
    await app.deps.db
      .update(mailAccounts)
      .set({ status: 'ok', oauthExpiresAt: new Date(Date.now() - 1000) })
      .where(shared);
    setOauthFetch(async () => Response.json({ error: 'invalid_grant' }, { status: 400 }));

    // Holds the read at its folder state query while the refusal comes in: the order that used
    // to depend on timing. The watcher renews too, so `auth_failed` shows up either way.
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    let holding = () => {};
    const held = new Promise<void>((resolve) => (holding = resolve));
    const lock = app.deps.db.transaction(async (tx) => {
      await tx.execute(sql`lock table ${mailFolderState} in access exclusive mode`);
      holding();
      await released;
    });
    try {
      await held;
      const reading = list().catch(() => undefined);
      await vi.waitFor(async () => expect(await status()).toBe('auth_failed'), { timeout: 10_000 });
      // Long enough for a rejection nobody listens to yet to be reported.
      await new Promise((resolve) => setTimeout(resolve, 200));
      release();
      await lock;
      await reading;
      await settleLive();
    } finally {
      release();
      await lock;
      setOauthFetch(entra);
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});
