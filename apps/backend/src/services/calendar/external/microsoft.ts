import { z } from 'zod';
import { addDaysToDate } from '@crewhall/shared';
import {
  dateToDay,
  dayToDate,
  parseRRule,
  weekdayOfDay,
  zonedDay,
  zonedToUtc,
} from '@crewhall/shared';
import { AppError } from '../../../http/errors';
import { ProviderError } from './http';
import {
  SYNC_WINDOW,
  type Api,
  type DeltaResult,
  type ExtCalendar,
  type ExtEvent,
  type ExtEventInput,
  type ExtPersonResponse,
  type ExtTime,
  type ProviderClient,
} from './types';
import { formatWall, parseWall, wallDate, zoneOf } from './wall';

/**
 * Microsoft Graph v1.0. The calendarView delta returns occurrences, not series, so every
 * occurrence is its own row in Crewhall and changes made in Crewhall apply to that occurrence.
 * Series are edited in Outlook; creating one from Crewhall sends a patternedRecurrence.
 */

export const GRAPH = 'https://graph.microsoft.com/v1.0';
const enc = encodeURIComponent;
const DAY_MS = 86_400_000;
const MAX_PAGES = 200;
const PREFER = { Prefer: 'odata.maxpagesize=200, outlook.body-content-type="text"' };

const MTime = z.object({ dateTime: z.string(), timeZone: z.string().optional() });
const MAddress = z.object({ name: z.string().optional(), address: z.string().optional() });

const MEvent = z.object({
  id: z.string(),
  '@removed': z.object({ reason: z.string().optional() }).optional(),
  changeKey: z.string().optional(),
  subject: z.string().nullable().optional(),
  body: z.object({ contentType: z.string().optional(), content: z.string().optional() }).optional(),
  location: z.object({ displayName: z.string().nullable().optional() }).nullable().optional(),
  start: MTime.optional(),
  end: MTime.optional(),
  isAllDay: z.boolean().optional(),
  showAs: z.string().optional(),
  sensitivity: z.string().optional(),
  isCancelled: z.boolean().optional(),
  type: z.string().optional(),
  seriesMasterId: z.string().nullable().optional(),
  originalStartTimeZone: z.string().nullable().optional(),
  isOrganizer: z.boolean().optional(),
  responseStatus: z.object({ response: z.string().optional() }).nullable().optional(),
  attendees: z
    .array(
      z.object({
        emailAddress: MAddress.optional(),
        status: z.object({ response: z.string().optional() }).optional(),
        type: z.string().optional(),
      }),
    )
    .optional(),
  organizer: z.object({ emailAddress: MAddress.optional() }).nullable().optional(),
  onlineMeeting: z.object({ joinUrl: z.string().nullable().optional() }).nullable().optional(),
  onlineMeetingUrl: z.string().nullable().optional(),
  webLink: z.string().nullable().optional(),
});
type MEvent = z.infer<typeof MEvent>;

/** A series master as "all events" needs it (times in UTC through the Prefer header). */
const MMaster = z.object({
  start: MTime,
  end: MTime,
  isAllDay: z.boolean().optional(),
  recurrence: z
    .object({
      pattern: z.record(z.string(), z.unknown()),
      range: z.object({ startDate: z.string().optional() }).passthrough(),
    })
    .passthrough()
    .nullable()
    .optional(),
});

const MPage = z.object({
  value: z.array(z.unknown()).default([]),
  '@odata.nextLink': z.string().optional(),
  '@odata.deltaLink': z.string().optional(),
});

const MCalendar = z.object({
  id: z.string(),
  name: z.string().optional(),
  canEdit: z.boolean().optional(),
  isDefaultCalendar: z.boolean().optional(),
});

const RESPONSE: Record<string, ExtPersonResponse> = {
  none: 'needs_action',
  notResponded: 'needs_action',
  accepted: 'accepted',
  organizer: 'accepted',
  declined: 'declined',
  tentativelyAccepted: 'tentative',
};

function msTime(t: z.infer<typeof MTime> | undefined, allDay: boolean): ExtTime | null {
  if (!t) return null;
  // All-day events are dates; read the date part as written.
  if (allDay)
    return /^\d{4}-\d{2}-\d{2}/.test(t.dateTime)
      ? { allDay: true, date: t.dateTime.slice(0, 10) }
      : null;
  const w = parseWall(t.dateTime);
  return w ? { allDay: false, at: zonedToUtc(w, zoneOf(t.timeZone)) } : null;
}

export function toExt(e: MEvent, selfEmail: string): ExtEvent | null {
  const allDay = Boolean(e.isAllDay);
  const start = msTime(e.start, allDay);
  const end = msTime(e.end, allDay);
  if (!start || !end) return null;
  const self = selfEmail.toLowerCase();
  const attendees = (e.attendees ?? [])
    .filter((a) => a.emailAddress?.address && a.type !== 'resource')
    .map((a) => {
      const email = a.emailAddress!.address!.toLowerCase();
      return {
        email,
        name: a.emailAddress?.name ?? null,
        response: RESPONSE[a.status?.response ?? ''] ?? 'needs_action',
        self: email === self,
        optional: a.type === 'optional',
      };
    });
  const mine = RESPONSE[e.responseStatus?.response ?? ''];
  const showAs = e.showAs ?? 'busy';
  const organizer = e.organizer?.emailAddress?.address;
  return {
    externalId: e.id,
    etag: e.changeKey ?? null,
    cancelled: Boolean(e.isCancelled),
    parentExternalId: null,
    originalStart: null,
    title: e.subject?.trim() || '',
    description: e.body?.content?.trim() ? e.body.content.trim().slice(0, 10_000) : null,
    location: e.location?.displayName?.trim() || null,
    start,
    end,
    timeZone: zoneOf(e.originalStartTimeZone),
    rrule: null,
    exdates: [],
    unsupportedRecurrence: false,
    status: showAs === 'tentative' ? 'tentative' : 'confirmed',
    busy: showAs !== 'free' && showAs !== 'workingElsewhere' && mine !== 'declined',
    private: e.sensitivity === 'private' || e.sensitivity === 'confidential',
    data: {
      organizer: organizer
        ? {
            email: organizer.toLowerCase(),
            name: e.organizer?.emailAddress?.name ?? null,
            self: Boolean(e.isOrganizer),
          }
        : null,
      attendees,
      joinUrl: e.onlineMeeting?.joinUrl ?? e.onlineMeetingUrl ?? null,
      webUrl: e.webLink ?? null,
      readOnly: false,
      seriesMasterId:
        e.type === 'occurrence' || e.type === 'exception' ? (e.seriesMasterId ?? null) : null,
    },
  };
}

// ---- RRULE → Graph patternedRecurrence ------------------------------------------------------------

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const INDEX: Record<string, string> = {
  '1': 'first',
  '2': 'second',
  '3': 'third',
  '4': 'fourth',
  '-1': 'last',
};

const unsupported = () => new AppError('calendar_external_unsupported', { reason: 'recurrence' });

/** The rule as Graph expresses it; rules Outlook cannot hold are refused. */
export function graphRecurrence(rrule: string, startDate: string, tz: string) {
  const r = parseRRule(rrule);
  if (!r || r.bySetPos.length) throw unsupported();
  const startDay = dateToDay(startDate);
  const [, sm, sd] = startDate.split('-').map(Number) as [number, number, number];
  const relative = () => {
    const ns = [...new Set(r.byDay.map((d) => d.n))];
    if (ns.length !== 1 || ns[0] === null || !INDEX[String(ns[0])]) throw unsupported();
    return { daysOfWeek: r.byDay.map((d) => DAYS[d.weekday]!), index: INDEX[String(ns[0])]! };
  };
  let pattern: Record<string, unknown>;
  switch (r.freq) {
    case 'DAILY':
      if (r.byDay.length || r.byMonthDay.length || r.byMonth.length) throw unsupported();
      pattern = { type: 'daily', interval: r.interval };
      break;
    case 'WEEKLY':
      if (r.byDay.some((d) => d.n !== null) || r.byMonthDay.length || r.byMonth.length)
        throw unsupported();
      pattern = {
        type: 'weekly',
        interval: r.interval,
        daysOfWeek: r.byDay.length
          ? r.byDay.map((d) => DAYS[d.weekday]!)
          : [DAYS[weekdayOfDay(startDay)]!],
        firstDayOfWeek: DAYS[r.wkst]!,
      };
      break;
    case 'MONTHLY':
      if (r.byMonth.length) throw unsupported();
      if (r.byDay.length)
        pattern = { type: 'relativeMonthly', interval: r.interval, ...relative() };
      else if (r.byMonthDay.length > 1 || (r.byMonthDay[0] ?? 1) < 1) throw unsupported();
      else
        pattern = {
          type: 'absoluteMonthly',
          interval: r.interval,
          dayOfMonth: r.byMonthDay[0] ?? sd,
        };
      break;
    case 'YEARLY': {
      if (r.byMonth.length > 1) throw unsupported();
      const month = r.byMonth[0] ?? sm;
      if (r.byDay.length)
        pattern = { type: 'relativeYearly', interval: r.interval, month, ...relative() };
      else if (r.byMonthDay.length > 1 || (r.byMonthDay[0] ?? 1) < 1) throw unsupported();
      else
        pattern = {
          type: 'absoluteYearly',
          interval: r.interval,
          month,
          dayOfMonth: r.byMonthDay[0] ?? sd,
        };
      break;
    }
  }
  let range: Record<string, unknown> = { type: 'noEnd', startDate, recurrenceTimeZone: tz };
  if (r.count)
    range = { type: 'numbered', numberOfOccurrences: r.count, startDate, recurrenceTimeZone: tz };
  else if (r.until) {
    const endDate =
      r.until.kind === 'date' ? dayToDate(r.until.day) : dayToDate(zonedDay(r.until.ms, tz));
    range = { type: 'endDate', startDate, endDate, recurrenceTimeZone: tz };
  }
  return { pattern, range };
}

export function graphBody(input: ExtEventInput): Record<string, unknown> {
  const b: Record<string, unknown> = {};
  if (input.title !== undefined) b.subject = input.title;
  if (input.description !== undefined)
    b.body = { contentType: 'text', content: input.description ?? '' };
  if (input.location !== undefined) b.location = { displayName: input.location ?? '' };
  const tz = input.timeZone ?? 'UTC';
  if (input.start !== undefined && input.end !== undefined) {
    if (input.allDay) {
      b.isAllDay = true;
      b.start = { dateTime: `${input.start}T00:00:00`, timeZone: tz };
      b.end = { dateTime: `${input.end}T00:00:00`, timeZone: tz };
    } else if (input.rrule) {
      // A series keeps its wall-clock time across DST in its own zone.
      b.isAllDay = false;
      b.start = { dateTime: formatWall(new Date(input.start), tz), timeZone: tz };
      b.end = { dateTime: formatWall(new Date(input.end), tz), timeZone: tz };
    } else {
      b.isAllDay = false;
      b.start = { dateTime: formatWall(new Date(input.start), 'UTC'), timeZone: 'UTC' };
      b.end = { dateTime: formatWall(new Date(input.end), 'UTC'), timeZone: 'UTC' };
    }
  }
  if (input.rrule && input.start) {
    const startDate = input.allDay ? input.start : wallDate(new Date(input.start), tz);
    b.recurrence = graphRecurrence(input.rrule, startDate, tz);
  }
  if (input.busy !== undefined) b.showAs = input.busy ? 'busy' : 'free';
  if (input.private !== undefined) b.sensitivity = input.private ? 'private' : 'normal';
  if (input.attendees !== undefined) {
    b.attendees = input.attendees.map((a) => ({
      emailAddress: { address: a.email },
      type: a.optional ? 'optional' : 'required',
    }));
  }
  return b;
}

export function microsoftClient(api: Api, selfEmail: string, me = `${GRAPH}/me`): ProviderClient {
  /** A series master moved by an occurrence's move, in the event's own zone (DST-safe). */
  const shiftedSeries = async (masterId: string, input: ExtEventInput) => {
    const shift = input.seriesShift!;
    const master = MMaster.parse(
      await api(`${me}/events/${enc(masterId)}?$select=start,end,isAllDay,recurrence`, {
        headers: { Prefer: 'outlook.timezone="UTC"' },
      }),
    );
    const range = master.recurrence?.range;
    const out: Record<string, unknown> = {};
    if (master.isAllDay) {
      const start = addDaysToDate(master.start.dateTime.slice(0, 10), shift.days);
      const days = Math.max(1, Math.round(shift.lengthMs / 86_400_000));
      out.start = { dateTime: `${start}T00:00:00`, timeZone: input.timeZone ?? 'UTC' };
      out.end = {
        dateTime: `${addDaysToDate(start, days)}T00:00:00`,
        timeZone: input.timeZone ?? 'UTC',
      };
    } else {
      const tz = input.timeZone ?? 'UTC';
      const start = new Date(Date.parse(`${master.start.dateTime.slice(0, 19)}Z`) + shift.ms);
      out.start = { dateTime: formatWall(start, tz), timeZone: tz };
      out.end = {
        dateTime: formatWall(new Date(start.getTime() + shift.lengthMs), tz),
        timeZone: tz,
      };
    }
    if (master.recurrence && range?.startDate) {
      out.recurrence = {
        ...master.recurrence,
        range: { ...range, startDate: addDaysToDate(range.startDate, shift.days) },
      };
    }
    return out;
  };

  return {
    async listCalendars(): Promise<ExtCalendar[]> {
      const out: ExtCalendar[] = [];
      let url: string | undefined =
        `${me}/calendars?$select=id,name,canEdit,isDefaultCalendar&$top=100`;
      for (let i = 0; url && i < 20; i++) {
        const page = MPage.parse(await api(url));
        for (const raw of page.value) {
          const c = MCalendar.safeParse(raw);
          if (!c.success) continue;
          out.push({
            externalId: c.data.id,
            name: (c.data.name ?? 'Outlook').slice(0, 200),
            writable: c.data.canEdit ?? false,
            primary: Boolean(c.data.isDefaultCalendar),
          });
        }
        url = page['@odata.nextLink'];
      }
      return out;
    },

    async delta(calendarId, state): Promise<DeltaResult> {
      const now = Date.now();
      // The delta link belongs to a fixed window; start a new one before it runs out.
      const fresh =
        state?.cursor &&
        state.cursor.startsWith(`${GRAPH}/`) &&
        state.windowEnd &&
        Date.parse(state.windowEnd) - now > (SYNC_WINDOW.futureDays - 60) * DAY_MS;
      let url: string;
      let windowStart: string;
      let windowEnd: string;
      if (fresh) {
        url = state!.cursor!;
        windowStart = state!.windowStart!;
        windowEnd = state!.windowEnd!;
      } else {
        windowStart = new Date(now - SYNC_WINDOW.pastDays * DAY_MS).toISOString();
        windowEnd = new Date(now + SYNC_WINDOW.futureDays * DAY_MS).toISOString();
        url = `${me}/calendars/${enc(calendarId)}/calendarView/delta?${new URLSearchParams({
          startDateTime: windowStart,
          endDateTime: windowEnd,
        }).toString()}`;
      }
      const events: ExtEvent[] = [];
      const removedIds: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < MAX_PAGES; i++) {
        const page = MPage.parse(await api(url, { headers: PREFER }));
        for (const raw of page.value) {
          const e = MEvent.safeParse(raw);
          if (!e.success) continue;
          if (e.data['@removed']) {
            removedIds.push(e.data.id);
            continue;
          }
          const ext = toExt(e.data, selfEmail);
          if (!ext) continue;
          if (ext.cancelled) removedIds.push(ext.externalId);
          else events.push(ext);
        }
        if (page['@odata.nextLink']) {
          url = page['@odata.nextLink'];
          continue;
        }
        cursor = page['@odata.deltaLink'] ?? null;
        break;
      }
      return { events, removedIds, state: { cursor, windowStart, windowEnd }, full: !fresh };
    },

    async instances() {
      return [];
    },

    async occurrenceId() {
      return null;
    },

    async createEvent(calendarId, input) {
      const created = MEvent.parse(
        await api(`${me}/calendars/${enc(calendarId)}/events`, {
          method: 'POST',
          body: graphBody(input),
        }),
      );
      return created.id;
    },

    async updateEvent(_calendarId, eventId, input, opts) {
      // Rows are occurrences: their rule lives in Outlook.
      if (input.rrule) throw unsupported();
      const body = graphBody({ ...input, rrule: undefined });
      if (input.seriesShift) Object.assign(body, await shiftedSeries(eventId, input));
      const updated = MEvent.parse(
        await api(`${me}/events/${enc(eventId)}`, {
          method: 'PATCH',
          body,
          // Rows keep the changeKey; the entity tag Graph compares is its weak form.
          ...(opts?.ifMatch ? { headers: { 'If-Match': `W/"${opts.ifMatch}"` } } : {}),
        }),
      );
      return updated.id;
    },

    async getEvent(_calendarId, eventId) {
      return toExt(
        MEvent.parse(await api(`${me}/events/${enc(eventId)}`, { headers: PREFER })),
        selfEmail,
      );
    },

    async deleteEvent(_calendarId, eventId) {
      try {
        await api(`${me}/events/${enc(eventId)}`, { method: 'DELETE' });
      } catch (err) {
        if (err instanceof ProviderError && err.status === 404) return;
        throw err;
      }
    },

    async respond(_calendarId, eventId, response) {
      const action =
        response === 'accepted'
          ? 'accept'
          : response === 'declined'
            ? 'decline'
            : 'tentativelyAccept';
      await api(`${me}/events/${enc(eventId)}/${action}`, {
        method: 'POST',
        body: { sendResponse: true },
      });
    },
    async watch(calendarId, address, token) {
      const res = (await api(`${GRAPH}/subscriptions`, {
        method: 'POST',
        body: {
          changeType: 'created,updated,deleted',
          notificationUrl: address,
          resource: `${me.slice(GRAPH.length + 1)}/calendars/${enc(calendarId)}/events`,
          expirationDateTime: graphExpiry(),
          clientState: token,
        },
      })) as { id: string; expirationDateTime: string };
      return { id: res.id, expiresAt: new Date(res.expirationDateTime).toISOString() };
    },
    async renew(channel) {
      const res = (await api(`${GRAPH}/subscriptions/${enc(channel.id)}`, {
        method: 'PATCH',
        body: { expirationDateTime: graphExpiry() },
      })) as { id: string; expirationDateTime: string };
      return { id: res.id, expiresAt: new Date(res.expirationDateTime).toISOString() };
    },
    async unwatch(channel) {
      await api(`${GRAPH}/subscriptions/${enc(channel.id)}`, { method: 'DELETE' });
    },
  };
}

/** Graph keeps an event subscription at most 4230 minutes; ask for a little less. */
const graphExpiry = () => new Date(Date.now() + 4200 * 60_000).toISOString();
