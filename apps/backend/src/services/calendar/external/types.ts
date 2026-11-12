import type { CalendarExternalData, CalendarSyncState } from '@crewhall/db';

/** Provider-neutral shapes the Google and Microsoft adapters translate to and from. */

export interface ExtCalendar {
  externalId: string;
  name: string;
  writable: boolean;
  primary: boolean;
}

/** All-day date (`YYYY-MM-DD`, end exclusive) or an instant. */
export type ExtTime = { allDay: true; date: string } | { allDay: false; at: Date };

export interface ExtEvent {
  externalId: string;
  etag: string | null;
  /** Deleted at the provider (a cancelled Google occurrence removes one date of its series). */
  cancelled: boolean;
  /** Google: this is a changed (or cancelled) occurrence of that series. */
  parentExternalId: string | null;
  /** Google: the occurrence's original start (its key in the series). */
  originalStart: ExtTime | null;
  title: string;
  description: string | null;
  location: string | null;
  start: ExtTime;
  end: ExtTime;
  /** IANA zone the event was written in. */
  timeZone: string;
  /** Google series: the rule (Crewhall's RRULE subset) and removed occurrences (keys). */
  rrule: string | null;
  exdates: string[];
  /** Google series whose rule Crewhall cannot expand: stored as single occurrences, read-only. */
  unsupportedRecurrence: boolean;
  status: 'confirmed' | 'tentative';
  busy: boolean;
  private: boolean;
  data: CalendarExternalData;
}

export interface DeltaResult {
  events: ExtEvent[];
  /** Ids the provider reported as deleted (Graph `@removed`). */
  removedIds: string[];
  state: CalendarSyncState;
  /** Everything was listed: rows not seen are gone. */
  full: boolean;
}

/** What Crewhall sends when it creates or changes an event (absent = unchanged). */
export interface ExtEventInput {
  title?: string;
  description?: string | null;
  location?: string | null;
  allDay?: boolean;
  /** Wire format: `YYYY-MM-DD` for all-day, ISO instant otherwise; both or neither. */
  start?: string;
  end?: string;
  timeZone?: string;
  rrule?: string | null;
  /** With rrule: removed occurrences (keys) to keep at the provider. */
  exdates?: string[];
  busy?: boolean;
  private?: boolean;
  /**
   * Microsoft "all events" from an occurrence: the series master moves by the occurrence's move
   * (`ms` for the start, `days` for the rule's first day, `lengthMs` the new duration).
   */
  seriesShift?: { ms: number; days: number; lengthMs: number };
  /** The whole invitee list; known answers are passed back so they are kept. */
  attendees?: { email: string; optional: boolean; response?: ExtPersonResponse }[];
}

export type ExtResponse = 'accepted' | 'declined' | 'tentative';
export type ExtPersonResponse = ExtResponse | 'needs_action';

/** A provider API call with the account's token (refreshed and retried once on 401). */
export type Api = (
  url: string,
  req?: {
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    body?: unknown;
    headers?: Record<string, string>;
  },
) => Promise<unknown>;

export interface ProviderClient {
  listCalendars(): Promise<ExtCalendar[]>;
  /** Changes since `state` (a full listing when it has no cursor). */
  delta(calendarId: string, state: CalendarSyncState | null): Promise<DeltaResult>;
  /** Google: occurrences of a series between two instants. */
  instances(calendarId: string, eventId: string, from: Date, to: Date): Promise<ExtEvent[]>;
  /** Google: the id of one occurrence of a series (by its original start). */
  occurrenceId(calendarId: string, eventId: string, start: ExtTime): Promise<string | null>;
  /** Returns the id of the created event (Microsoft: the series master for a recurring one). */
  createEvent(calendarId: string, input: ExtEventInput): Promise<string>;
  /** `ifMatch`: only if the event is still that version (a 412 ProviderError otherwise). */
  updateEvent(
    calendarId: string,
    eventId: string,
    input: ExtEventInput,
    opts?: { ifMatch?: string },
  ): Promise<string>;
  /** The event as the provider holds it now; null when it is not an event for us. */
  getEvent(calendarId: string, eventId: string): Promise<ExtEvent | null>;
  deleteEvent(calendarId: string, eventId: string): Promise<void>;
  respond(calendarId: string, eventId: string, response: ExtResponse): Promise<void>;
  /**
   * Change notifications to `address` (Google channel / Graph subscription) carrying `token`.
   * `renew` extends a live one when the provider can (Graph); otherwise a new one replaces it.
   */
  watch(calendarId: string, address: string, token: string): Promise<PushChannel>;
  renew(channel: PushChannel): Promise<PushChannel | null>;
  unwatch(channel: PushChannel): Promise<void>;
}

export interface PushChannel {
  id: string;
  resourceId?: string;
  expiresAt: string;
}

/** Window of past and future events a first sync brings in. */
export const SYNC_WINDOW = { pastDays: 180, futureDays: 400 } as const;
