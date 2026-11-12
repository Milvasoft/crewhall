import { z } from 'zod';
import { formatRRule, parseRRule } from '@crewhall/shared';
import { ProviderError } from './http';
import type {
  Api,
  DeltaResult,
  ExtCalendar,
  ExtEvent,
  ExtEventInput,
  ExtPersonResponse,
  ExtTime,
  ProviderClient,
} from './types';
import { basicOf, keyOf, parseBasic, wallDate, zoneOf } from './wall';

/**
 * Google Calendar API v3. Series come as one event with RRULE/EXDATE lines; changed and
 * cancelled occurrences come as their own events pointing at the series (recurringEventId).
 * That matches Crewhall's model (series row + overrides + exdates) one to one.
 */

const BASE = 'https://www.googleapis.com/calendar/v3';
const enc = encodeURIComponent;
const MAX_PAGES = 100;

const qs = (params: Record<string, string | undefined>) =>
  new URLSearchParams(
    Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined),
  ).toString();

const GTime = z.object({
  date: z.string().optional(),
  dateTime: z.string().optional(),
  timeZone: z.string().optional(),
});

const GEvent = z.object({
  id: z.string(),
  etag: z.string().optional(),
  status: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  start: GTime.optional(),
  end: GTime.optional(),
  recurrence: z.array(z.string()).optional(),
  recurringEventId: z.string().optional(),
  originalStartTime: GTime.optional(),
  transparency: z.string().optional(),
  visibility: z.string().optional(),
  eventType: z.string().optional(),
  attendees: z
    .array(
      z.object({
        email: z.string().optional(),
        displayName: z.string().optional(),
        responseStatus: z.string().optional(),
        self: z.boolean().optional(),
        organizer: z.boolean().optional(),
        optional: z.boolean().optional(),
        resource: z.boolean().optional(),
      }),
    )
    .optional(),
  organizer: z
    .object({
      email: z.string().optional(),
      displayName: z.string().optional(),
      self: z.boolean().optional(),
    })
    .optional(),
  hangoutLink: z.string().optional(),
  conferenceData: z
    .object({
      entryPoints: z
        .array(z.object({ entryPointType: z.string().optional(), uri: z.string().optional() }))
        .optional(),
    })
    .optional(),
  htmlLink: z.string().optional(),
});
type GEvent = z.infer<typeof GEvent>;

const GList = z.object({
  items: z.array(z.unknown()).default([]),
  nextPageToken: z.string().optional(),
  nextSyncToken: z.string().optional(),
  timeZone: z.string().optional(),
});

const GCalendarList = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        summary: z.string().optional(),
        summaryOverride: z.string().optional(),
        accessRole: z.string().optional(),
        primary: z.boolean().optional(),
        deleted: z.boolean().optional(),
      }),
    )
    .default([]),
  nextPageToken: z.string().optional(),
});

const RESPONSE: Record<string, ExtPersonResponse> = {
  needsAction: 'needs_action',
  accepted: 'accepted',
  declined: 'declined',
  tentative: 'tentative',
};
const TO_GOOGLE: Record<ExtPersonResponse, string> = {
  needs_action: 'needsAction',
  accepted: 'accepted',
  declined: 'declined',
  tentative: 'tentative',
};

function gTime(t: z.infer<typeof GTime> | undefined): ExtTime | null {
  if (t?.date) return { allDay: true, date: t.date };
  if (t?.dateTime) {
    const at = new Date(t.dateTime);
    return Number.isNaN(at.getTime()) ? null : { allDay: false, at };
  }
  return null;
}

/** RRULE / EXDATE lines of a series; RDATE, EXRULE and rules we cannot expand are unsupported. */
export function parseRecurrence(lines: string[], tz: string, allDay: boolean) {
  let rrule: string | null = null;
  let unsupported = false;
  const exdates: string[] = [];
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const head = line.slice(0, colon).split(';');
    const value = line.slice(colon + 1);
    const name = head[0]!.toUpperCase();
    const tzid = head.find((p) => p.toUpperCase().startsWith('TZID='))?.slice(5);
    if (name === 'RRULE') {
      const rule = rrule === null ? parseRRule(value) : null;
      if (!rule) unsupported = true;
      else rrule = formatRRule(rule);
    } else if (name === 'EXDATE') {
      for (const v of value.split(',')) {
        const t = parseBasic(v, zoneOf(tzid, tz));
        if (!t) continue;
        if (allDay) exdates.push(t.allDay ? t.date : wallDate(t.at, tz));
        else if (!t.allDay) exdates.push(keyOf(t));
      }
    } else if (name === 'RDATE' || name === 'EXRULE') {
      unsupported = true;
    }
  }
  return { rrule: unsupported ? null : rrule, exdates, unsupported };
}

function blank(id: string): ExtEvent {
  const epoch: ExtTime = { allDay: false, at: new Date(0) };
  return {
    externalId: id,
    etag: null,
    cancelled: false,
    parentExternalId: null,
    originalStart: null,
    title: '',
    description: null,
    location: null,
    start: epoch,
    end: epoch,
    timeZone: 'UTC',
    rrule: null,
    exdates: [],
    unsupportedRecurrence: false,
    status: 'confirmed',
    busy: true,
    private: false,
    data: {
      organizer: null,
      attendees: [],
      joinUrl: null,
      webUrl: null,
      readOnly: false,
      seriesMasterId: null,
    },
  };
}

export function toExt(
  e: GEvent,
  calendarTz: string | undefined,
  selfEmail: string,
): ExtEvent | null {
  // Working-location markers are not events.
  if (e.eventType === 'workingLocation') return null;
  const tz = zoneOf(e.start?.timeZone, e.originalStartTime?.timeZone, calendarTz);
  const parent = e.recurringEventId ?? null;
  const originalStart = gTime(e.originalStartTime);
  if (e.status === 'cancelled') {
    return {
      ...blank(e.id),
      cancelled: true,
      parentExternalId: parent,
      originalStart,
      timeZone: tz,
    };
  }
  const start = gTime(e.start);
  const end = gTime(e.end);
  if (!start || !end || start.allDay !== end.allDay) return null;
  const self = selfEmail.toLowerCase();
  const attendees = (e.attendees ?? [])
    .filter((a) => a.email && !a.resource)
    .map((a) => ({
      email: a.email!.toLowerCase(),
      name: a.displayName ?? null,
      response: RESPONSE[a.responseStatus ?? ''] ?? 'needs_action',
      self: Boolean(a.self) || a.email!.toLowerCase() === self,
      optional: Boolean(a.optional),
    }));
  const mine = attendees.find((a) => a.self)?.response;
  const recurrence =
    e.recurrence?.length && !parent ? parseRecurrence(e.recurrence, tz, start.allDay) : null;
  const video = e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri;
  return {
    ...blank(e.id),
    etag: e.etag ?? null,
    parentExternalId: parent,
    originalStart,
    title: e.summary?.trim() || '',
    description: e.description ?? null,
    location: e.location ?? null,
    start,
    end,
    timeZone: tz,
    rrule: recurrence?.rrule ?? null,
    exdates: recurrence?.exdates ?? [],
    unsupportedRecurrence: recurrence?.unsupported ?? false,
    status: e.status === 'tentative' ? 'tentative' : 'confirmed',
    busy: e.transparency !== 'transparent' && mine !== 'declined',
    private: e.visibility === 'private' || e.visibility === 'confidential',
    data: {
      organizer: e.organizer?.email
        ? {
            email: e.organizer.email.toLowerCase(),
            name: e.organizer.displayName ?? null,
            self: Boolean(e.organizer.self),
          }
        : null,
      attendees,
      joinUrl: e.hangoutLink ?? video ?? null,
      webUrl: e.htmlLink ?? null,
      readOnly: false,
      seriesMasterId: null,
    },
  };
}

function timeBody(allDay: boolean, wire: string, tz: string) {
  // Nulls clear the other form on PATCH (timed ↔ all-day).
  return allDay
    ? { date: wire, dateTime: null, timeZone: null }
    : { dateTime: wire, date: null, timeZone: tz };
}

export function googleBody(input: ExtEventInput): Record<string, unknown> {
  const b: Record<string, unknown> = {};
  if (input.title !== undefined) b.summary = input.title;
  if (input.description !== undefined) b.description = input.description ?? '';
  if (input.location !== undefined) b.location = input.location ?? '';
  if (input.start !== undefined && input.end !== undefined) {
    const tz = input.timeZone ?? 'UTC';
    b.start = timeBody(Boolean(input.allDay), input.start, tz);
    b.end = timeBody(Boolean(input.allDay), input.end, tz);
  }
  if (input.rrule !== undefined) {
    b.recurrence = input.rrule
      ? [
          `RRULE:${input.rrule}`,
          ...(input.exdates ?? []).map((k) =>
            k.length === 10 ? `EXDATE;VALUE=DATE:${basicOf(k)}` : `EXDATE:${basicOf(k)}`,
          ),
        ]
      : [];
  }
  if (input.busy !== undefined) b.transparency = input.busy ? 'opaque' : 'transparent';
  if (input.private !== undefined) b.visibility = input.private ? 'private' : 'default';
  if (input.attendees !== undefined) {
    b.attendees = input.attendees.map((a) => ({
      email: a.email,
      ...(a.optional ? { optional: true } : {}),
      ...(a.response ? { responseStatus: TO_GOOGLE[a.response] } : {}),
    }));
  }
  return b;
}

export function googleClient(api: Api, selfEmail: string): ProviderClient {
  const events = (calendarId: string) => `${BASE}/calendars/${enc(calendarId)}/events`;

  const list = async (url: string, calendarTz?: string) => {
    const out: ExtEvent[] = [];
    let pageToken: string | undefined;
    let tz = calendarTz;
    let syncToken: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const sep = url.includes('?') ? '&' : '?';
      const page = GList.parse(await api(pageToken ? `${url}${sep}${qs({ pageToken })}` : url));
      tz = page.timeZone ?? tz;
      for (const raw of page.items) {
        const ev = GEvent.safeParse(raw);
        if (!ev.success) continue;
        const ext = toExt(ev.data, tz, selfEmail);
        if (ext) out.push(ext);
      }
      if (!page.nextPageToken) {
        syncToken = page.nextSyncToken;
        break;
      }
      pageToken = page.nextPageToken;
    }
    return { events: out, syncToken };
  };

  return {
    async listCalendars(): Promise<ExtCalendar[]> {
      const out: ExtCalendar[] = [];
      let pageToken: string | undefined;
      for (let i = 0; i < 20; i++) {
        const page = GCalendarList.parse(
          await api(
            `${BASE}/users/me/calendarList?${qs({ minAccessRole: 'reader', maxResults: '250', pageToken })}`,
          ),
        );
        for (const c of page.items) {
          if (c.deleted) continue;
          out.push({
            externalId: c.id,
            name: (c.summaryOverride ?? c.summary ?? c.id).slice(0, 200),
            writable: c.accessRole === 'owner' || c.accessRole === 'writer',
            primary: Boolean(c.primary),
          });
        }
        if (!page.nextPageToken) break;
        pageToken = page.nextPageToken;
      }
      return out;
    },

    async delta(calendarId, state): Promise<DeltaResult> {
      const full = !state?.cursor;
      // A full listing (no time bounds, or Google issues no sync token); cancelled occurrences of
      // series still come because showDeleted and singleEvents are both false.
      const url = `${events(calendarId)}?${qs(
        full
          ? { maxResults: '2500', singleEvents: 'false' }
          : { maxResults: '2500', syncToken: state!.cursor! },
      )}`;
      const res = await list(url);
      return { events: res.events, removedIds: [], state: { cursor: res.syncToken ?? null }, full };
    },

    async instances(calendarId, eventId, from, to) {
      const url = `${events(calendarId)}/${enc(eventId)}/instances?${qs({
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        maxResults: '2500',
      })}`;
      return (await list(url)).events.filter((e) => !e.cancelled);
    },

    async occurrenceId(calendarId, eventId, start) {
      const url = `${events(calendarId)}/${enc(eventId)}/instances?${qs({
        originalStart: start.allDay ? start.date : start.at.toISOString(),
        maxResults: '1',
        showDeleted: 'false',
      })}`;
      const page = GList.parse(await api(url));
      const first = GEvent.safeParse(page.items[0]);
      return first.success ? first.data.id : null;
    },

    async createEvent(calendarId, input) {
      const created = GEvent.parse(
        await api(`${events(calendarId)}?sendUpdates=all`, {
          method: 'POST',
          body: googleBody(input),
        }),
      );
      return created.id;
    },

    async updateEvent(calendarId, eventId, input, opts) {
      const updated = GEvent.parse(
        await api(`${events(calendarId)}/${enc(eventId)}?sendUpdates=all`, {
          method: 'PATCH',
          body: googleBody(input),
          ...(opts?.ifMatch ? { headers: { 'If-Match': opts.ifMatch } } : {}),
        }),
      );
      return updated.id;
    },

    async getEvent(calendarId, eventId) {
      const raw = GEvent.parse(await api(`${events(calendarId)}/${enc(eventId)}`));
      return toExt(raw, undefined, selfEmail);
    },

    async deleteEvent(calendarId, eventId) {
      try {
        await api(`${events(calendarId)}/${enc(eventId)}?sendUpdates=all`, { method: 'DELETE' });
      } catch (err) {
        // Already gone at Google.
        if (err instanceof ProviderError && (err.status === 404 || err.status === 410)) return;
        throw err;
      }
    },

    async respond(calendarId, eventId, response) {
      const url = `${events(calendarId)}/${enc(eventId)}`;
      const ev = GEvent.parse(await api(url));
      const self = selfEmail.toLowerCase();
      const attendees = ev.attendees ?? [];
      const me = attendees.find((a) => a.self || a.email?.toLowerCase() === self);
      if (!me) throw new ProviderError(400, 'not_attendee');
      me.responseStatus = TO_GOOGLE[response];
      await api(`${url}?sendUpdates=all`, { method: 'PATCH', body: { attendees } });
    },
    async watch(calendarId, address, token) {
      const res = (await api(`${events(calendarId)}/watch`, {
        method: 'POST',
        body: {
          id: crypto.randomUUID(),
          type: 'web_hook',
          address,
          token,
          // A week, the longest Google keeps an events channel.
          params: { ttl: String(7 * 86_400) },
        },
      })) as { id: string; resourceId?: string; expiration?: string };
      return {
        id: res.id,
        resourceId: res.resourceId,
        expiresAt: new Date(Number(res.expiration) || Date.now() + 7 * 86_400_000).toISOString(),
      };
    },
    // Google channels cannot be extended: a new one replaces the old.
    async renew() {
      return null;
    },
    async unwatch(channel) {
      await api(`${BASE}/channels/stop`, {
        method: 'POST',
        body: { id: channel.id, resourceId: channel.resourceId },
      });
    },
  };
}
