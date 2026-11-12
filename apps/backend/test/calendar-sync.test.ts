import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '@crewhall/api-client';
import { calendarAccounts, calendarEvents, calendars } from '@crewhall/db';
import { parseRecurrence } from '../src/services/calendar/external/google';
import { setCalendarFetch } from '../src/services/calendar/external/http';
import { GRAPH, graphRecurrence } from '../src/services/calendar/external/microsoft';
import { openSecret } from '../src/services/calendar/external/secrets';
import { syncAccount } from '../src/services/calendar/external/sync';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

const GCAL = 'https://www.googleapis.com/calendar/v3';

/** An unsigned id_token: only its e-mail claim is read (it comes straight from the token endpoint). */
const idToken = (email: string) =>
  [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ email, sub: 'sub-1' })).toString('base64url'),
    '',
  ].join('.');

interface Call {
  method: string;
  url: URL;
  body: unknown;
}

/** A scripted Google + Microsoft: tests set what each URL answers. */
class FakeProviders {
  calls: Call[] = [];
  refreshFails = false;
  googleGone = false;
  googleFull: unknown[] = [];
  googleDelta: unknown[] = [];
  googleSeq = 0;
  graphPages = new Map<string, { value: unknown[]; next?: string; delta?: string }>();
  graphDelta: { value: unknown[]; delta: string } = { value: [], delta: `${GRAPH}/delta-x` };
  respondEvent: unknown = null;

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const raw = init?.body ? String(init.body) : '';
    let body: unknown;
    try {
      body = raw && raw.startsWith('{') ? JSON.parse(raw) : raw;
    } catch {
      body = raw;
    }
    this.calls.push({ method, url, body });
    return this.answer(method, url, body);
  };

  private answer(method: string, url: URL, body: unknown): Response {
    const href = url.toString();
    if (
      href.startsWith('https://oauth2.googleapis.com/token') ||
      href.includes('/oauth2/v2.0/token')
    ) {
      const form = new URLSearchParams(String(body));
      if (form.get('grant_type') === 'refresh_token' && this.refreshFails) {
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      const ms = href.includes('microsoftonline');
      return Response.json({
        access_token: `access-${this.calls.length}`,
        refresh_token: form.get('grant_type') === 'authorization_code' ? 'refresh-1' : undefined,
        expires_in: 3600,
        id_token: idToken(ms ? 'mert@contoso.com' : 'ayse@example.com'),
      });
    }
    if (href.startsWith('https://oauth2.googleapis.com/revoke'))
      return new Response(null, { status: 200 });

    if (href.startsWith(`${GCAL}/users/me/calendarList`)) {
      return Response.json({
        items: [
          { id: 'g-primary', summary: 'ayse@example.com', accessRole: 'owner', primary: true },
          { id: 'holidays', summary: 'Türkiye tatilleri', accessRole: 'reader' },
        ],
      });
    }
    const ev = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?(\/instances)?$/.exec(
      url.pathname,
    );
    if (ev) {
      const [, cal, id, instances] = ev;
      if (decodeURIComponent(cal!) === 'holidays')
        return Response.json({ items: [], nextSyncToken: 'h-1' });
      if (instances) {
        return Response.json({
          items: [{ id: `${decodeURIComponent(id!)}_20261116T060000Z`, status: 'confirmed' }],
        });
      }
      if (method === 'GET' && !id) {
        if (url.searchParams.get('syncToken')) {
          if (this.googleGone) {
            this.googleGone = false;
            return Response.json(
              { error: { code: 410, errors: [{ reason: 'fullSyncRequired' }] } },
              { status: 410 },
            );
          }
          const items = this.googleDelta;
          this.googleDelta = [];
          return Response.json({ items, nextSyncToken: `sync-${++this.googleSeq}` });
        }
        return Response.json({
          items: this.googleFull,
          nextSyncToken: `sync-${++this.googleSeq}`,
          timeZone: 'Europe/Istanbul',
        });
      }
      if (method === 'GET' && id) return Response.json(this.respondEvent);
      if (method === 'POST') return Response.json({ id: 'g-new', status: 'confirmed' });
      if (method === 'PATCH')
        return Response.json({ id: decodeURIComponent(id!), status: 'confirmed' });
      if (method === 'DELETE') return new Response(null, { status: 204 });
    }

    if (href.startsWith(`${GRAPH}/me/calendars?`)) {
      return Response.json({
        value: [{ id: 'm-cal', name: 'Takvim', canEdit: true, isDefaultCalendar: true }],
      });
    }
    if (href.startsWith(`${GRAPH}/me/calendars/m-cal/calendarView/delta?`)) {
      const page = this.graphPages.get('first')!;
      return Response.json({
        value: page.value,
        '@odata.nextLink': page.next,
        '@odata.deltaLink': page.delta,
      });
    }
    const page = this.graphPages.get(href);
    if (page)
      return Response.json({
        value: page.value,
        '@odata.nextLink': page.next,
        '@odata.deltaLink': page.delta,
      });
    if (href.startsWith(`${GRAPH}/delta-`)) {
      const d = this.graphDelta;
      this.graphDelta = { value: [], delta: `${GRAPH}/delta-y` };
      return Response.json({ value: d.value, '@odata.deltaLink': d.delta });
    }
    if (href === `${GRAPH}/me/calendars/m-cal/events` && method === 'POST')
      return Response.json({ id: 'm-new' });
    if (href.startsWith(`${GRAPH}/me/events/`) && method === 'POST')
      return new Response(null, { status: 202 });
    if (href.startsWith(`${GRAPH}/me/events/`) && method === 'PATCH') {
      return Response.json({ id: decodeURIComponent(url.pathname.split('/').pop()!) });
    }
    return Response.json({ error: { code: 'unexpected', message: href } }, { status: 500 });
  }

  last(method: string, path: string) {
    return [...this.calls]
      .reverse()
      .find((c) => c.method === method && c.url.toString().includes(path));
  }
}

const gSeries = {
  id: 'series-1',
  etag: '"1"',
  status: 'confirmed',
  summary: 'Haftalık',
  start: { dateTime: '2026-11-02T09:00:00+03:00', timeZone: 'Europe/Istanbul' },
  end: { dateTime: '2026-11-02T09:30:00+03:00', timeZone: 'Europe/Istanbul' },
  recurrence: ['RRULE:FREQ=WEEKLY;COUNT=4', 'EXDATE;TZID=Europe/Istanbul:20261109T090000'],
  htmlLink: 'https://calendar.google.com/event?eid=1',
};
const gMoved = {
  id: 'series-1_20261116T060000Z',
  etag: '"2"',
  status: 'confirmed',
  summary: 'Haftalık (kaydı)',
  recurringEventId: 'series-1',
  originalStartTime: { dateTime: '2026-11-16T09:00:00+03:00', timeZone: 'Europe/Istanbul' },
  start: { dateTime: '2026-11-16T10:00:00+03:00', timeZone: 'Europe/Istanbul' },
  end: { dateTime: '2026-11-16T10:30:00+03:00', timeZone: 'Europe/Istanbul' },
};
const gCancelled = {
  id: 'series-1_20261123T060000Z',
  status: 'cancelled',
  recurringEventId: 'series-1',
  originalStartTime: { dateTime: '2026-11-23T09:00:00+03:00', timeZone: 'Europe/Istanbul' },
};
const gSingle = {
  id: 'one-1',
  etag: '"3"',
  status: 'confirmed',
  summary: 'Müşteri görüşmesi',
  start: { dateTime: '2026-11-05T12:00:00Z' },
  end: { dateTime: '2026-11-05T13:00:00Z' },
  hangoutLink: 'https://meet.google.com/abc-defg-hij',
  organizer: { email: 'boss@example.com', displayName: 'Boss' },
  attendees: [
    { email: 'boss@example.com', organizer: true, responseStatus: 'accepted' },
    { email: 'ayse@example.com', self: true, responseStatus: 'needsAction' },
  ],
};

describe('calendar sync: provider mapping', () => {
  it('reads Google RRULE and EXDATE lines, refuses RDATE', () => {
    expect(
      parseRecurrence(
        [
          'RRULE:FREQ=WEEKLY;BYDAY=MO,WE',
          'EXDATE;TZID=Europe/Istanbul:20261109T090000,20261111T090000',
        ],
        'Europe/Istanbul',
        false,
      ),
    ).toEqual({
      rrule: 'FREQ=WEEKLY;BYDAY=MO,WE',
      exdates: ['2026-11-09T06:00:00.000Z', '2026-11-11T06:00:00.000Z'],
      unsupported: false,
    });
    expect(
      parseRecurrence(['RRULE:FREQ=DAILY', 'EXDATE;VALUE=DATE:20261103'], 'UTC', true).exdates,
    ).toEqual(['2026-11-03']);
    expect(
      parseRecurrence(['RRULE:FREQ=DAILY', 'RDATE:20261201T090000Z'], 'UTC', false).unsupported,
    ).toBe(true);
    expect(parseRecurrence(['RRULE:FREQ=HOURLY'], 'UTC', false)).toMatchObject({
      rrule: null,
      unsupported: true,
    });
  });

  it('turns RRULE into Graph patternedRecurrence and refuses what Outlook cannot hold', () => {
    expect(
      graphRecurrence('FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6', '2026-11-02', 'Europe/Istanbul'),
    ).toEqual({
      pattern: {
        type: 'weekly',
        interval: 1,
        daysOfWeek: ['monday', 'wednesday'],
        firstDayOfWeek: 'monday',
      },
      range: {
        type: 'numbered',
        numberOfOccurrences: 6,
        startDate: '2026-11-02',
        recurrenceTimeZone: 'Europe/Istanbul',
      },
    });
    expect(graphRecurrence('FREQ=MONTHLY;BYDAY=-1FR', '2026-11-27', 'UTC').pattern).toEqual({
      type: 'relativeMonthly',
      interval: 1,
      daysOfWeek: ['friday'],
      index: 'last',
    });
    expect(graphRecurrence('FREQ=YEARLY;UNTIL=20301231', '2026-11-27', 'UTC')).toMatchObject({
      pattern: { type: 'absoluteYearly', month: 11, dayOfMonth: 27 },
      range: { type: 'endDate', endDate: '2030-12-31' },
    });
    expect(() =>
      graphRecurrence('FREQ=MONTHLY;BYSETPOS=2;BYDAY=MO,TU', '2026-11-02', 'UTC'),
    ).toThrow();
  });
});

describe('calendar sync: Google and Microsoft accounts', () => {
  const fake = new FakeProviders();
  let app: TestApp;
  let owner: Client;
  let ownerId: string;
  let mert: Client;
  let googleCalId: string;

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

  async function connect(client: Client, provider: 'google' | 'microsoft') {
    const start = await client.fetch(`http://localhost:3000/api/calendar/oauth/${provider}/start`, {
      redirect: 'manual',
    });
    expect(start.status).toBe(302);
    const url = new URL(start.headers.get('location')!);
    const state = url.searchParams.get('state')!;
    const back = await client.fetch(
      `http://localhost:3000/api/calendar/oauth/callback?code=c-1&state=${encodeURIComponent(state)}`,
      { redirect: 'manual' },
    );
    return { authorize: url, back: back.headers.get('location') };
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
    app = await createTestApp();
    ({ owner, ownerId } = await setupWithOwner(app));
    ({ person: mert } = await join(app, owner, 'mert@milvasoft.com', 'member'));
    fake.googleFull = [gSeries, gMoved, gCancelled, gSingle];
  });

  afterAll(async () => {
    setCalendarFetch(null);
    await app?.close();
  });

  it('lets only admins set up providers and never returns the secret', async () => {
    await expectCode(
      mert.api.call('updateCalendarIntegration', {
        params: { provider: 'google' },
        body: { enabled: true },
      }),
      403,
    );
    await expectCode(
      owner.api.call('updateCalendarIntegration', {
        params: { provider: 'google' },
        body: { enabled: true },
      }),
      422,
      'validation_failed',
    );
    const saved = await owner.api.call('updateCalendarIntegration', {
      params: { provider: 'google' },
      body: { enabled: true, clientId: 'g-client', clientSecret: 'g-secret-value' },
    });
    expect(saved).toMatchObject({
      enabled: true,
      hasClientSecret: true,
      redirectUri: 'http://localhost:3000/api/calendar/oauth/callback',
    });
    expect(JSON.stringify(saved)).not.toContain('g-secret-value');
    await owner.api.call('updateCalendarIntegration', {
      params: { provider: 'microsoft' },
      body: {
        enabled: true,
        clientId: 'm-client',
        clientSecret: 'm-secret',
        tenant: 'organizations',
      },
    });
    const list = await mert.api.call('listCalendarAccounts');
    expect(list).toEqual({ items: [], providers: ['google', 'microsoft'] });
  });

  it('connects Google with PKCE and mirrors its calendars and events', async () => {
    const { authorize, back } = await connect(owner, 'google');
    expect(authorize.origin + authorize.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('scope')).toContain('calendar.events');
    expect(back).toBe('http://localhost:5173/calendar?connected=google');
    const exchange = fake.calls.find((c) =>
      String(c.body).includes('grant_type=authorization_code'),
    )!;
    expect(new URLSearchParams(String(exchange.body)).get('code_verifier')).toBeTruthy();

    const accounts = await owner.api.call('listCalendarAccounts');
    expect(accounts.items).toHaveLength(1);
    expect(accounts.items[0]).toMatchObject({
      provider: 'google',
      email: 'ayse@example.com',
      status: 'active',
    });
    expect(accounts.items[0]!.calendars.map((c) => [c.name, c.writable])).toEqual([
      ['ayse@example.com', true],
      ['Türkiye tatilleri', false],
    ]);
    const [row] = await app.deps.db.select().from(calendarAccounts);
    expect(openSecret(app.env.AUTH_SECRET, row!.refreshTokenEnc)).toBe('refresh-1');

    const cals = await owner.api.call('listCalendars');
    const g = cals.items.find((c) => c.external?.provider === 'google' && c.external.writable)!;
    googleCalId = g.id;
    // Older clients see a personal calendar they cannot rename.
    expect(g).toMatchObject({
      kind: 'personal',
      isDefault: false,
      permissions: { write: true, manage: false },
    });
    expect(cals.items.find((c) => c.name === 'Türkiye tatilleri')!.permissions.write).toBe(false);
    // Nobody else sees it.
    expect((await mert.api.call('listCalendars')).items.some((c) => c.id === g.id)).toBe(false);

    const occ = (await occurrences(owner)).items.filter((o) => o.calendarId === g.id);
    expect(occ.map((o) => [o.title, o.start]).sort((x, y) => x[1]!.localeCompare(y[1]!))).toEqual([
      ['Haftalık', '2026-11-02T06:00:00.000Z'],
      ['Müşteri görüşmesi', '2026-11-05T12:00:00.000Z'],
      ['Haftalık (kaydı)', '2026-11-16T07:00:00.000Z'],
    ]);
    expect(occ.every((o) => o.provider === 'google')).toBe(true);
  });

  it('shows join links and lets the invitee answer through Google', async () => {
    const occ = (await occurrences(owner)).items.find((o) => o.title === 'Müşteri görüşmesi')!;
    const ev = await owner.api.call('getCalendarEvent', {
      params: { eventId: occ.sourceId },
      query: {},
    });
    expect(ev.external).toMatchObject({
      provider: 'google',
      joinUrl: 'https://meet.google.com/abc-defg-hij',
      organizer: { email: 'boss@example.com' },
    });
    expect(ev.myResponse).toBe('needs_action');
    expect(ev.permissions.respond).toBe(true);
    expect(ev.attendees.map((a) => a.email).sort()).toEqual([
      'ayse@example.com',
      'boss@example.com',
    ]);

    fake.respondEvent = gSingle;
    fake.googleDelta = [
      {
        ...gSingle,
        etag: '"4"',
        attendees: [gSingle.attendees[0], { ...gSingle.attendees[1], responseStatus: 'accepted' }],
      },
    ];
    const answered = await owner.api.call('respondCalendarEvent', {
      params: { eventId: ev.id },
      body: { response: 'accepted' },
    });
    expect(answered.myResponse).toBe('accepted');
    const patch = fake.last('PATCH', '/events/one-1')!;
    expect(patch.body).toMatchObject({
      attendees: [
        { email: 'boss@example.com' },
        { email: 'ayse@example.com', responseStatus: 'accepted' },
      ],
    });
  });

  it('counts mirrored events as busy for their owner', async () => {
    const fb = await mert.api.call('getCalendarFreeBusy', {
      query: { userIds: ownerId, from: '2026-11-05T00:00:00Z', to: '2026-11-06T00:00:00Z' },
    });
    expect(fb.items[0]!.busy).toEqual([
      { start: '2026-11-05T12:00:00.000Z', end: '2026-11-05T13:00:00.000Z', tentative: false },
    ]);
  });

  it('creates and changes events at Google, then shows what Google stored', async () => {
    fake.googleDelta = [
      {
        id: 'g-new',
        etag: '"5"',
        status: 'confirmed',
        summary: 'Planlama',
        start: { dateTime: '2026-11-10T08:00:00Z' },
        end: { dateTime: '2026-11-10T09:00:00Z' },
      },
    ];
    const created = await owner.api.call('createCalendarEvent', {
      body: {
        calendarId: googleCalId,
        title: 'Planlama',
        start: '2026-11-10T08:00:00Z',
        end: '2026-11-10T09:00:00Z',
        attendees: { emails: ['dis@example.com'] },
      },
    });
    expect(created).toMatchObject({ title: 'Planlama', calendar: { id: googleCalId } });
    const post = fake.last('POST', '/calendars/g-primary/events')!;
    expect(post.url.searchParams.get('sendUpdates')).toBe('all');
    expect(post.body).toMatchObject({
      summary: 'Planlama',
      start: { dateTime: '2026-11-10T08:00:00Z' },
      attendees: [{ email: 'dis@example.com' }],
    });

    // One occurrence of the series: Google's instance id is looked up, then patched.
    const weekly = (await occurrences(owner)).items.find((o) => o.title === 'Haftalık')!;
    fake.googleDelta = [
      {
        ...gMoved,
        id: 'series-1_20261102T060000Z',
        originalStartTime: { dateTime: '2026-11-02T09:00:00+03:00' },
        summary: 'İlk hafta',
      },
    ];
    await owner.api.call('updateCalendarEvent', {
      params: { eventId: weekly.seriesId! },
      body: { title: 'İlk hafta', scope: 'this', recurrenceId: weekly.recurrenceId! },
    });
    expect(
      fake.last('GET', '/events/series-1/instances')!.url.searchParams.get('originalStart'),
    ).toBe('2026-11-02T06:00:00.000Z');
    expect(fake.last('PATCH', '/events/series-1_20261116T060000Z')!.body).toEqual({
      summary: 'İlk hafta',
    });

    // This-and-following is not something Crewhall can do on a mirrored series.
    await expectCode(
      owner.api.call('updateCalendarEvent', {
        params: { eventId: weekly.seriesId! },
        body: { title: 'x', scope: 'following', recurrenceId: weekly.recurrenceId! },
      }),
      409,
      'calendar_external_unsupported',
    );
    // Nor can an .ics be imported into it.
    await expectCode(
      owner.api.call('importCalendarIcs', {
        params: { calendarId: googleCalId },
        body: { ics: 'BEGIN:VCALENDAR' },
      }),
      409,
      'calendar_external_unsupported',
    );
  });

  it('starts over when Google expires the sync token, and forgets deleted events', async () => {
    const [acc] = await app.deps.db
      .select()
      .from(calendarAccounts)
      .where(eq(calendarAccounts.provider, 'google'));
    fake.googleGone = true;
    fake.googleFull = [gSeries, gMoved, gCancelled];
    await syncAccount(app.deps, acc!.id);
    const titles = (await occurrences(owner)).items
      .filter((o) => o.calendarId === googleCalId)
      .map((o) => o.title)
      .sort();
    expect(titles).toEqual(['Haftalık', 'Haftalık (kaydı)']);
  });

  it('connects Microsoft and keeps Outlook occurrences one by one', async () => {
    fake.graphPages.set('first', {
      value: [
        {
          id: 'm-occ-1',
          changeKey: 'k1',
          subject: 'Sprint planlama',
          start: { dateTime: '2026-11-03T07:00:00.0000000', timeZone: 'UTC' },
          end: { dateTime: '2026-11-03T08:00:00.0000000', timeZone: 'UTC' },
          originalStartTimeZone: 'Turkey Standard Time',
          type: 'occurrence',
          seriesMasterId: 'm-master',
          showAs: 'busy',
          responseStatus: { response: 'notResponded' },
          organizer: { emailAddress: { address: 'lead@contoso.com', name: 'Lead' } },
          attendees: [
            {
              emailAddress: { address: 'mert@contoso.com', name: 'Mert' },
              status: { response: 'none' },
              type: 'required',
            },
          ],
          onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/1' },
        },
      ],
      next: `${GRAPH}/page-2`,
    });
    fake.graphPages.set(`${GRAPH}/page-2`, {
      value: [
        {
          id: 'm-all-day',
          changeKey: 'k2',
          subject: 'İzin',
          isAllDay: true,
          start: { dateTime: '2026-11-20T00:00:00.0000000', timeZone: 'UTC' },
          end: { dateTime: '2026-11-21T00:00:00.0000000', timeZone: 'UTC' },
          showAs: 'oof',
          type: 'singleInstance',
        },
      ],
      delta: `${GRAPH}/delta-1`,
    });
    const { authorize, back } = await connect(mert, 'microsoft');
    expect(authorize.origin + authorize.pathname).toBe(
      'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize',
    );
    expect(back).toBe('http://localhost:5173/calendar?connected=microsoft');

    const occ = (await occurrences(mert)).items.filter((o) => o.provider === 'microsoft');
    expect(occ.map((o) => [o.title, o.start, o.allDay])).toEqual([
      ['Sprint planlama', '2026-11-03T07:00:00.000Z', false],
      ['İzin', '2026-11-20', true],
    ]);
    const ev = await mert.api.call('getCalendarEvent', {
      params: { eventId: occ[0]!.sourceId },
      query: {},
    });
    expect(ev.external).toMatchObject({
      provider: 'microsoft',
      joinUrl: 'https://teams.microsoft.com/l/meetup-join/1',
      occurrenceOnly: true,
    });
    expect(ev.timeZone).toBe('Europe/Istanbul');

    // The answer goes to the series master.
    fake.graphDelta = { value: [], delta: `${GRAPH}/delta-2` };
    await mert.api.call('respondCalendarEvent', {
      params: { eventId: ev.id },
      body: { response: 'tentative' },
    });
    expect(fake.last('POST', '/me/events/m-master/tentativelyAccept')!.body).toEqual({
      sendResponse: true,
    });

    // Removed in Outlook: gone here on the next delta.
    fake.graphDelta = {
      value: [{ id: 'm-all-day', '@removed': { reason: 'deleted' } }],
      delta: `${GRAPH}/delta-3`,
    };
    const [acc] = await app.deps.db
      .select()
      .from(calendarAccounts)
      .where(eq(calendarAccounts.provider, 'microsoft'));
    await syncAccount(app.deps, acc!.id);
    expect(
      (await occurrences(mert)).items.filter((o) => o.provider === 'microsoft').map((o) => o.title),
    ).toEqual(['Sprint planlama']);
    const [cal] = await app.deps.db
      .select()
      .from(calendars)
      .where(eq(calendars.accountId, acc!.id));
    expect(cal!.syncState).toMatchObject({ cursor: `${GRAPH}/delta-3` });
  });

  it('creates a recurring Outlook event with its pattern', async () => {
    const cal = (await mert.api.call('listCalendars')).items.find(
      (c) => c.external?.provider === 'microsoft',
    )!;
    fake.graphDelta = {
      value: [
        {
          id: 'm-new-occ',
          subject: 'Standup',
          start: { dateTime: '2026-11-09T06:30:00.0000000', timeZone: 'UTC' },
          end: { dateTime: '2026-11-09T06:45:00.0000000', timeZone: 'UTC' },
          type: 'occurrence',
          seriesMasterId: 'm-new',
        },
      ],
      delta: `${GRAPH}/delta-4`,
    };
    const created = await mert.api.call('createCalendarEvent', {
      body: {
        calendarId: cal.id,
        title: 'Standup',
        start: '2026-11-09T06:30:00Z',
        end: '2026-11-09T06:45:00Z',
        timeZone: 'Europe/Istanbul',
        rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
      },
    });
    expect(created.title).toBe('Standup');
    expect(fake.last('POST', '/me/calendars/m-cal/events')!.body).toMatchObject({
      subject: 'Standup',
      start: { dateTime: '2026-11-09T09:30:00', timeZone: 'Europe/Istanbul' },
      recurrence: {
        pattern: {
          type: 'weekly',
          daysOfWeek: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
        },
        range: { type: 'noEnd', startDate: '2026-11-09' },
      },
    });
  });

  it('marks an account revoked when the provider withdraws access', async () => {
    const [acc] = await app.deps.db
      .select()
      .from(calendarAccounts)
      .where(eq(calendarAccounts.provider, 'microsoft'));
    await app.deps.db
      .update(calendarAccounts)
      .set({ accessExpiresAt: new Date(0) })
      .where(eq(calendarAccounts.id, acc!.id));
    fake.refreshFails = true;
    const out = await mert.api.call('syncCalendarAccount', { params: { accountId: acc!.id } });
    fake.refreshFails = false;
    expect(out).toMatchObject({ status: 'revoked', lastError: 'calendar_account_revoked' });
  });

  it('disconnecting removes the mirrored calendars and their events', async () => {
    const accounts = await owner.api.call('listCalendarAccounts');
    await expectCode(
      mert.api.call('deleteCalendarAccount', { params: { accountId: accounts.items[0]!.id } }),
      404,
    );
    await owner.api.call('deleteCalendarAccount', { params: { accountId: accounts.items[0]!.id } });
    expect((await owner.api.call('listCalendarAccounts')).items).toEqual([]);
    expect((await owner.api.call('listCalendars')).items.some((c) => c.external)).toBe(false);
    const left = await app.deps.db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.calendarId, googleCalId));
    expect(left).toEqual([]);
  });
});
