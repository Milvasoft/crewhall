import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { automationRuns, meetings, notifications } from '@crewhall/db';
import { ApiError } from '@crewhall/api-client';
import type { CalendarOccurrence } from '@crewhall/shared';
import { invalidateModules } from '../src/services/identity/modules';
import { sendReminders } from '../src/services/calendar/reminders';
import { buildIcs, buildVtimezone, parseIcs } from '../src/services/calendar/ics';
import { parseXml } from '../src/services/calendar/xml';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/** Calendar module (roadmap 14): calendars, events, series, invitations, linked sources, CalDAV. */

describe('calendar ics and xml', () => {
  it('reads Outlook zones, durations, alarms and overrides', () => {
    const text = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:abc-1',
      'DTSTART;TZID=Turkey Standard Time:20261022T090000',
      'DURATION:PT1H30M',
      'RRULE:FREQ=WEEKLY;COUNT=4',
      'EXDATE;TZID=Turkey Standard Time:20261029T090000',
      'SUMMARY:Haftalık\\, plan',
      'ATTENDEE;CN="Ayşe";PARTSTAT=ACCEPTED:mailto:AYSE@example.com',
      'BEGIN:VALARM',
      'TRIGGER:-PT15M',
      'ACTION:DISPLAY',
      'END:VALARM',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:abc-1',
      'RECURRENCE-ID;TZID=Europe/Istanbul:20261105T090000',
      'DTSTART;TZID=Europe/Istanbul:20261105T110000',
      'DTEND;TZID=Europe/Istanbul:20261105T120000',
      'SUMMARY:Kaydırıldı',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const r = parseIcs(text, 'UTC')!;
    expect(r.errors).toEqual([]);
    const [master, override] = r.events;
    expect(master!.timeZone).toBe('Europe/Istanbul');
    expect((master!.start as Date).toISOString()).toBe('2026-10-22T06:00:00.000Z');
    expect((master!.end as Date).toISOString()).toBe('2026-10-22T07:30:00.000Z');
    expect(master!.title).toBe('Haftalık, plan');
    expect(master!.exdates).toEqual(['2026-10-29T06:00:00.000Z']);
    expect(master!.reminders).toEqual([15]);
    expect(master!.attendees[0]).toMatchObject({ email: 'ayse@example.com', partstat: 'accepted' });
    expect(override!.recurrenceId).toBe('2026-11-05T06:00:00.000Z');
  });

  it('writes zones with their DST rules', () => {
    const berlin = buildVtimezone('Europe/Berlin', 2026).join('\n');
    expect(berlin).toContain('RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU');
    expect(berlin).toContain('RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU');
    expect(berlin).toContain('TZOFFSETTO:+0200');
    const ist = buildVtimezone('Europe/Istanbul', 2026).join('\n');
    expect(ist).toContain('TZOFFSETTO:+0300');
    expect(ist).not.toContain('DAYLIGHT');
    const ics = buildIcs({
      events: [
        {
          uid: 'x@test',
          recurrenceId: null,
          title:
            'Uzun bir başlık, virgüllü; noktalı virgüllü ve çok uzun olduğu için katlanacak satır',
          description: null,
          location: null,
          allDay: false,
          start: new Date('2026-07-01T07:00:00Z'),
          end: new Date('2026-07-01T08:00:00Z'),
          timeZone: 'Europe/Berlin',
          rrule: 'FREQ=DAILY;COUNT=2',
          exdates: [],
          status: 'confirmed',
          busy: true,
          visibility: 'default',
          sequence: 0,
          reminders: [10],
          organizer: null,
          attendees: [],
          created: new Date(),
          updated: new Date(),
        },
      ],
    });
    expect(ics).toContain('DTSTART;TZID=Europe/Berlin:20260701T090000');
    const back = parseIcs(ics, 'UTC')!;
    expect(back.events[0]!.title).toContain('virgüllü; noktalı');
    expect((back.events[0]!.start as Date).toISOString()).toBe('2026-07-01T07:00:00.000Z');
  });

  it('parses namespaced DAV bodies and refuses DOCTYPEs', () => {
    const el = parseXml(
      '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/"><d:prop><d:displayname/><cs:getctag/></d:prop></d:propfind>',
    )!;
    expect(el).toMatchObject({ ns: 'DAV:', name: 'propfind' });
    expect(el.children[0]!.children.map((c) => [c.ns, c.name])).toEqual([
      ['DAV:', 'displayname'],
      ['http://calendarserver.org/ns/', 'getctag'],
    ]);
    expect(parseXml('<!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>')).toBeNull();
    expect(parseXml('<a><b></a>')).toBeNull();
  });
});

describe('calendar module', () => {
  let app: TestApp;
  let owner: Client;
  let mert: Client;
  let mertId: string;
  let ownerId: string;
  let sharedId: string;
  let personalCalId: string;

  const range = (from: string, to: string, extra: Record<string, string> = {}) =>
    owner.api.call('listCalendarOccurrences', { query: { from, to, ...extra } });

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

  beforeAll(async () => {
    app = await createTestApp();
    const setup = await setupWithOwner(app);
    owner = setup.owner;
    ownerId = setup.ownerId;
    const spaces = await owner.api.call('listSpaces');
    sharedId = spaces.items.find((s) => s.name === 'Milvasoft')!.id;
    const joined = await join(app, owner, 'mert@milvasoft.com', 'member', [sharedId]);
    mert = joined.person;
    mertId = joined.me.user.id;
    await owner.api.call('updateCalendarSettings', { body: { timeZone: 'Europe/Istanbul' } });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('creates personal and space calendars on first use', async () => {
    const { items } = await owner.api.call('listCalendars');
    const personal = items.find((c) => c.kind === 'personal')!;
    expect(personal).toMatchObject({ isDefault: true, myRole: 'owner' });
    personalCalId = personal.id;
    const spaceCals = items.filter((c) => c.kind === 'space');
    expect(spaceCals.map((c) => c.name).sort()).toEqual(['Altyapı', 'Milvasoft']);
    expect(spaceCals.every((c) => c.permissions.write && !c.permissions.manage)).toBe(true);
    const mine = await mert.api.call('listCalendars');
    expect(mine.items.map((c) => c.kind).sort()).toEqual(['personal', 'space']);
    expect(mine.items.find((c) => c.kind === 'personal')!.id).not.toBe(personalCalId);
  });

  it('keeps wall-clock times and all-day dates', async () => {
    const timed = await owner.api.call('createCalendarEvent', {
      body: {
        calendarId: personalCalId,
        title: 'Planlama',
        start: '2026-11-02T07:00:00.000Z',
        end: '2026-11-02T08:00:00.000Z',
      },
    });
    expect(timed).toMatchObject({ timeZone: 'Europe/Istanbul', allDay: false, reminders: [10] });
    const allDay = await owner.api.call('createCalendarEvent', {
      body: {
        calendarId: personalCalId,
        title: 'Cumhuriyet Bayramı',
        allDay: true,
        start: '2026-10-29',
        end: '2026-10-30',
      },
    });
    expect(allDay).toMatchObject({ start: '2026-10-29', end: '2026-10-30' });
    const { items } = await range('2026-10-26T00:00:00Z', '2026-11-09T00:00:00Z');
    const titles = items.filter((i) => i.source === 'event').map((i) => [i.title, i.start]);
    expect(titles).toEqual([
      ['Cumhuriyet Bayramı', '2026-10-29'],
      ['Planlama', '2026-11-02T07:00:00.000Z'],
    ]);
  });

  it('switches an event between timed and all-day (drag between the grid and the all-day row)', async () => {
    const ev = await owner.api.call('createCalendarEvent', {
      body: {
        calendarId: personalCalId,
        title: 'Sürüklenen',
        start: '2026-11-04T08:00:00.000Z',
        end: '2026-11-04T09:00:00.000Z',
      },
    });
    const allDay = await owner.api.call('updateCalendarEvent', {
      params: { eventId: ev.id },
      body: { allDay: true, start: '2026-11-05', end: '2026-11-06' },
    });
    expect(allDay).toMatchObject({ allDay: true, start: '2026-11-05', end: '2026-11-06' });
    const timed = await owner.api.call('updateCalendarEvent', {
      params: { eventId: ev.id },
      body: { allDay: false, start: '2026-11-05T07:00:00.000Z', end: '2026-11-05T08:00:00.000Z' },
    });
    expect(timed).toMatchObject({ allDay: false, start: '2026-11-05T07:00:00.000Z' });
    await owner.api.call('deleteCalendarEvent', { params: { eventId: ev.id }, query: {} });
  });

  it('edits a series: one occurrence, the rest, all of it, and deletes one', async () => {
    const series = await owner.api.call('createCalendarEvent', {
      body: {
        calendarId: personalCalId,
        title: 'Daily',
        start: '2026-12-01T06:30:00.000Z',
        end: '2026-12-01T06:45:00.000Z',
        rrule: 'FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR',
      },
    });
    const week = () =>
      range('2026-12-01T00:00:00Z', '2026-12-08T00:00:00Z').then((r) =>
        r.items.filter((i) => i.title.startsWith('Daily') || i.seriesId === series.id),
      );
    // Tue 1 … Mon 7: Tue, Wed, Thu, Fri, Mon.
    expect((await week()).length).toBe(5);

    // Only Wednesday moves an hour later.
    const moved = await owner.api.call('updateCalendarEvent', {
      params: { eventId: series.id },
      body: {
        scope: 'this',
        recurrenceId: '2026-12-02T06:30:00.000Z',
        start: '2026-12-02T07:30:00.000Z',
        end: '2026-12-02T07:45:00.000Z',
        title: 'Daily (geç)',
      },
    });
    expect(moved).toMatchObject({ seriesId: series.id, recurrenceId: '2026-12-02T06:30:00.000Z' });
    // Thursday is removed.
    await owner.api.call('deleteCalendarEvent', {
      params: { eventId: series.id },
      query: { scope: 'this', recurrenceId: '2026-12-03T06:30:00.000Z' },
    });
    let items = await week();
    expect(items.map((i) => [i.title, i.start])).toEqual([
      ['Daily', '2026-12-01T06:30:00.000Z'],
      ['Daily (geç)', '2026-12-02T07:30:00.000Z'],
      ['Daily', '2026-12-04T06:30:00.000Z'],
      ['Daily', '2026-12-07T06:30:00.000Z'],
    ]);

    // From Friday on the meeting is called "Stand-up".
    const rest = await owner.api.call('updateCalendarEvent', {
      params: { eventId: series.id },
      body: { scope: 'following', recurrenceId: '2026-12-04T06:30:00.000Z', title: 'Stand-up' },
    });
    expect(rest.id).not.toBe(series.id);
    expect(rest.rrule).toBe('FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR');
    const after = await range('2026-12-01T00:00:00Z', '2026-12-08T00:00:00Z');
    const named = after.items
      .filter((i) => i.seriesId === series.id || i.seriesId === rest.id)
      .map((i) => [i.title, i.start.slice(0, 10)]);
    expect(named).toEqual([
      ['Daily', '2026-12-01'],
      ['Daily (geç)', '2026-12-02'],
      ['Stand-up', '2026-12-04'],
      ['Stand-up', '2026-12-07'],
    ]);

    // Dragging Monday's stand-up 30 minutes later moves the whole new series.
    await owner.api.call('updateCalendarEvent', {
      params: { eventId: rest.id },
      body: {
        scope: 'all',
        recurrenceId: '2026-12-07T06:30:00.000Z',
        start: '2026-12-07T07:00:00.000Z',
        end: '2026-12-07T07:15:00.000Z',
      },
    });
    items = (await range('2026-12-04T00:00:00Z', '2026-12-09T00:00:00Z')).items.filter(
      (i) => i.seriesId === rest.id,
    );
    expect(items.map((i) => i.start)).toEqual([
      '2026-12-04T07:00:00.000Z',
      '2026-12-07T07:00:00.000Z',
      '2026-12-08T07:00:00.000Z',
    ]);
    await expectCode(
      owner.api.call('getCalendarEvent', {
        params: { eventId: rest.id },
        query: { recurrenceId: '2026-12-05T07:00:00.000Z' },
      }),
      404,
      'calendar_occurrence_unknown',
    );
    const occ = await owner.api.call('getCalendarEvent', {
      params: { eventId: rest.id },
      query: { recurrenceId: '2026-12-08T07:00:00.000Z' },
    });
    expect(occ).toMatchObject({
      start: '2026-12-08T07:00:00.000Z',
      recurrenceId: occ.recurrenceId,
    });
  });

  it('invites people, answers and shows availability', async () => {
    app.mailer.outbox.length = 0;
    const ev = await owner.api.call('createCalendarEvent', {
      body: {
        calendarId: personalCalId,
        title: 'Müşteri görüşmesi',
        location: 'Toplantı odası 2',
        start: '2026-11-10T11:00:00.000Z',
        end: '2026-11-10T12:00:00.000Z',
        attendees: { userIds: [mertId], emails: ['musteri@example.com'] },
      },
    });
    expect(ev.attendees.map((a) => [a.email, a.response, a.user?.id ?? null])).toEqual([
      ['mert@milvasoft.com', 'needs_action', mertId],
      ['musteri@example.com', 'needs_action', null],
    ]);
    const mail = app.mailer.outbox.find((m) => m.to === 'musteri@example.com')!;
    expect(mail.icalEvent?.method).toBe('REQUEST');
    expect(mail.icalEvent?.content).toContain('ATTENDEE');
    const [invite] = await app.deps.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, mertId), eq(notifications.type, 'calendar.invited')));
    expect(invite).toMatchObject({ targetType: 'event', targetId: ev.id });

    // Mert sees it in his own views and answers.
    const his = await mert.api.call('listCalendarOccurrences', {
      query: { from: '2026-11-10T00:00:00Z', to: '2026-11-11T00:00:00Z' },
    });
    const seen = his.items.find((i) => i.sourceId === ev.id)!;
    expect(seen).toMatchObject({ myResponse: 'needs_action', editable: false });
    await expectCode(
      mert.api.call('updateCalendarEvent', { params: { eventId: ev.id }, body: { title: 'x' } }),
      403,
      'calendar_read_only',
    );
    const answered = await mert.api.call('respondCalendarEvent', {
      params: { eventId: ev.id },
      body: { response: 'accepted' },
    });
    expect(answered.myResponse).toBe('accepted');
    const [reply] = await app.deps.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, ownerId), eq(notifications.type, 'calendar.response')));
    expect(reply).toBeTruthy();

    // Availability: times only.
    const fb = await owner.api.call('getCalendarFreeBusy', {
      query: { userIds: mertId, from: '2026-11-10T00:00:00Z', to: '2026-11-11T00:00:00Z' },
    });
    expect(fb.items[0]!.busy).toEqual([
      { start: '2026-11-10T11:00:00.000Z', end: '2026-11-10T12:00:00.000Z', tentative: false },
    ]);

    // Removing the outside guest mails a cancellation.
    app.mailer.outbox.length = 0;
    await owner.api.call('updateCalendarEvent', {
      params: { eventId: ev.id },
      body: { attendees: { userIds: [mertId], emails: [] } },
    });
    expect(app.mailer.outbox.find((m) => m.to === 'musteri@example.com')?.icalEvent?.method).toBe(
      'CANCEL',
    );
  });

  it('shares team calendars by role and follows space roles', async () => {
    const team = await owner.api.call('createCalendar', {
      body: { name: 'Destek nöbeti', color: 's3', members: [{ userId: mertId, role: 'viewer' }] },
    });
    expect(team).toMatchObject({ kind: 'team', myRole: 'owner', memberCount: 2 });
    await expectCode(
      mert.api.call('createCalendarEvent', {
        body: {
          calendarId: team.id,
          title: 'Nöbet',
          allDay: true,
          start: '2026-11-16',
          end: '2026-11-21',
        },
      }),
      403,
      'calendar_read_only',
    );
    await owner.api.call('setCalendarMember', {
      params: { calendarId: team.id, userId: mertId },
      body: { role: 'editor' },
    });
    await mert.api.call('createCalendarEvent', {
      body: {
        calendarId: team.id,
        title: 'Nöbet',
        allDay: true,
        start: '2026-11-16',
        end: '2026-11-21',
      },
    });
    await expectCode(
      owner.api.call('removeCalendarMember', { params: { calendarId: team.id, userId: ownerId } }),
      409,
      'calendar_last_owner',
    );
    const members = await owner.api.call('listCalendarMembers', {
      params: { calendarId: team.id },
    });
    expect(members.items.map((m) => m.role)).toEqual(['owner', 'editor']);

    // Space calendar: Mert is a viewer of Milvasoft (the invitation's role) and of nothing else.
    const cals = await mert.api.call('listCalendars');
    const spaceCal = cals.items.find((c) => c.kind === 'space')!;
    expect(spaceCal).toMatchObject({ myRole: 'viewer', permissions: { write: false } });
    const sprint = {
      calendarId: spaceCal.id,
      title: 'Sprint demo',
      start: '2026-11-13T12:00:00.000Z',
      end: '2026-11-13T13:00:00.000Z',
    };
    await expectCode(
      mert.api.call('createCalendarEvent', { body: sprint }),
      403,
      'calendar_read_only',
    );
    const ev = await owner.api.call('createCalendarEvent', { body: sprint });
    const mertView = await mert.api.call('listCalendarOccurrences', {
      query: { from: '2026-11-13T00:00:00Z', to: '2026-11-14T00:00:00Z', spaceId: sharedId },
    });
    expect(mertView.items.find((i) => i.sourceId === ev.id)).toMatchObject({ editable: false });
    const altyapi = (await owner.api.call('listCalendars')).items.find(
      (c) => c.name === 'Altyapı',
    )!;
    await expectCode(
      mert.api.call('createCalendarEvent', {
        body: {
          calendarId: altyapi.id,
          title: 'x',
          start: '2026-11-13T12:00:00.000Z',
          end: '2026-11-13T13:00:00.000Z',
        },
      }),
      404,
    );
    await owner.api.call('deleteCalendar', { params: { calendarId: team.id } });
    await expectCode(
      owner.api.call('deleteCalendar', { params: { calendarId: personalCalId } }),
      409,
      'calendar_not_team',
    );
  });

  it('shows scheduled meetings and card due dates as linked items', async () => {
    const meeting = await owner.api.call('createMeeting', {
      body: {
        mode: 'scheduled',
        title: 'Haftalık değerlendirme',
        spaceId: sharedId,
        startsAt: '2026-11-17T10:00:00.000Z',
        durationMinutes: 30,
        recurrence: 'weekly',
        invitees: { userIds: [], emails: [] },
        settings: { guestsAllowed: false, lobby: true, autoRecord: false },
      },
    });
    const board = await owner.api.call('createBoard', {
      params: { spaceId: sharedId },
      body: { name: 'Sürüm', template: 'empty', key: 'SRM' },
    });
    const full = await owner.api.call('getBoard', { params: { boardId: board.id } });
    await owner.api.call('createBoardCard', {
      params: { boardId: board.id },
      body: {
        columnId: full.columns[0]!.id,
        title: 'Sürüm notları',
        dueAt: '2026-11-18T15:00:00.000Z',
      },
    });
    const { items } = await range('2026-11-16T00:00:00Z', '2026-11-30T00:00:00Z');
    const linked = items.filter((i) => i.source !== 'event');
    expect(linked.filter((i) => i.source === 'meeting').map((i) => i.start)).toEqual([
      '2026-11-17T10:00:00.000Z',
      '2026-11-24T10:00:00.000Z',
    ]);
    const card = linked.find((i) => i.source === 'card')!;
    // A due date is a day: all-day on the owner's local date (Istanbul: 18:00 the same day).
    expect(card).toMatchObject({
      title: 'SRM-1 · Sürüm notları',
      // The owner edits the board: the due date moves by drag in the calendar.
      editable: true,
      allDay: true,
      start: '2026-11-18',
      end: '2026-11-19',
    });
    expect(card.url).toMatch(/^\/b\/.+\/SRM-1$/);
    // Mert only views the space: the card is shown, not movable.
    const his = await mert.api.call('listCalendarOccurrences', {
      query: { from: '2026-11-16T00:00:00Z', to: '2026-11-30T00:00:00Z', spaceId: sharedId },
    });
    expect(his.items.find((i) => i.source === 'card')).toMatchObject({ editable: false });
    expect(linked.find((i) => i.source === 'meeting')!.url).toBe(
      `/meetings/room/${meeting.slug}`,
    );
    // Hidden in settings: gone.
    await owner.api.call('updateCalendarSettings', { body: { showCards: false } });
    const without = await range('2026-11-16T00:00:00Z', '2026-11-30T00:00:00Z');
    expect(without.items.some((i: CalendarOccurrence) => i.source === 'card')).toBe(false);
    await owner.api.call('updateCalendarSettings', { body: { showCards: true } });
  });

  it('sends each reminder once', async () => {
    const start = new Date(Date.now() + 9 * 60_000);
    start.setUTCSeconds(0, 0);
    const ev = await owner.api.call('createCalendarEvent', {
      body: {
        calendarId: personalCalId,
        title: 'Hatırlat',
        start: start.toISOString(),
        end: new Date(start.getTime() + 30 * 60_000).toISOString(),
        reminders: [10],
        attendees: { userIds: [mertId], emails: [] },
      },
    });
    await sendReminders(app.deps);
    await sendReminders(app.deps);
    const rows = await app.deps.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.type, 'calendar.reminder'), eq(notifications.targetId, ev.id)));
    expect(rows.map((r) => r.userId).sort()).toEqual([ownerId, mertId].sort());
  });

  it('fires the "event upcoming" automation trigger once per occurrence', async () => {
    const rule = await owner.api.call('createAutomationRule', {
      params: { spaceId: sharedId },
      body: {
        name: 'Etkinlik hatırlat',
        trigger: { type: 'calendar.event_upcoming', config: { minutesBefore: 30 } },
        actions: [
          {
            id: 'a1',
            type: 'notify.users',
            config: { userIds: [mertId], text: '{{event.title}}' },
          },
        ],
      },
    });
    const cal = (await owner.api.call('listCalendars')).items.find((c) => c.spaceId === sharedId)!;
    const start = new Date(Date.now() + 29 * 60_000);
    start.setUTCSeconds(0, 0);
    await owner.api.call('createCalendarEvent', {
      body: {
        calendarId: cal.id,
        title: 'Space toplantısı',
        start: start.toISOString(),
        end: new Date(start.getTime() + 3_600_000).toISOString(),
        reminders: [],
      },
    });
    // A personal event never fires a space rule.
    await owner.api.call('createCalendarEvent', {
      body: {
        calendarId: personalCalId,
        title: 'Kişisel',
        start: start.toISOString(),
        end: new Date(start.getTime() + 3_600_000).toISOString(),
      },
    });
    await sendReminders(app.deps);
    await sendReminders(app.deps);
    const runs = await app.deps.db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.ruleId, rule.id));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.event).toMatchObject({
      event: { title: 'Space toplantısı' },
      minutesBefore: 30,
    });
    await owner.api.call('deleteAutomationRule', { params: { ruleId: rule.id } });
  });

  it('lets moderators move one-off meetings, not series or other people', async () => {
    const once = await owner.api.call('createMeeting', {
      body: {
        mode: 'scheduled',
        title: 'Bütçe görüşmesi',
        spaceId: sharedId,
        startsAt: '2026-12-01T09:00:00.000Z',
        durationMinutes: 45,
        recurrence: 'none',
        invitees: { userIds: [], emails: [] },
        settings: { guestsAllowed: false, lobby: true, autoRecord: false },
      },
    });
    const weekly = await owner.api.call('createMeeting', {
      body: {
        mode: 'scheduled',
        title: 'Haftalık bütçe',
        spaceId: sharedId,
        startsAt: '2026-12-02T09:00:00.000Z',
        durationMinutes: 30,
        recurrence: 'weekly',
        invitees: { userIds: [], emails: [] },
        settings: { guestsAllowed: false, lobby: true, autoRecord: false },
      },
    });
    const query = { from: '2026-11-30T00:00:00Z', to: '2026-12-07T00:00:00Z', spaceId: sharedId };
    const mine = await owner.api.call('listCalendarOccurrences', { query });
    const of = (items: CalendarOccurrence[], id: string) => items.find((i) => i.sourceId === id);
    expect(of(mine.items, once.id)).toMatchObject({ source: 'meeting', editable: true });
    expect(of(mine.items, weekly.id)).toMatchObject({ editable: false });
    // Mert only views the space: he sees the meeting, he does not move it.
    const his = await mert.api.call('listCalendarOccurrences', { query });
    expect(of(his.items, once.id)).toMatchObject({ editable: false });
    // A drop in the calendar is a time change of the meeting.
    await owner.api.call('updateMeeting', {
      params: { meetingId: once.id },
      body: { startsAt: '2026-12-01T11:30:00.000Z', durationMinutes: 60 },
    });
    const moved = await owner.api.call('listCalendarOccurrences', { query });
    expect(of(moved.items, once.id)).toMatchObject({
      start: '2026-12-01T11:30:00.000Z',
      end: '2026-12-01T12:30:00.000Z',
    });
    await owner.api.call('cancelMeeting', { params: { meetingId: once.id } });
    await owner.api.call('cancelMeeting', { params: { meetingId: weekly.id } });
  });

  it('adds a Crewhall meeting to an event and keeps it in step', async () => {
    app.mailer.outbox.length = 0;
    const ev = await owner.api.call('createCalendarEvent', {
      body: {
        calendarId: personalCalId,
        title: 'Teklif görüşmesi',
        start: '2026-11-25T10:00:00.000Z',
        end: '2026-11-25T10:45:00.000Z',
        onlineMeeting: true,
        attendees: { userIds: [], emails: ['alici@example.com'] },
      },
    });
    expect(ev.meeting?.url).toMatch(/\/m\//);
    const [m] = await app.deps.db.select().from(meetings).where(eq(meetings.id, ev.meeting!.id));
    expect(m).toMatchObject({ kind: 'scheduled', durationMinutes: 45, title: 'Teklif görüşmesi' });
    expect(m!.settings.guestsAllowed).toBe(true);
    const mail = app.mailer.outbox.find((x) => x.to === 'alici@example.com')!;
    expect(mail.text).toContain(ev.meeting!.url);
    expect(mail.icalEvent?.content).toContain(`URL:${ev.meeting!.url}`);
    // One item in the views: the event, opening the room; the meeting is not listed twice.
    const { items } = await range('2026-11-25T00:00:00Z', '2026-11-26T00:00:00Z');
    expect(items.filter((i) => i.title === 'Teklif görüşmesi')).toEqual([
      expect.objectContaining({ source: 'event', url: `/meetings/room/${ev.meeting!.slug}` }),
    ]);
    // Moving the event moves the meeting; removing the switch cancels it.
    await owner.api.call('updateCalendarEvent', {
      params: { eventId: ev.id },
      body: { start: '2026-11-25T12:00:00.000Z', end: '2026-11-25T13:00:00.000Z' },
    });
    const [moved] = await app.deps.db
      .select()
      .from(meetings)
      .where(eq(meetings.id, ev.meeting!.id));
    expect(moved).toMatchObject({ durationMinutes: 60 });
    expect(moved!.startsAt?.toISOString()).toBe('2026-11-25T12:00:00.000Z');
    const off = await owner.api.call('updateCalendarEvent', {
      params: { eventId: ev.id },
      body: { onlineMeeting: false },
    });
    expect(off.meeting).toBeNull();
    const [gone] = await app.deps.db.select().from(meetings).where(eq(meetings.id, ev.meeting!.id));
    expect(gone!.cancelledAt).not.toBeNull();
    await expectCode(
      owner.api.call('createCalendarEvent', {
        body: {
          calendarId: personalCalId,
          title: 'x',
          allDay: true,
          start: '2026-11-25',
          end: '2026-11-26',
          onlineMeeting: true,
        },
      }),
      422,
    );
  });

  it('imports and exports .ics', async () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:imported-1@example.com',
      'DTSTART;VALUE=DATE:20261201',
      'DTEND;VALUE=DATE:20261202',
      'SUMMARY:İçe aktarılan',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:broken@example.com',
      'DTSTART:20261201T100000Z',
      'RRULE:FREQ=HOURLY',
      'SUMMARY:Desteklenmeyen',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const r = await owner.api.call('importCalendarIcs', {
      params: { calendarId: personalCalId },
      body: { ics },
    });
    expect(r).toMatchObject({ created: 1, updated: 0 });
    expect(r.errors).toEqual([{ uid: 'broken@example.com', reason: 'unsupported_rrule' }]);
    const again = await owner.api.call('importCalendarIcs', {
      params: { calendarId: personalCalId },
      body: { ics },
    });
    expect(again).toMatchObject({ created: 0, updated: 1 });
    await expectCode(
      owner.api.call('importCalendarIcs', {
        params: { calendarId: personalCalId },
        body: { ics: 'hello' },
      }),
      422,
      'calendar_ics_invalid',
    );
    const res = await owner.fetch(
      `http://localhost:3000/api/v1/calendar/calendars/${personalCalId}/export.ics`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/calendar');
    const text = await res.text();
    expect(text).toContain('UID:imported-1@example.com');
    expect(text).toContain('SUMMARY:Daily');
    expect(text).toContain('BEGIN:VTIMEZONE');
  });

  describe('CalDAV', () => {
    let token: string;
    let readOnly: string;
    const dav = (
      method: string,
      path: string,
      body?: string,
      headers: Record<string, string> = {},
      t = token,
    ) =>
      app.app.request(`http://localhost:3000${path}`, {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`bugra@milvasoft.com:${t}`).toString('base64')}`,
          ...(body ? { 'Content-Type': 'application/xml' } : {}),
          ...headers,
        },
        body,
      });

    beforeAll(async () => {
      token = (
        await owner.api.call('createMcpToken', {
          body: {
            name: 'Takvim',
            scopes: ['hub:read', 'calendar:write'],
            spaceIds: null,
            expiresInDays: 30,
          },
        })
      ).value;
      readOnly = (
        await owner.api.call('createMcpToken', {
          body: { name: 'Okuma', scopes: ['hub:read'], spaceIds: null, expiresInDays: 30 },
        })
      ).value;
    });

    it('refuses requests without a token', async () => {
      const res = await app.app.request('http://localhost:3000/caldav/', { method: 'PROPFIND' });
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain('Basic');
      const wrong = await dav('PROPFIND', '/caldav/', undefined, {}, 'mhp_wrong');
      expect(wrong.status).toBe(401);
    });

    it('discovers the principal, home and calendars', async () => {
      const root = await dav(
        'PROPFIND',
        '/caldav/',
        '<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>',
        { Depth: '0' },
      );
      expect(root.status).toBe(207);
      expect(await root.text()).toContain('<D:href>/caldav/principals/me/</D:href>');
      const principal = await dav(
        'PROPFIND',
        '/caldav/principals/me/',
        '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/><d:unknown-prop/></d:prop></d:propfind>',
        { Depth: '0' },
      );
      const ptext = await principal.text();
      expect(ptext).toContain('/caldav/calendars/');
      expect(ptext).toContain('404 Not Found');
      const home = await dav(
        'PROPFIND',
        '/caldav/calendars/',
        '<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/"><d:prop><d:displayname/><d:resourcetype/><cs:getctag/></d:prop></d:propfind>',
        { Depth: '1' },
      );
      const htext = await home.text();
      expect(htext).toContain(`/caldav/calendars/${personalCalId}/`);
      expect(htext).toContain('<C:calendar/>');
      expect(htext).toContain('Milvasoft');
    });

    it('creates, reads, queries, updates and deletes objects', async () => {
      const path = `/caldav/calendars/${personalCalId}/apple-1.ics`;
      const body = (summary: string) =>
        [
          'BEGIN:VCALENDAR',
          'VERSION:2.0',
          'BEGIN:VEVENT',
          'UID:apple-uid-1',
          'DTSTART;TZID=Europe/Istanbul:20261215T100000',
          'DTEND;TZID=Europe/Istanbul:20261215T110000',
          `SUMMARY:${summary}`,
          'END:VEVENT',
          'END:VCALENDAR',
        ].join('\r\n');
      const ro = await dav(
        'PUT',
        path,
        body('Telefon'),
        { 'Content-Type': 'text/calendar' },
        readOnly,
      );
      expect(ro.status).toBe(403);
      const created = await dav('PUT', path, body('Telefondan'), {
        'Content-Type': 'text/calendar',
        'If-None-Match': '*',
      });
      expect(created.status).toBe(201);
      const etag = created.headers.get('etag')!;
      expect(etag).toBeTruthy();
      const again = await dav('PUT', path, body('x'), { 'If-None-Match': '*' });
      expect(again.status).toBe(412);

      const web = await range('2026-12-15T00:00:00Z', '2026-12-16T00:00:00Z');
      expect(web.items.find((i) => i.title === 'Telefondan')?.start).toBe(
        '2026-12-15T07:00:00.000Z',
      );

      const got = await dav('GET', path);
      expect(got.status).toBe(200);
      expect(await got.text()).toContain('SUMMARY:Telefondan');

      const query = await dav(
        'REPORT',
        `/caldav/calendars/${personalCalId}/`,
        '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="20261215T000000Z" end="20261216T000000Z"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>',
        { Depth: '1' },
      );
      const qtext = await query.text();
      expect(qtext).toContain('apple-1.ics');
      expect(qtext).not.toContain('Daily');

      const multi = await dav(
        'REPORT',
        `/caldav/calendars/${personalCalId}/`,
        `<c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><d:href>${path}</d:href><d:href>/caldav/calendars/${personalCalId}/missing.ics</d:href></c:calendar-multiget>`,
      );
      const mtext = await multi.text();
      expect(mtext).toContain('SUMMARY:Telefondan');
      expect(mtext).toContain('404 Not Found');

      const stale = await dav('PUT', path, body('Eski'), { 'If-Match': '"stale"' });
      expect(stale.status).toBe(412);
      const updated = await dav('PUT', path, body('Telefondan (güncel)'), { 'If-Match': etag });
      expect(updated.status).toBe(204);

      const before = await dav(
        'PROPFIND',
        `/caldav/calendars/${personalCalId}/`,
        '<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/"><d:prop><cs:getctag/></d:prop></d:propfind>',
        { Depth: '0' },
      );
      const ctag1 = /getctag>([^<]+)</.exec(await before.text())?.[1];
      const del = await dav('DELETE', path);
      expect(del.status).toBe(204);
      const after = await dav(
        'PROPFIND',
        `/caldav/calendars/${personalCalId}/`,
        '<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/"><d:prop><cs:getctag/></d:prop></d:propfind>',
        { Depth: '0' },
      );
      const ctag2 = /getctag>([^<]+)</.exec(await after.text())?.[1];
      expect(ctag2).not.toBe(ctag1);
      expect((await dav('GET', path)).status).toBe(404);
    });

    it('closes with the module', async () => {
      await owner.api.call('updateOrg', { body: { settings: { modules: { calendar: false } } } });
      invalidateModules();
      await expectCode(owner.api.call('listCalendars'), 403, 'module_disabled');
      const res = await dav('PROPFIND', '/caldav/', undefined, { Depth: '0' });
      expect(res.status).toBe(403);
      await owner.api.call('updateOrg', { body: { settings: { modules: { calendar: true } } } });
      invalidateModules();
    });
  });
});
