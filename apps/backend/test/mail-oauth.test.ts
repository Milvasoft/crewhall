import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mailAccounts } from '@crewhall/db';
import { openSecret } from '../src/services/mail/crypto';
import { closeAllMailConnections } from '../src/services/mail/imap';
import { setOauthFetch } from '../src/services/mail/oauth';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';
import { MAILBOXES, startGreenMail, type GreenMail } from './mail-containers';

/** An unsigned id_token: only its e-mail claim is read (it comes straight from the token endpoint). */
const idToken = (email: string) =>
  [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ email, sub: 'google-sub' })).toString('base64url'),
    '',
  ].join('.');

describe('mail OAuth2 (Google / Microsoft 365)', () => {
  let gm: GreenMail;
  let app: TestApp;
  let owner: Client;
  let elif: Client;
  const calls: { url: string; form: URLSearchParams }[] = [];

  beforeAll(async () => {
    [gm, app] = await Promise.all([startGreenMail(), createTestApp()]);
    ({ owner } = await setupWithOwner(app));
    ({ person: elif } = await join(app, owner, 'elif@milvasoft.com', 'member'));
    // GreenMail checks XOAUTH2 tokens like passwords, so the fake provider hands out the
    // mailbox password as the access token.
    setOauthFetch(async (input, init) => {
      const form = new URLSearchParams(String(init?.body));
      calls.push({ url: String(input), form });
      if (form.get('grant_type') === 'authorization_code' && form.get('code') !== 'good-code') {
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      return Response.json({
        access_token: MAILBOXES.elif.password,
        refresh_token: `refresh-${calls.length}`,
        expires_in: 3600,
        id_token: idToken(MAILBOXES.elif.address),
      });
    });
  });

  afterAll(async () => {
    setOauthFetch(null);
    await closeAllMailConnections();
    await app?.close();
    await gm?.container.stop();
  });

  it('needs the client id and secret for OAuth modes, and never returns the secret', async () => {
    const body = {
      imapHost: gm.host,
      imapPort: gm.imapPort,
      imapSecurity: 'none' as const,
      smtpHost: gm.host,
      smtpPort: gm.smtpPort,
      smtpSecurity: 'none' as const,
      authMode: 'oauth_google' as const,
    };
    await expect(owner.api.call('mailUpdateServerSettings', { body })).rejects.toMatchObject({
      status: 400,
    });
    const saved = await owner.api.call('mailUpdateServerSettings', {
      body: { ...body, oauthClientId: 'client-123', oauthClientSecret: 'very-secret-value' },
    });
    expect(saved).toMatchObject({ authMode: 'oauth_google', hasOauthClientSecret: true });
    expect(JSON.stringify(saved)).not.toContain('very-secret-value');
    // Keeping the stored secret: the field is left out.
    const again = await owner.api.call('mailUpdateServerSettings', {
      body: { ...body, oauthClientId: 'client-123' },
    });
    expect(again.hasOauthClientSecret).toBe(true);
  });

  it('refuses app passwords while the org uses OAuth2', async () => {
    await expect(
      elif.api.call('mailConnectAccount', {
        body: { email: MAILBOXES.elif.address, password: MAILBOXES.elif.password },
      }),
    ).rejects.toMatchObject({ status: 409, code: 'mail_auth_mode_mismatch' });
  });

  it('connects through the provider with PKCE and signs in with XOAUTH2', async () => {
    const start = await elif.fetch('http://localhost:3000/api/mail/oauth/start', {
      redirect: 'manual',
    });
    expect(start.status).toBe(302);
    const url = new URL(start.headers.get('location')!);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:3000/api/mail/oauth/callback',
    );
    expect(url.searchParams.get('scope')).toContain('https://mail.google.com/');
    const state = url.searchParams.get('state')!;

    // A wrong code ends on the web app with the error code.
    const bad = await elif.fetch(
      `http://localhost:3000/api/mail/oauth/callback?code=bad&state=${encodeURIComponent(state)}`,
      { redirect: 'manual' },
    );
    expect(bad.headers.get('location')).toBe('http://localhost:5173/mail?error=mail_auth_failed');

    // The state is single use: start again.
    const again = await elif.fetch('http://localhost:3000/api/mail/oauth/start', {
      redirect: 'manual',
    });
    const state2 = new URL(again.headers.get('location')!).searchParams.get('state')!;
    const ok = await elif.fetch(
      `http://localhost:3000/api/mail/oauth/callback?code=good-code&state=${encodeURIComponent(state2)}`,
      { redirect: 'manual' },
    );
    expect(ok.headers.get('location')).toBe('http://localhost:5173/mail?connected=1');
    const exchange = calls.find((c) => c.form.get('code') === 'good-code')!;
    expect(exchange.form.get('code_verifier')).toBeTruthy();
    expect(exchange.form.get('client_secret')).toBe('very-secret-value');

    const state3 = await elif.api.call('mailAccount');
    expect(state3.account).toMatchObject({
      email: MAILBOXES.elif.address,
      authMode: 'oauth_google',
      status: 'ok',
    });
    const folders = await elif.api.call('mailFolders');
    expect(folders.items.some((f) => f.path === 'INBOX')).toBe(true);
  });

  it('renews an expired access token with the refresh token', async () => {
    await closeAllMailConnections();
    await app.deps.db.update(mailAccounts).set({ oauthExpiresAt: new Date(Date.now() - 1000) });
    const before = calls.length;
    // A full-text search always asks the server (folder lists may come from the kept copy).
    await elif.api.call('mailMessages', { query: { folder: 'INBOX', q: 'yenileme' } });
    expect(calls.length).toBe(before + 1);
    expect(calls.at(-1)!.form.get('grant_type')).toBe('refresh_token');
    const [row] = await app.deps.db.select().from(mailAccounts);
    expect(row!.oauthExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 3000_000);
    expect(openSecret(app.env.AUTH_SECRET, row!.oauthRefreshEnc)).toBe(`refresh-${calls.length}`);
  });

  it('rejects a callback state from another user', async () => {
    const start = await elif.fetch('http://localhost:3000/api/mail/oauth/start', {
      redirect: 'manual',
    });
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const stolen = await owner.fetch(
      `http://localhost:3000/api/mail/oauth/callback?code=good-code&state=${encodeURIComponent(state)}`,
      { redirect: 'manual' },
    );
    expect(stolen.headers.get('location')).toBe(
      'http://localhost:5173/mail?error=mail_oauth_failed',
    );
    const [ownerRow] = await app.deps.db
      .select()
      .from(mailAccounts)
      .where(eq(mailAccounts.email, 'bugra@milvasoft.com'));
    expect(ownerRow).toBeUndefined();
  });
});
