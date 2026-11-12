import { eq } from 'drizzle-orm';
import { exportPKCS8, generateKeyPair } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '@crewhall/api-client';
import { calendarEvents, calendarEventVersions } from '@crewhall/db';
import { clearAppTokens } from '../src/services/calendar/external/domain-wide';
import { setCalendarFetch } from '../src/services/calendar/external/http';
import { GRAPH, microsoftClient } from '../src/services/calendar/external/microsoft';
import { clearServiceAccountTokens } from '../src/services/calendar/external/service-account';
import { syncDueAccounts, syncAccount } from '../src/services/calendar/external/sync';
import { recordVersion } from '../src/services/calendar/external/versions';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/** "The last writer wins, the overwritten version stays in the event's history" (sonraki-isler). */

const GCAL = 'https://www.googleapis.com/calendar/v3';

/** A Google calendar with one event that honours If-Match like the real one. */
class FakeGoogle {
  etag = 1;
  ifMatch: (string | null)[] = [];
  event: Record<string, unknown> = {};

  reset() {
    this.etag = 1;
    this.ifMatch = [];
    this.event = {
      id: 'g-1',
      status: 'confirmed',
      summary: 'Planlama',
      location: 'Oda 1',
      description: 'Gündem',
      start: { dateTime: '2026-12-10T07:00:00Z' },
      end: { dateTime: '2026-12-10T08:00:00Z' },
    };
  }

  /** Someone edits the event at Google. */
  change(patch: Record<string, unknown>) {
    this.event = { ...this.event, ...patch };
    this.etag++;
  }

  private current() {
    return { ...this.event, etag: `"${this.etag}"` };
  }

  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === 'https://oauth2.googleapis.com/token') {
      return Response.json({ access_token: 'sa-token', expires_in: 3600 });
    }
    if (url.startsWith(`${GCAL}/users/me/calendarList`)) {
      return Response.json({
        items: [{ id: 'cal-1', summary: 'Ana takvim', accessRole: 'owner', primary: true }],
      });
    }
    if (/\/calendars\/cal-1\/events\/g-1/.test(url)) {
      if (method === 'GET') return Response.json(this.current());
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const cond = headers['If-Match'] ?? null;
      this.ifMatch.push(cond);
      if (cond && cond !== `"${this.etag}"`) {
        return Response.json(
          { error: { code: 412, errors: [{ reason: 'conditionNotMet' }] } },
          { status: 412 },
        );
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      this.change(
        JSON.parse(JSON.stringify(body, (_k, v: unknown) => v ?? undefined)) as Record<
          string,
          unknown
        >,
      );
      return Response.json(this.current());
    }
    if (/\/calendars\/cal-1\/events/.test(url)) {
      return Response.json({
        items: [this.current()],
        nextSyncToken: `s-${this.etag}`,
        timeZone: 'Europe/Istanbul',
      });
    }
    return new Response('unexpected', { status: 500 });
  };
}

describe('calendar sync: overwritten versions', () => {
  const google = new FakeGoogle();
  let app: TestApp;
  let owner: Client;
  let mert: Client;
  let eventId: string;
  let accountId: string;

  const versions = () => owner.api.call('listCalendarEventVersions', { params: { eventId } });
  const sync = () => syncAccount(app.deps, accountId);

  beforeAll(async () => {
    google.reset();
    setCalendarFetch(google.fetch);
    clearServiceAccountTokens();
    clearAppTokens();
    app = await createTestApp();
    ({ owner } = await setupWithOwner(app));
    mert = (await join(app, owner, 'mert@milvasoft.com', 'member')).person;
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    await owner.api.call('updateCalendarIntegration', {
      params: { provider: 'google' },
      body: {
        enabled: true,
        clientId: 'g-client',
        clientSecret: 'g-secret',
        domainWide: true,
        serviceAccountKey: JSON.stringify({
          type: 'service_account',
          client_email: 'crewhall@proj.iam.gserviceaccount.com',
          private_key: await exportPKCS8(privateKey),
        }),
      },
    });
    await syncDueAccounts(app.deps);
    accountId = (await owner.api.call('listCalendarAccounts')).items[0]!.id;
    const { items } = await owner.api.call('listCalendarOccurrences', {
      query: { from: '2026-12-01T00:00:00Z', to: '2027-01-01T00:00:00Z' },
    });
    eventId = items.find((i) => i.title === 'Planlama')!.sourceId;
  });

  beforeEach(async () => {
    await app.deps.db.delete(calendarEventVersions);
  });

  afterAll(async () => {
    setCalendarFetch(null);
    await app?.close();
  });

  it('writes on the known version and keeps nothing when nobody else changed it', async () => {
    await owner.api.call('updateCalendarEvent', {
      params: { eventId },
      body: { location: 'Oda 2' },
    });
    expect(google.ifMatch.at(-1)).toMatch(/^"\d+"$/);
    expect((await versions()).items).toEqual([]);
  });

  it('keeps what the provider held when a Crewhall write overwrites it', async () => {
    google.change({ summary: 'Müşteri görüşmesi', description: 'Google tarafında yazıldı' });
    const saved = await owner.api.call('updateCalendarEvent', {
      params: { eventId },
      body: { location: 'Oda 3' },
    });
    // The write went through: the condition failed once, then the last writer won.
    expect(google.ifMatch.slice(-2)).toEqual([expect.any(String), null]);
    expect(saved.location).toBe('Oda 3');
    const { items } = await versions();
    expect(items).toEqual([
      expect.objectContaining({
        overwritten: 'provider',
        title: 'Müşteri görüşmesi',
        description: 'Google tarafında yazıldı',
        location: 'Oda 2',
        allDay: false,
        start: '2026-12-10T07:00:00.000Z',
      }),
    ]);
  });

  it('does not count an answer changing the provider version as a conflict', async () => {
    await sync();
    // Same content, new etag (someone answered the invitation).
    google.etag++;
    await owner.api.call('updateCalendarEvent', {
      params: { eventId },
      body: { location: 'Oda 4' },
    });
    expect(google.ifMatch.at(-1)).toBeNull();
    expect((await versions()).items).toEqual([]);
  });

  it('keeps the version written from Crewhall when the provider replaces it, once', async () => {
    await owner.api.call('updateCalendarEvent', {
      params: { eventId },
      body: { location: 'Oda 5', title: 'Crewhall başlığı' },
    });
    expect((await versions()).items).toEqual([]);
    // A second write from Crewhall does not save the first one: same writer.
    await owner.api.call('updateCalendarEvent', {
      params: { eventId },
      body: { location: 'Oda 6' },
    });
    expect((await versions()).items).toEqual([]);

    google.change({ summary: 'Google başlığı' });
    await sync();
    const { items } = await versions();
    expect(items).toEqual([
      expect.objectContaining({
        overwritten: 'crewhall',
        title: 'Crewhall başlığı',
        location: 'Oda 6',
      }),
    ]);
    const now = await owner.api.call('getCalendarEvent', { params: { eventId }, query: {} });
    expect(now.title).toBe('Google başlığı');

    // Changes only at the provider after that: nothing of Crewhall's is lost.
    google.change({ summary: 'Yine Google' });
    await sync();
    expect((await versions()).items).toHaveLength(1);
  });

  it('keeps the latest twenty versions and only for people who can read the event', async () => {
    const [row] = await app.deps.db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.id, eventId));
    for (let i = 0; i < 22; i++) {
      await recordVersion(app.deps.db, {
        orgId: row!.orgId,
        eventId,
        source: 'provider',
        etag: null,
        data: {
          title: `Sürüm ${i}`,
          description: null,
          location: null,
          allDay: false,
          start: '2026-12-10T07:00:00.000Z',
          end: '2026-12-10T08:00:00.000Z',
          attendees: [],
        },
      });
    }
    const { items } = await versions();
    expect(items).toHaveLength(20);
    expect(items[0]!.title).toBe('Sürüm 21');
    await expect(
      mert.api.call('listCalendarEventVersions', { params: { eventId } }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('sends Graph the weak form of the changeKey', async () => {
    const seen: { url: string; headers?: Record<string, string> }[] = [];
    const client = microsoftClient(async (url, req = {}) => {
      seen.push({ url, headers: req.headers });
      return { id: 'm-1' };
    }, 'mert@contoso.com');
    await client.updateEvent('m-cal', 'm-1', { title: 'Yeni' }, { ifMatch: 'abc' });
    expect(seen[0]).toEqual({
      url: `${GRAPH}/me/events/m-1`,
      headers: { 'If-Match': 'W/"abc"' },
    });
  });
});
