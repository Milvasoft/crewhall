import {
  bookingEvents,
  cancelEventBookings,
  eventRoomOf,
  resetBookingsMock,
  syncEventRoom,
} from './bookings';
import {
  addDaysToDate,
  canCalendar,
  dateToDay,
  dayToDate,
  expandRRule,
  formatRRule,
  occurrenceKey,
  parseRRule,
  safeZone,
  startOfZonedDay,
  utcMidnight,
  zonedDay,
  zonedToUtc,
  civilFromDay,
  type Calendar,
  type CalendarEvent,
  type CalendarAccount,
  type CalendarEventVersion,
  type CalendarIntegration,
  type CalendarOccurrence,
  type CalendarRole,
  type CalendarSettings,
  type EndpointName,
  type SpaceColor,
} from '@crewhall/shared';
import { MockApiError, myRole, requireUser, summary, type Resolvers } from './core';
import { db, newId } from './db';
import { type MockState } from './seed';

/**
 * Calendar part of the contract mock (roadmap 14), in memory: personal, team and space
 * calendars, events with series (RRULE, changed and removed occurrences), invitations,
 * answers and availability. Linked meetings and cards are left to the real server.
 */

interface MockCal {
  id: string;
  kind: Calendar['kind'];
  ownerId: string | null;
  spaceId: string | null;
  name: string;
  color: SpaceColor;
  description: string | null;
  members: { userId: string; role: CalendarRole }[];
  createdAt: string;
}

interface MockEvent {
  id: string;
  calendarId: string;
  uid: string;
  parentId: string | null;
  recurrenceId: string | null;
  title: string;
  description: string | null;
  location: string | null;
  allDay: boolean;
  start: string;
  end: string;
  timeZone: string;
  rrule: string | null;
  exdates: string[];
  status: 'confirmed' | 'tentative' | 'cancelled';
  busy: boolean;
  visibility: 'default' | 'private';
  reminders: number[] | null;
  organizerId: string;
  attendees: {
    id: string;
    userId: string | null;
    email: string;
    name: string | null;
    response: CalendarEvent['myResponse'] & string;
    optional: boolean;
  }[];
  deleted: boolean;
  meeting?: { id: string; slug: string; url: string } | null;
  /** Tests: a row of a mirrored calendar. */
  external?: CalendarEvent['external'];
  createdAt: string;
  updatedAt: string;
}

interface CalState {
  calendars: MockCal[];
  events: MockEvent[];
  settings: Record<string, Partial<CalendarSettings>>;
  seeded: boolean;
}

let state: CalState = { calendars: [], events: [], settings: {}, seeded: false };

export function resetCalendarMock() {
  state = { calendars: [], events: [], settings: {}, seeded: false };
  resetBookingsMock();
  versions.clear();
  accounts = [];
  linked = [];
  for (const p of ['google', 'microsoft'] as const) {
    integrations[p] = {
      ...integrations[p],
      enabled: false,
      clientId: null,
      hasClientSecret: false,
    };
  }
}

export const MOCK_WRONG_EXCHANGE_PASSWORD = 'wrong';

/** Connected accounts: there are no providers here, tests add them. */
let accounts: CalendarAccount[] = [];

export const mockCalendarAccounts = () => accounts;

export function setMockCalendarAccounts(items: CalendarAccount[]) {
  accounts = items;
}

/** Overwritten versions of mirrored events: there is no sync here, tests add them. */
const versions = new Map<string, CalendarEventVersion[]>();

export function addMockVersion(eventId: string, v: CalendarEventVersion) {
  versions.set(eventId, [v, ...(versions.get(eventId) ?? [])]);
}

/** Linked items (meetings, cards) are the real server's; tests add the ones they need here. */
let linked: CalendarOccurrence[] = [];

export function addMockOccurrence(o: CalendarOccurrence) {
  linked.push(o);
}

/**
 * Tests: an event in `ownerId`'s personal calendar (created on demand), optionally inviting
 * people. Returns the stored row.
 */
export function addMockEvent(
  input: Pick<MockEvent, 'title' | 'start' | 'end'> &
    Partial<Pick<MockEvent, 'allDay' | 'rrule'>> & { ownerId: string; inviteIds?: string[] },
) {
  const s = db();
  ensure(s, input.ownerId);
  const cal = state.calendars.find((c) => c.kind === 'personal' && c.ownerId === input.ownerId)!;
  const e: MockEvent = {
    id: newId(),
    calendarId: cal.id,
    uid: `${newId()}@mock`,
    parentId: null,
    recurrenceId: null,
    title: input.title,
    description: null,
    location: null,
    allDay: input.allDay ?? false,
    start: input.start,
    end: input.end,
    timeZone: 'Europe/Istanbul',
    rrule: input.rrule ?? null,
    exdates: [],
    status: 'confirmed',
    busy: true,
    visibility: 'default',
    reminders: null,
    organizerId: input.ownerId,
    attendees: (input.inviteIds ?? []).map((id) => {
      const u = s.users.find((x) => x.id === id)!;
      return {
        id: newId(),
        userId: id,
        email: u.email,
        name: u.name,
        response: 'needs_action',
        optional: false,
      };
    }),
    deleted: false,
    createdAt: now(),
    updatedAt: now(),
  };
  state.events.push(e);
  return e;
}

export function calendarMockState() {
  return state;
}

const now = () => new Date().toISOString();

function settingsOf(userId: string): CalendarSettings {
  const d = state.settings[userId] ?? {};
  return {
    timeZone: safeZone(d.timeZone ?? 'Europe/Istanbul'),
    timeZoneExplicit: d.timeZoneExplicit ?? true,
    weekStart: d.weekStart ?? 1,
    defaultView: d.defaultView ?? 'week',
    defaultReminders: d.defaultReminders ?? [10],
    allDayReminderMinute: d.allDayReminderMinute ?? 540,
    workdayStart: d.workdayStart ?? 9,
    workdayEnd: d.workdayEnd ?? 18,
    showMeetings: d.showMeetings ?? true,
    showCards: d.showCards ?? true,
    showDeclined: d.showDeclined ?? false,
    hiddenCalendarIds: d.hiddenCalendarIds ?? [],
  };
}

function ensure(s: MockState, userId: string) {
  const user = s.users.find((u) => u.id === userId)!;
  if (!state.calendars.some((c) => c.kind === 'personal' && c.ownerId === userId)) {
    state.calendars.push({
      id: newId(),
      kind: 'personal',
      ownerId: userId,
      spaceId: null,
      name: user.name,
      color: 's1',
      description: null,
      members: [],
      createdAt: now(),
    });
  }
  for (const sm of s.spaceMembers.filter((x) => x.userId === userId)) {
    const sp = s.spaces.find((x) => x.id === sm.spaceId);
    if (!sp || sp.kind !== 'shared') continue;
    if (state.calendars.some((c) => c.kind === 'space' && c.spaceId === sp.id)) continue;
    state.calendars.push({
      id: newId(),
      kind: 'space',
      ownerId: null,
      spaceId: sp.id,
      name: sp.name,
      color: sp.color as SpaceColor,
      description: null,
      members: [],
      createdAt: now(),
    });
  }
  if (!state.seeded) {
    state.seeded = true;
    seed(userId);
  }
}

/** Two demo events around today: a weekly planning and an all-day off. */
function seed(userId: string) {
  const personal = state.calendars.find((c) => c.kind === 'personal' && c.ownerId === userId)!;
  const tz = 'Europe/Istanbul';
  const today = zonedDay(Date.now(), tz);
  const monday = today - ((((today + 4) % 7) + 6) % 7);
  const at = (day: number, h: number) =>
    zonedToUtc({ ...civilFromDay(day), hour: h, minute: 0, second: 0 }, tz).toISOString();
  const base = {
    parentId: null,
    recurrenceId: null,
    description: null,
    location: null,
    timeZone: tz,
    exdates: [],
    status: 'confirmed' as const,
    busy: true,
    visibility: 'default' as const,
    reminders: null,
    organizerId: userId,
    attendees: [],
    deleted: false,
    createdAt: now(),
    updatedAt: now(),
  };
  state.events.push(
    {
      ...base,
      id: newId(),
      calendarId: personal.id,
      uid: 'seed-1@mock',
      title: 'Haftalık planlama',
      allDay: false,
      start: at(monday, 10),
      end: at(monday, 11),
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
      location: 'Toplantı odası 2',
    },
    {
      ...base,
      id: newId(),
      calendarId: personal.id,
      uid: 'seed-2@mock',
      title: 'İzin',
      allDay: true,
      start: dayToDate(monday + 4),
      end: dayToDate(monday + 5),
      rrule: null,
      busy: false,
    },
  );
}

function roleOf(s: MockState, c: MockCal, userId: string): CalendarRole | null {
  if (c.kind === 'personal') return c.ownerId === userId ? 'owner' : null;
  if (c.kind === 'team') return c.members.find((m) => m.userId === userId)?.role ?? null;
  const r = myRole(s, c.spaceId!, userId);
  if (!r) return null;
  return r === 'owner' || r === 'admin' ? 'owner' : r === 'editor' ? 'editor' : 'viewer';
}

function toCalendar(s: MockState, c: MockCal, userId: string): Calendar {
  const role = roleOf(s, c, userId)!;
  const sp = c.spaceId ? s.spaces.find((x) => x.id === c.spaceId) : undefined;
  return {
    id: c.id,
    kind: c.kind,
    name: sp?.name ?? c.name,
    color: (sp?.color as SpaceColor | undefined) ?? c.color,
    description: c.description,
    spaceId: c.spaceId,
    ownerId: c.ownerId,
    isDefault: c.kind === 'personal' && c.ownerId === userId,
    myRole: role,
    memberCount: c.kind === 'team' ? c.members.length : 1,
    permissions: {
      write: canCalendar('write', { role, kind: c.kind }),
      manage: canCalendar('manage', { role, kind: c.kind }),
    },
    createdAt: c.createdAt,
  };
}

function readable(s: MockState, userId: string) {
  ensure(s, userId);
  return state.calendars.filter((c) => roleOf(s, c, userId) !== null);
}

function calendarFor(s: MockState, id: string, userId: string) {
  const c = readable(s, userId).find((x) => x.id === id);
  if (!c) throw new MockApiError('not_found');
  return c;
}

function writableCal(s: MockState, id: string, userId: string) {
  const c = calendarFor(s, id, userId);
  if (!canCalendar('write', { role: roleOf(s, c, userId), kind: c.kind })) {
    throw new MockApiError('calendar_read_only');
  }
  return c;
}

function eventFor(s: MockState, id: string, userId: string) {
  const e = state.events.find((x) => x.id === id && !x.deleted);
  if (!e) throw new MockApiError('not_found');
  const series = e.parentId ? state.events.find((x) => x.id === e.parentId)! : e;
  const cal = state.calendars.find((c) => c.id === e.calendarId)!;
  const role = roleOf(s, cal, userId);
  const attendee = series.attendees.find((a) => a.userId === userId) ?? null;
  if (role === null && !attendee) throw new MockApiError('not_found');
  return {
    e,
    series,
    cal,
    role,
    attendee,
    canEdit: canCalendar('write', { role, kind: cal.kind }),
  };
}

function toEvent(
  s: MockState,
  userId: string,
  e: MockEvent,
  occ?: { key: string; start: string; end: string },
): CalendarEvent {
  const { series, cal, attendee, canEdit } = eventFor(s, e.id, userId);
  const c = toCalendar(s, cal, roleOf(s, cal, userId) ? userId : series.organizerId);
  const organizer = s.users.find((u) => u.id === series.organizerId);
  return {
    id: e.id,
    uid: e.uid,
    calendar: { id: c.id, name: c.name, color: c.color, kind: c.kind },
    title: e.title,
    description: e.description,
    location: e.location,
    allDay: e.allDay,
    start: occ?.start ?? e.start,
    end: occ?.end ?? e.end,
    timeZone: e.timeZone,
    rrule: e.parentId ? null : e.rrule,
    exdates: e.parentId ? [] : e.exdates,
    seriesId: e.parentId ?? (occ && e.rrule ? e.id : null),
    recurrenceId: e.recurrenceId ?? (occ && e.rrule ? occ.key : null),
    status: e.status,
    busy: e.busy,
    visibility: e.visibility,
    reminders: e.reminders ?? settingsOf(userId).defaultReminders,
    organizer: organizer ? summary(organizer) : null,
    attendees: series.attendees.map((a) => {
      const u = a.userId ? s.users.find((x) => x.id === a.userId) : undefined;
      return {
        id: a.id,
        user: u ? summary(u) : null,
        email: a.email,
        name: u?.name ?? a.name,
        response: a.response,
        optional: a.optional,
      };
    }),
    myResponse: attendee?.response ?? null,
    permissions: { edit: canEdit, delete: canEdit, respond: attendee !== null },
    meeting: series.meeting ?? null,
    room: e.parentId ? null : eventRoomOf(e.id),
    external: series.external ?? null,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

const DAY = 86_400_000;

function expand(e: MockEvent, from: Date, to: Date, skip: Set<string>) {
  const dur = e.allDay
    ? dateToDay(e.end) - dateToDay(e.start)
    : Date.parse(e.end) - Date.parse(e.start);
  if (!e.rrule) {
    const s = e.allDay ? utcMidnight(e.start).getTime() : Date.parse(e.start);
    const en = e.allDay ? utcMidnight(e.end).getTime() : Date.parse(e.end);
    const slack = e.allDay ? DAY : 0;
    return s < to.getTime() + slack && en > from.getTime() - slack
      ? [
          {
            key: occurrenceKey(e.allDay ? e.start : new Date(e.start), e.allDay),
            start: e.start,
            end: e.end,
          },
        ]
      : [];
  }
  return expandRRule({
    rule: parseRRule(e.rrule)!,
    allDay: e.allDay,
    start: e.allDay ? e.start : new Date(e.start),
    timeZone: e.timeZone,
    duration: dur,
    from,
    to,
    exdates: skip,
  }).map((o) => ({
    key: o.key,
    start: typeof o.start === 'string' ? o.start : o.start.toISOString(),
    end: typeof o.end === 'string' ? o.end : o.end.toISOString(),
  }));
}

function attendeesFrom(
  s: MockState,
  input: { userIds?: string[]; emails?: string[] } | undefined,
  organizerId: string,
  old: MockEvent['attendees'] = [],
) {
  if (!input) return old;
  const out: MockEvent['attendees'] = [];
  for (const id of input.userIds ?? []) {
    const u = s.users.find((x) => x.id === id);
    if (!u || u.id === organizerId) continue;
    const prev = old.find((a) => a.userId === id);
    out.push(
      prev ?? {
        id: newId(),
        userId: u.id,
        email: u.email,
        name: u.name,
        response: 'needs_action',
        optional: false,
      },
    );
  }
  for (const email of input.emails ?? []) {
    const prev = old.find((a) => a.email === email);
    out.push(
      prev ?? {
        id: newId(),
        userId: null,
        email,
        name: null,
        response: 'needs_action',
        optional: false,
      },
    );
  }
  return out;
}

function mockMeeting(title: string) {
  const slug = `${title
    .toLocaleLowerCase('tr')
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 20)}-${newId().slice(0, 4)}`;
  return { id: newId(), slug, url: `${window.location.origin}/m/${slug}` };
}

const canon = (r: string | null | undefined) => (r ? formatRRule(parseRRule(r)!) : null);

/**
 * Google / Microsoft connections: the mock keeps the admin's settings only. Connecting is a
 * browser round trip to the provider, which the mock cannot play, so nobody has an account.
 */
type Provider = 'google' | 'microsoft' | 'exchange';
const integrations: Record<Provider, Omit<CalendarIntegration, 'provider' | 'redirectUri'>> = {
  google: {
    enabled: false,
    clientId: null,
    hasClientSecret: false,
    tenant: null,
    accountCount: 0,
    updatedAt: null,
  },
  microsoft: {
    enabled: false,
    clientId: null,
    hasClientSecret: false,
    tenant: null,
    accountCount: 0,
    updatedAt: null,
  },
  exchange: {
    enabled: false,
    clientId: null,
    hasClientSecret: false,
    tenant: null,
    accountCount: 0,
    updatedAt: null,
    ewsUrl: null,
    ewsAuth: 'ntlm',
    contactsSync: false,
  },
};
const integrationOf = (p: Provider): CalendarIntegration => ({
  provider: p,
  ...integrations[p],
  redirectUri: 'http://localhost:3000/api/calendar/oauth/callback',
});
const providerOf = (v: string): Provider => {
  if (v !== 'google' && v !== 'microsoft' && v !== 'exchange') throw new MockApiError('not_found');
  return v;
};

export const calendarResolvers: Partial<Resolvers<EndpointName>> = {
  listCalendars: ({ s }) => {
    const u = requireUser(s);
    return { items: readable(s, u.id).map((c) => toCalendar(s, c, u.id)) };
  },
  createCalendar: ({ s, body }) => {
    const u = requireUser(s);
    const c: MockCal = {
      id: newId(),
      kind: 'team',
      ownerId: u.id,
      spaceId: null,
      name: body.name,
      color: body.color,
      description: body.description ?? null,
      members: [{ userId: u.id, role: 'owner' }, ...body.members],
      createdAt: now(),
    };
    state.calendars.push(c);
    return toCalendar(s, c, u.id);
  },
  updateCalendar: ({ s, params, body }) => {
    const u = requireUser(s);
    const c = calendarFor(s, params.calendarId!, u.id);
    if (body.name !== undefined) c.name = body.name;
    if (body.color !== undefined) c.color = body.color;
    if (body.description !== undefined) c.description = body.description;
    return toCalendar(s, c, u.id);
  },
  deleteCalendar: ({ s, params }) => {
    const u = requireUser(s);
    const c = calendarFor(s, params.calendarId!, u.id);
    if (c.kind !== 'team') throw new MockApiError('calendar_not_team');
    state.calendars = state.calendars.filter((x) => x !== c);
    return {};
  },
  listCalendarMembers: ({ s, params }) => {
    const u = requireUser(s);
    const c = calendarFor(s, params.calendarId!, u.id);
    return {
      items: c.members.map((m) => ({
        user: summary(s.users.find((x) => x.id === m.userId)!),
        role: m.role,
      })),
    };
  },
  setCalendarMember: ({ s, params, body }) => {
    const u = requireUser(s);
    const c = calendarFor(s, params.calendarId!, u.id);
    const m = c.members.find((x) => x.userId === params.userId);
    if (m) m.role = body.role;
    else c.members.push({ userId: params.userId!, role: body.role });
    return { user: summary(s.users.find((x) => x.id === params.userId)!), role: body.role };
  },
  removeCalendarMember: ({ s, params }) => {
    const u = requireUser(s);
    const c = calendarFor(s, params.calendarId!, u.id);
    c.members = c.members.filter((x) => x.userId !== params.userId);
    return {};
  },
  importCalendarIcs: () => ({ created: 0, updated: 0, skipped: 0, errors: [] }),

  listCalendarOccurrences: ({ s, query }) => {
    const u = requireUser(s);
    const settings = settingsOf(u.id);
    const cals = readable(s, u.id);
    const shown = query.spaceId
      ? cals.filter((c) => c.spaceId === query.spaceId)
      : cals.filter((c) => !settings.hiddenCalendarIds.includes(c.id));
    const ids = new Set(shown.map((c) => c.id));
    const personal = cals.find((c) => c.kind === 'personal' && c.ownerId === u.id)!;
    const from = new Date(query.from);
    const to = new Date(query.to);
    const items: CalendarOccurrence[] = [];
    for (const e of state.events.filter((x) => !x.deleted && !x.parentId)) {
      const attendee = e.attendees.find((a) => a.userId === u.id);
      const inCal = ids.has(e.calendarId);
      if (!inCal && !(attendee && ids.has(personal.id) && attendee.response !== 'declined')) {
        continue;
      }
      const overrides = state.events.filter((x) => x.parentId === e.id && !x.deleted);
      const skip = new Set([...e.exdates, ...overrides.map((o) => o.recurrenceId!)]);
      const cal = inCal ? state.calendars.find((c) => c.id === e.calendarId)! : personal;
      const view = toCalendar(s, cal, u.id);
      const editable = inCal && view.permissions.write;
      const push = (row: MockEvent, key: string, start: string, end: string) =>
        items.push({
          key: `event:${e.id}:${key}`,
          source: 'event',
          sourceId: row.id,
          seriesId: e.rrule ? e.id : null,
          recurrenceId: e.rrule ? key : null,
          calendarId: view.id,
          color: view.color,
          title: row.title,
          hidden: false,
          location: row.location,
          allDay: row.allDay,
          start,
          end,
          status: row.status,
          busy: row.busy,
          recurring: Boolean(e.rrule),
          myResponse: attendee?.response ?? null,
          attendeeCount: e.attendees.length,
          editable,
          url: null,
          flag: null,
        });
      for (const o of expand(e, from, to, skip)) push(e, o.key, o.start, o.end);
      for (const o of overrides) {
        if (expand({ ...o, rrule: null }, from, to, new Set()).length) {
          push(o, o.recurrenceId!, o.start, o.end);
        }
      }
    }
    items.push(...linked.filter((o) => o.start < query.to && o.end > query.from));
    items.sort((a, b) => (a.start < b.start ? -1 : 1));
    return { items };
  },
  getCalendarFreeBusy: ({ s, query }) => {
    requireUser(s);
    const from = new Date(query.from);
    const to = new Date(query.to);
    return {
      items: query.userIds.map((userId) => {
        const busy = state.events
          .filter((e) => !e.deleted && !e.parentId && e.busy && !e.allDay)
          .filter((e) => {
            const cal = state.calendars.find((c) => c.id === e.calendarId);
            return (
              (cal?.kind === 'personal' && cal.ownerId === userId) ||
              e.attendees.some((a) => a.userId === userId && a.response !== 'declined')
            );
          })
          .flatMap((e) => expand(e, from, to, new Set(e.exdates)))
          .map((o) => ({ start: o.start, end: o.end, tentative: false }));
        return { userId, busy };
      }),
    };
  },

  createCalendarEvent: ({ s, body }) => {
    const u = requireUser(s);
    writableCal(s, body.calendarId, u.id);
    const e: MockEvent = {
      id: newId(),
      calendarId: body.calendarId,
      uid: `${newId()}@mock`,
      parentId: null,
      recurrenceId: null,
      title: body.title,
      description: body.description ?? null,
      location: body.location ?? null,
      allDay: body.allDay,
      start: body.start,
      end: body.end,
      timeZone: body.timeZone ?? settingsOf(u.id).timeZone,
      rrule: canon(body.rrule),
      exdates: [],
      status: body.status ?? 'confirmed',
      busy: body.busy ?? true,
      visibility: body.visibility ?? 'default',
      reminders: body.reminders ?? null,
      organizerId: u.id,
      attendees: attendeesFrom(s, body.attendees, u.id),
      deleted: false,
      meeting: body.onlineMeeting && !body.allDay ? mockMeeting(body.title) : null,
      createdAt: now(),
      updatedAt: now(),
    };
    if (body.roomId) {
      const place = syncEventRoom(e, u.id, body.roomId);
      if (place && !e.location) e.location = place;
    }
    state.events.push(e);
    return toEvent(s, u.id, e);
  },
  getCalendarEvent: ({ s, params, query }) => {
    const u = requireUser(s);
    const { e } = eventFor(s, params.eventId!, u.id);
    if (!query.recurrenceId || !e.rrule) return toEvent(s, u.id, e);
    const ov = state.events.find(
      (x) => x.parentId === e.id && x.recurrenceId === query.recurrenceId && !x.deleted,
    );
    if (ov) return toEvent(s, u.id, ov);
    const at = e.allDay
      ? utcMidnight(query.recurrenceId.slice(0, 10))
      : new Date(query.recurrenceId);
    const occ = expand(
      e,
      new Date(at.getTime() - 2 * DAY),
      new Date(at.getTime() + 2 * DAY),
      new Set(),
    ).find((o) => o.key === query.recurrenceId);
    if (!occ) throw new MockApiError('calendar_occurrence_unknown');
    return toEvent(s, u.id, e, occ);
  },
  updateCalendarEvent: ({ s, params, body }) => {
    const u = requireUser(s);
    const acc = eventFor(s, params.eventId!, u.id);
    if (!acc.canEdit) throw new MockApiError('calendar_read_only');
    let target = acc.e;
    if (body.scope === 'this' && body.recurrenceId && acc.e.rrule) {
      const ov =
        state.events.find(
          (x) => x.parentId === acc.e.id && x.recurrenceId === body.recurrenceId && !x.deleted,
        ) ??
        (() => {
          const created: MockEvent = {
            ...acc.e,
            id: newId(),
            parentId: acc.e.id,
            recurrenceId: body.recurrenceId!,
            rrule: null,
            exdates: [],
            attendees: [],
          };
          state.events.push(created);
          return created;
        })();
      target = ov;
    } else if (
      body.scope !== 'this' &&
      body.recurrenceId &&
      body.start &&
      body.end &&
      acc.e.rrule
    ) {
      // Dragging an occurrence of a series (all/following): move the series by the same amount.
      const shift = acc.e.allDay
        ? dateToDay(body.start) - dateToDay(body.recurrenceId.slice(0, 10))
        : Date.parse(body.start) - Date.parse(body.recurrenceId);
      const len = acc.e.allDay
        ? dateToDay(body.end) - dateToDay(body.start)
        : Date.parse(body.end) - Date.parse(body.start);
      if (acc.e.allDay) {
        body.start = addDaysToDate(acc.e.start, shift);
        body.end = addDaysToDate(body.start, len);
      } else {
        body.start = new Date(Date.parse(acc.e.start) + shift).toISOString();
        body.end = new Date(Date.parse(body.start) + len).toISOString();
      }
    }
    if (body.title !== undefined) target.title = body.title;
    if (body.description !== undefined) target.description = body.description;
    if (body.location !== undefined) target.location = body.location;
    if (body.allDay !== undefined) target.allDay = body.allDay;
    if (body.start !== undefined) target.start = body.start;
    if (body.end !== undefined) target.end = body.end;
    if (body.busy !== undefined) target.busy = body.busy;
    if (body.visibility !== undefined) target.visibility = body.visibility;
    if (body.reminders !== undefined) target.reminders = body.reminders;
    if (body.rrule !== undefined && !target.parentId) target.rrule = canon(body.rrule);
    if (body.calendarId) target.calendarId = body.calendarId;
    if (body.onlineMeeting !== undefined && !target.parentId) {
      target.meeting = body.onlineMeeting ? (target.meeting ?? mockMeeting(target.title)) : null;
    }
    if (body.attendees && !target.parentId) {
      target.attendees = attendeesFrom(s, body.attendees, acc.series.organizerId, target.attendees);
    }
    if (!target.parentId) {
      const place = syncEventRoom(target, u.id, body.roomId);
      if (place && !target.location) target.location = place;
    }
    target.updatedAt = now();
    return toEvent(s, u.id, target);
  },
  deleteCalendarEvent: ({ s, params, query }) => {
    const u = requireUser(s);
    const acc = eventFor(s, params.eventId!, u.id);
    if (!acc.canEdit) throw new MockApiError('calendar_read_only');
    if (query.scope === 'this' && query.recurrenceId && acc.series.rrule) {
      acc.series.exdates.push(query.recurrenceId);
      for (const o of state.events.filter(
        (x) => x.parentId === acc.series.id && x.recurrenceId === query.recurrenceId,
      )) {
        o.deleted = true;
      }
    } else {
      acc.series.deleted = true;
      cancelEventBookings(acc.series.id);
    }
    return {};
  },
  respondCalendarEvent: ({ s, params, body }) => {
    const u = requireUser(s);
    const acc = eventFor(s, params.eventId!, u.id);
    if (!acc.attendee) throw new MockApiError('forbidden');
    acc.attendee.response = body.response;
    return toEvent(s, u.id, acc.e);
  },

  getCalendarSettings: ({ s }) => settingsOf(requireUser(s).id),
  updateCalendarSettings: ({ s, body }) => {
    const u = requireUser(s);
    const next = { ...(state.settings[u.id] ?? {}) };
    for (const [k, v] of Object.entries(body)) {
      if (v !== undefined) (next as Record<string, unknown>)[k] = v;
    }
    state.settings[u.id] = next;
    return settingsOf(u.id);
  },
  getCalDavInfo: ({ s }) => ({
    url: `${window.location.origin}/caldav/`,
    username: requireUser(s).email,
    tokensAvailable: true,
  }),
  listCalendarAccounts: ({ s }) => {
    requireUser(s);
    return {
      items: accounts,
      providers: (['google', 'microsoft', 'exchange'] as const).filter(
        (p) => integrations[p].enabled,
      ),
    };
  },
  connectExchangeAccount: ({ s, body }) => {
    requireUser(s);
    if (!integrations.exchange.enabled) throw new MockApiError('calendar_integration_off');
    // Mock server: any password but this one signs in.
    if (body.password === MOCK_WRONG_EXCHANGE_PASSWORD) {
      throw new MockApiError('calendar_exchange_auth_failed');
    }
    const account: CalendarAccount = {
      id: newId(),
      provider: 'exchange',
      email: body.email,
      status: 'active',
      lastError: null,
      lastSyncedAt: null,
      calendars: [],
      createdAt: new Date().toISOString(),
      delegated: false,
      busyOnly: false,
      contacts: null,
    };
    accounts = [account, ...accounts.filter((a) => a.email !== body.email)];
    return account;
  },
  syncCalendarAccount: () => {
    throw new MockApiError('not_found');
  },
  deleteCalendarAccount: () => {
    throw new MockApiError('not_found');
  },
  updateCalendarAccount: () => {
    throw new MockApiError('not_found');
  },
  listCalendarEventVersions: ({ s, params }) => {
    requireUser(s);
    return { items: versions.get(params.eventId!) ?? [] };
  },
  getCalendarIntegrations: ({ s }) => {
    requireUser(s);
    return {
      items: [integrationOf('google'), integrationOf('microsoft'), integrationOf('exchange')],
    };
  },
  updateCalendarIntegration: ({ s, params, body }) => {
    requireUser(s);
    const p = providerOf(params.provider ?? '');
    const cur = integrations[p];
    const clientId = body.clientId === undefined ? cur.clientId : body.clientId || null;
    const hasClientSecret =
      body.clientSecret === null ? false : Boolean(body.clientSecret) || cur.hasClientSecret;
    if (p === 'exchange') {
      const ewsUrl = body.ewsUrl === undefined ? (cur.ewsUrl ?? null) : body.ewsUrl || null;
      if (body.enabled && !ewsUrl) throw new MockApiError('validation_failed');
      integrations[p] = {
        ...cur,
        enabled: body.enabled,
        ewsUrl,
        ewsAuth: body.ewsAuth ?? cur.ewsAuth ?? 'ntlm',
        contactsSync: body.contactsSync ?? cur.contactsSync ?? false,
        updatedAt: new Date().toISOString(),
      };
      return integrationOf(p);
    }
    if (body.enabled && (!clientId || !hasClientSecret)) {
      throw new MockApiError('validation_failed');
    }
    let serviceAccountEmail = cur.serviceAccountEmail ?? null;
    if (p === 'google' && body.serviceAccountKey === null) serviceAccountEmail = null;
    else if (p === 'google' && body.serviceAccountKey) {
      try {
        const key = JSON.parse(body.serviceAccountKey) as { type?: string; client_email?: string };
        if (key.type !== 'service_account' || !key.client_email) throw new Error('key');
        serviceAccountEmail = key.client_email;
      } catch {
        throw new MockApiError('validation_failed');
      }
    }
    const delegatedAdmin =
      p !== 'google'
        ? null
        : body.delegatedAdmin === undefined
          ? (cur.delegatedAdmin ?? null)
          : body.delegatedAdmin || null;
    const directorySync = p === 'google' && (body.directorySync ?? cur.directorySync ?? false);
    if (directorySync && (!serviceAccountEmail || !delegatedAdmin)) {
      throw new MockApiError('validation_failed');
    }
    integrations[p] = {
      ...cur,
      enabled: body.enabled,
      clientId,
      hasClientSecret,
      tenant:
        p === 'microsoft' ? (body.tenant === undefined ? cur.tenant : body.tenant || null) : null,
      domainWide: body.domainWide ?? cur.domainWide ?? false,
      contactsSync: p === 'microsoft' && (body.contactsSync ?? cur.contactsSync ?? false),
      serviceAccountEmail,
      delegatedAdmin,
      directorySync,
      updatedAt: new Date().toISOString(),
    };
    return integrationOf(p);
  },
  syncWorkspaceDirectory: ({ s }) => {
    requireUser(s);
    if (!integrations.google.directorySync) throw new MockApiError('calendar_integration_off');
    integrations.google = {
      ...integrations.google,
      directorySyncedAt: new Date().toISOString(),
      directoryError: null,
    };
    return integrationOf('google');
  },
};

/** The start of a local day in the mock's zone, for tests. */
export const mockDayStart = (date: string, tz = 'Europe/Istanbul') =>
  startOfZonedDay(dateToDay(date), tz).toISOString();

// A booking's own event goes into the booker's personal calendar.
bookingEvents.create = ({ userId, title, location, start, end, busy }) => {
  const e = addMockEvent({ ownerId: userId, title, start, end });
  e.location = location;
  e.busy = busy;
  return e.id;
};
bookingEvents.remove = (eventId) => {
  const e = state.events.find((x) => x.id === eventId);
  if (e) e.deleted = true;
};
