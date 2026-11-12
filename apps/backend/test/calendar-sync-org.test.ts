import { eq } from 'drizzle-orm';
import { exportPKCS8, generateKeyPair, decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '@crewhall/api-client';
import { calendarAccounts, calendars } from '@crewhall/db';
import { clearAppTokens } from '../src/services/calendar/external/domain-wide';
import { setCalendarFetch } from '../src/services/calendar/external/http';
import { GRAPH, microsoftClient } from '../src/services/calendar/external/microsoft';
import {
  accountForNotification,
  ensurePush,
  pushBase,
} from '../src/services/calendar/external/push';
import { clearServiceAccountTokens } from '../src/services/calendar/external/service-account';
import { syncDueAccounts } from '../src/services/calendar/external/sync';
import type { ProviderClient } from '../src/services/calendar/external/types';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/**
 * Calendar sync, the rest of sonraki-isler: org-wide access (Google domain-wide delegation,
 * Microsoft application permission), busy-only accounts, change notifications, Microsoft
 * series edits and a Crewhall meeting on a mirrored calendar.
 */

const GCAL = 'https://www.googleapis.com/calendar/v3';

interface Call {
  method: string;
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

class Fake {
  calls: Call[] = [];
  created = new Map<string, Record<string, unknown>>();
  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const raw = init?.body ? String(init.body) : '';
    let body: unknown = raw;
    try {
      // Google answers without the fields a request clears (null).
      body = raw.startsWith('{')
        ? JSON.parse(raw, (_k, v: unknown) => (v === null ? undefined : v))
        : raw;
    } catch {
      // form bodies stay text
    }
    this.calls.push({
      method,
      url,
      body,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return this.answer(method, url, body);
  };

  private answer(method: string, url: string, body: unknown): Response {
    if (url === 'https://oauth2.googleapis.com/token') {
      const form = new URLSearchParams(String(body));
      const sub = String(decodeJwt(form.get('assertion') ?? '').sub ?? '');
      return Response.json({ access_token: `sa-${sub}`, expires_in: 3600 });
    }
    if (url.includes('login.microsoftonline.com')) {
      return Response.json({ access_token: 'app-token', expires_in: 3600 });
    }
    if (url.startsWith(`${GCAL}/users/me/calendarList`)) {
      return Response.json({
        items: [{ id: 'primary-cal', summary: 'Ana takvim', accessRole: 'owner', primary: true }],
      });
    }
    const ev = /\/calendars\/primary-cal\/events(?:\/([^/?]+))?(\/watch)?/.exec(url);
    if (ev) {
      const [, id, watch] = ev;
      if (watch) {
        return Response.json({
          id: (body as { id: string }).id,
          resourceId: 'res-1',
          expiration: String(Date.now() + 7 * 86_400_000),
        });
      }
      if (method === 'POST') {
        const created = { id: 'g-new', status: 'confirmed', ...(body as object) };
        this.created.set('g-new', created);
        return Response.json(created);
      }
      if (method === 'GET' && id) {
        return Response.json(
          this.created.get(decodeURIComponent(id)) ?? {
            id: decodeURIComponent(id),
            status: 'confirmed',
          },
        );
      }
      if (method === 'PATCH') {
        const cur = this.created.get(decodeURIComponent(id!)) ?? { id: decodeURIComponent(id!) };
        const next = { ...cur, ...(body as object) };
        this.created.set(String(next.id), next);
        return Response.json(next);
      }
      return Response.json({
        items: [
          {
            id: 'g-1',
            status: 'confirmed',
            summary: 'Gizli toplantı',
            location: 'Oda 1',
            description: 'Gündem',
            start: { dateTime: '2026-11-10T07:00:00Z' },
            end: { dateTime: '2026-11-10T08:00:00Z' },
          },
          ...this.created.values(),
        ],
        nextSyncToken: `s-${this.calls.length}`,
        timeZone: 'Europe/Istanbul',
      });
    }
    if (url.includes('/calendars?$select')) {
      return Response.json({
        value: [{ id: 'm-cal', name: 'Takvim', canEdit: true, isDefaultCalendar: true }],
      });
    }
    if (url.includes('/calendarView/delta')) {
      return Response.json({ value: [], '@odata.deltaLink': `${GRAPH}/delta-1` });
    }
    return new Response('unexpected', { status: 500 });
  }
}

describe('calendar sync: org-wide access and the rest', () => {
  const fake = new Fake();
  let app: TestApp;
  let owner: Client;
  let mert: Client;
  let mertId: string;
  let key: string;

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

  const occurrences = (c: Client) =>
    c.api.call('listCalendarOccurrences', {
      query: {
        from: '2026-11-01T00:00:00Z',
        to: '2026-12-01T00:00:00Z',
        meetings: 'false',
        cards: 'false',
      },
    });

  beforeAll(async () => {
    setCalendarFetch(fake.fetch);
    clearServiceAccountTokens();
    clearAppTokens();
    app = await createTestApp();
    ({ owner } = await setupWithOwner(app));
    const m = await join(app, owner, 'mert@milvasoft.com', 'member');
    mert = m.person;
    mertId = m.me.user.id;
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    key = JSON.stringify({
      type: 'service_account',
      client_email: 'crewhall@proj.iam.gserviceaccount.com',
      private_key: await exportPKCS8(privateKey),
    });
  });

  afterAll(async () => {
    setCalendarFetch(null);
    await app?.close();
  });

  it("syncs everyone's Google calendar through the service account", async () => {
    const saved = await owner.api.call('updateCalendarIntegration', {
      params: { provider: 'google' },
      body: {
        enabled: true,
        clientId: 'g-client',
        clientSecret: 'g-secret',
        serviceAccountKey: key,
        domainWide: true,
      },
    });
    expect(saved.domainWide).toBe(true);
    // Everyone got a delegated account at once; nobody connected anything.
    const { items } = await mert.api.call('listCalendarAccounts');
    expect(items).toEqual([
      expect.objectContaining({ provider: 'google', email: 'mert@milvasoft.com', delegated: true }),
    ]);
    await syncDueAccounts(app.deps);
    // The token was asked for as Mert (sub), with the service account's key.
    expect(
      fake.calls.some(
        (c) =>
          c.url === 'https://oauth2.googleapis.com/token' && String(c.body).includes('assertion'),
      ),
    ).toBe(true);
    const mine = await occurrences(mert);
    expect(mine.items.find((i) => i.title === 'Gizli toplantı')).toBeDefined();
    // The org added it: the person cannot remove it.
    await expectCode(
      mert.api.call('deleteCalendarAccount', { params: { accountId: items[0]!.id } }),
      403,
    );
  });

  it('keeps only busy times for a busy-only account and writes nothing back', async () => {
    const [account] = (await mert.api.call('listCalendarAccounts')).items;
    const updated = await mert.api.call('updateCalendarAccount', {
      params: { accountId: account!.id },
      body: { busyOnly: true },
    });
    expect(updated.busyOnly).toBe(true);
    // The sync the switch started (jobs run inline in tests) dropped the details.
    const busy = (await occurrences(mert)).items.find(
      (i) => i.start === '2026-11-10T07:00:00.000Z',
    )!;
    expect(busy).toMatchObject({ hidden: true, title: '', location: null });
    expect(updated.calendars.every((c) => !c.writable)).toBe(true);
    await mert.api.call('updateCalendarAccount', {
      params: { accountId: account!.id },
      body: { busyOnly: false },
    });
    const back = (await occurrences(mert)).items.find(
      (i) => i.start === '2026-11-10T07:00:00.000Z',
    )!;
    expect(back).toMatchObject({ hidden: false, title: 'Gizli toplantı' });
  });

  it('opens and renews notification channels and accepts only signed notifications', async () => {
    expect(pushBase({ API_URL: 'http://localhost:3000' })).toBeNull();
    expect(pushBase({ API_URL: 'https://hub.example.com/' })).toBe('https://hub.example.com');
    const [cal] = await app.deps.db
      .select()
      .from(calendars)
      .where(eq(calendars.kind, 'external'))
      .limit(1);
    const [account] = await app.deps.db
      .select()
      .from(calendarAccounts)
      .where(eq(calendarAccounts.id, cal!.accountId!));
    let watched = 0;
    const client = {
      watch: async (_id: string, address: string, token: string) => {
        watched++;
        expect(address).toBe('https://hub.example.com/api/calendar/push/google');
        expect(token.length).toBeGreaterThan(20);
        return {
          id: 'chan-1',
          resourceId: 'res-1',
          expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        };
      },
      renew: async () => null,
      unwatch: async () => undefined,
    } as unknown as ProviderClient;
    const deps = { ...app.deps, env: { ...app.deps.env, API_URL: 'https://hub.example.com' } };
    await ensurePush(deps, client, { ...account!, provider: 'google' }, cal!);
    const [saved] = await app.deps.db.select().from(calendars).where(eq(calendars.id, cal!.id));
    expect(saved!.syncState?.push).toMatchObject({ id: 'chan-1', resourceId: 'res-1' });
    // Fresh: nothing to renew.
    await ensurePush(deps, client, { ...account!, provider: 'google' }, saved!);
    expect(watched).toBe(1);
    expect(await accountForNotification(app.deps.db, app.deps.env, 'chan-1', 'forged')).toBeNull();
    expect(await accountForNotification(app.deps.db, app.deps.env, 'other', 'x')).toBeNull();

    // Graph's subscription handshake: the token comes back as text.
    const res = await owner.fetch(
      'http://localhost:3000/api/calendar/push/microsoft?validationToken=abc%20def',
      { method: 'POST' },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('abc def');
    const g = await owner.fetch('http://localhost:3000/api/calendar/push/google', {
      method: 'POST',
      headers: {
        'x-goog-channel-id': 'chan-1',
        'x-goog-channel-token': 'forged',
        'x-goog-resource-state': 'exists',
      },
    });
    expect(g.status).toBe(200);
  });

  it('adds a Crewhall meeting to an event of a mirrored calendar', async () => {
    const cal = (await owner.api.call('listCalendars')).items.find(
      (c) => c.external?.provider === 'google',
    )!;
    const ev = await owner.api.call('createCalendarEvent', {
      body: {
        calendarId: cal.id,
        title: 'Müşteri görüşmesi',
        allDay: false,
        start: '2026-11-12T09:00:00.000Z',
        end: '2026-11-12T10:00:00.000Z',
        onlineMeeting: true,
      },
    });
    expect(ev.meeting?.url).toMatch(/\/m\//);
    // The link went to Google, so the people Google invites get it.
    const patched = fake.created.get('g-new')!;
    expect(String(patched.description)).toContain(ev.meeting!.url);
    expect(patched.location).toBe(ev.meeting!.url);
  });

  it('switches org-wide access off: the delegated accounts go', async () => {
    await owner.api.call('updateCalendarIntegration', {
      params: { provider: 'google' },
      body: { enabled: true, domainWide: false },
    });
    expect((await mert.api.call('listCalendarAccounts')).items).toEqual([]);
  });

  it('reads Microsoft mailboxes by address with the application token', async () => {
    await expectCode(
      owner.api.call('updateCalendarIntegration', {
        params: { provider: 'microsoft' },
        body: {
          enabled: true,
          clientId: 'm-client',
          clientSecret: 'm-secret',
          tenant: 'common',
          domainWide: true,
        },
      }),
      422,
      'validation_failed',
    );
    await owner.api.call('updateCalendarIntegration', {
      params: { provider: 'microsoft' },
      body: {
        enabled: true,
        clientId: 'm-client',
        clientSecret: 'm-secret',
        tenant: 'contoso.onmicrosoft.com',
        domainWide: true,
      },
    });
    fake.calls = [];
    await syncDueAccounts(app.deps);
    expect(
      fake.calls.some(
        (c) =>
          c.url.includes('login.microsoftonline.com/contoso.onmicrosoft.com') &&
          String(c.body).includes('client_credentials'),
      ),
    ).toBe(true);
    expect(
      fake.calls.some((c) => c.url.startsWith(`${GRAPH}/users/mert%40milvasoft.com/calendars`)),
    ).toBe(true);
    await owner.api.call('updateCalendarIntegration', {
      params: { provider: 'microsoft' },
      body: { enabled: false, domainWide: false },
    });
  });

  it('moves a whole Microsoft series from one occurrence, in the event zone', async () => {
    const seen: { url: string; method?: string; body?: unknown }[] = [];
    const api = async (url: string, req: { method?: string; body?: unknown } = {}) => {
      seen.push({ url, method: req.method, body: req.body });
      if (!req.method) {
        return {
          start: { dateTime: '2026-11-02T07:00:00.0000000', timeZone: 'UTC' },
          end: { dateTime: '2026-11-02T08:00:00.0000000', timeZone: 'UTC' },
          isAllDay: false,
          recurrence: {
            pattern: { type: 'weekly', interval: 1, daysOfWeek: ['monday'] },
            range: { type: 'noEnd', startDate: '2026-11-02' },
          },
        };
      }
      return { id: 'master-1', subject: 'Haftalık' };
    };
    const client = microsoftClient(api, 'mert@contoso.com');
    await client.updateEvent('m-cal', 'master-1', {
      title: 'Haftalık (yeni saat)',
      timeZone: 'Europe/Istanbul',
      seriesShift: { ms: 26 * 3_600_000, days: 1, lengthMs: 90 * 60_000 },
    });
    const patch = seen.find((s) => s.method === 'PATCH')!;
    expect(patch.url).toBe(`${GRAPH}/me/events/master-1`);
    expect(patch.body).toMatchObject({
      subject: 'Haftalık (yeni saat)',
      // 07:00Z + 26 h = Tuesday 09:00Z = 12:00 in Istanbul, for an hour and a half.
      start: { dateTime: '2026-11-03T12:00:00', timeZone: 'Europe/Istanbul' },
      end: { dateTime: '2026-11-03T13:30:00', timeZone: 'Europe/Istanbul' },
      recurrence: { range: { type: 'noEnd', startDate: '2026-11-03' } },
    });
    void mertId;
  });
});
