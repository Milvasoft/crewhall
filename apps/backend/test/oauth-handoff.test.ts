import { and, eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '@crewhall/api-client';
import { auditLogs, verifications } from '@crewhall/db';
import { setCalendarFetch } from '../src/services/calendar/external/http';
import { appReturn } from '../src/services/oauth-handoff';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/** An unsigned id_token: only its e-mail claim is read. */
const idToken = (email: string) =>
  [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ email, sub: 'sub-1' })).toString('base64url'),
    '',
  ].join('.');

/** Just enough Google: the token endpoint, and empty calendars for the first sync. */
const google: typeof fetch = async (input) => {
  const href = String(input);
  if (href.startsWith('https://oauth2.googleapis.com/token')) {
    return Response.json({
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expires_in: 3600,
      id_token: idToken('ayse@example.com'),
    });
  }
  if (href.includes('/calendarList')) return Response.json({ items: [] });
  return Response.json({ items: [], nextSyncToken: 'sync-1' });
};

/** Connecting a calendar from the app: the system browser has no web session. */
describe('OAuth hand-off from the app', () => {
  let app: TestApp;
  let owner: Client;
  let orgId: string;
  let guest: Client;

  /** A browser without any session: only what the link itself carries. */
  const browser = (path: string, cookie?: string) =>
    app.app.request(path, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
  const pathOf = (url: string) => {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  };
  const handoff = () =>
    owner.api.call('createOAuthHandoff', {
      body: { purpose: 'calendar', provider: 'google', redirectUri: 'crewhall://open' },
    });

  beforeAll(async () => {
    setCalendarFetch(google);
    app = await createTestApp();
    const setup = await setupWithOwner(app);
    owner = setup.owner;
    orgId = setup.orgId;
    await owner.api.call('updateCalendarIntegration', {
      params: { provider: 'google' },
      body: { enabled: true, clientId: 'g-client', clientSecret: 'g-secret-value' },
    });
    guest = (await join(app, owner, 'misafir@example.com', 'guest')).person;
  });

  afterAll(async () => {
    setCalendarFetch(null);
    await app?.close();
  });

  it('connects a Google calendar through a one-time link and returns to the app', async () => {
    const link = await handoff();
    expect(Date.parse(link.expiresAt) - Date.now()).toBeLessThanOrEqual(120_000);

    const open = await browser(pathOf(link.url));
    expect(open.status).toBe(302);
    const authorize = new URL(open.headers.get('location')!);
    expect(authorize.origin + authorize.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    const cookie = open.headers.get('set-cookie')!.split(';')[0]!;
    expect(cookie).toMatch(/^crewhall_oauth_handoff=/);
    expect(open.headers.get('set-cookie')).toMatch(/HttpOnly/i);

    // The provider sends the same browser back; no web session, the link's person.
    const state = authorize.searchParams.get('state')!;
    const back = await browser(
      `/api/calendar/oauth/callback?code=c-1&state=${encodeURIComponent(state)}`,
      cookie,
    );
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toBe(
      `crewhall://open?url=${encodeURIComponent('/calendar?connected=google')}`,
    );
    const accounts = await owner.api.call('listCalendarAccounts');
    expect(accounts.items.map((a) => a.email)).toEqual(['ayse@example.com']);

    // The link works once.
    const again = await browser(pathOf(link.url));
    expect(again.status).toBe(410);
    expect(((await again.json()) as { code: string }).code).toBe('oauth_handoff_invalid');

    const actions = await app.deps.db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(and(eq(auditLogs.orgId, orgId), like(auditLogs.action, 'oauth.handoff.%')));
    expect(actions.map((a) => a.action).sort()).toEqual([
      'oauth.handoff.create',
      'oauth.handoff.open',
    ]);
  });

  it('finishes only in the browser that opened the link, and the link lives two minutes', async () => {
    const open = await browser(pathOf((await handoff()).url));
    const state = new URL(open.headers.get('location')!).searchParams.get('state')!;
    // Another browser (no cookie of the link, no session) cannot finish it.
    const elsewhere = await browser(
      `/api/calendar/oauth/callback?code=c-2&state=${encodeURIComponent(state)}`,
    );
    expect(elsewhere.status).toBe(401);
    const forged = await browser(
      `/api/calendar/oauth/callback?code=c-2&state=${encodeURIComponent(state)}`,
      'crewhall_oauth_handoff=not-the-cookie',
    );
    expect(forged.status).toBe(401);

    const late = await handoff();
    await app.deps.db
      .update(verifications)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(like(verifications.identifier, 'oauth-handoff:%'));
    expect((await browser(pathOf(late.url))).status).toBe(410);
  });

  it('returns only to the app, and only for people who may connect', async () => {
    for (const redirectUri of ['https://evil.example.com/x', 'javascript://x', 'crewhall:open']) {
      await expect(
        owner.api.call('createOAuthHandoff', {
          body: { purpose: 'calendar', provider: 'google', redirectUri },
        }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
    }
    await expect(
      owner.api.call('createOAuthHandoff', {
        body: { purpose: 'calendar', redirectUri: 'crewhall://open' },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    const refused = await guest.api
      .call('createOAuthHandoff', {
        body: { purpose: 'calendar', provider: 'google', redirectUri: 'crewhall://open' },
      })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).status).toBe(403);
    // Expo Go in development is allowed like the sign-in hand-off.
    const dev = await owner.api.call('createOAuthHandoff', {
      body: { purpose: 'mail', redirectUri: 'exp://192.168.1.20:8081/--/open' },
    });
    expect(new URL(dev.url).pathname).toBe('/api/oauth/handoff');
  });

  it('refuses Expo Go in production and still returns to the app', async () => {
    const before = app.deps.env.NODE_ENV;
    app.deps.env.NODE_ENV = 'production';
    try {
      await expect(
        owner.api.call('createOAuthHandoff', {
          body: { purpose: 'mail', redirectUri: 'exp://evil.host/--/open' },
        }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      expect(() => appReturn(app.deps.env, 'exp://evil.host/--/open', '/mail')).toThrow();
      await expect(handoff()).resolves.toMatchObject({ url: expect.any(String) });
    } finally {
      app.deps.env.NODE_ENV = before;
    }
  });
});
