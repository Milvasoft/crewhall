import { zonedToUtc } from '@crewhall/shared';
import { AppError } from '../../../../http/errors';
import { windowsZoneOf } from '../../ics';
import type { XmlElement } from '../../xml';
import { ProviderError } from '../http';
import { graphRecurrence } from '../microsoft';
import {
  SYNC_WINDOW,
  type DeltaResult,
  type ExtCalendar,
  type ExtEvent,
  type ExtEventInput,
  type ExtPersonResponse,
  type ProviderClient,
} from '../types';
import { parseWall, wallDate, zoneOf } from '../wall';
import {
  childOf,
  childrenNamed,
  el,
  folderRef,
  getItems,
  itemIdXml,
  single,
  syncFolder,
  textOf,
  x,
  type EwsConnection,
} from './soap';

/**
 * On-premises Exchange. Like Graph, every occurrence is its own row: a calendar view expands
 * series, and changes in Crewhall apply to that occurrence or go to the series master. Exchange
 * has no calendar delta that expands series, so SyncFolderItems only tells whether anything
 * changed; if so the window is listed again whole. No change notifications: the five-minute poll
 * covers them.
 */

const DAY_MS = 86_400_000;
const CHUNK_DAYS = 60;
const TIMEZONE_FIELD = '<t:FieldURI FieldURI="calendar:StartTimeZoneId"/>';

const RESPONSE: Record<string, ExtPersonResponse> = {
  Unknown: 'needs_action',
  NoResponseReceived: 'needs_action',
  Organizer: 'accepted',
  Accept: 'accepted',
  Tentative: 'tentative',
  Decline: 'declined',
};

const unsupported = (reason: string) => new AppError('calendar_external_unsupported', { reason });

function attendeesOf(item: XmlElement, self: string) {
  const list = (name: string, optional: boolean) =>
    (childOf(item, name)?.children ?? []).flatMap((a) => {
      const mailbox = childOf(a, 'Mailbox');
      const email = textOf(mailbox, 'EmailAddress')?.toLowerCase();
      // Internal X.500 addresses (no SMTP form known) cannot be invited or shown.
      if (!email?.includes('@')) return [];
      return [
        {
          email,
          name: textOf(mailbox, 'Name'),
          response: RESPONSE[textOf(a, 'ResponseType') ?? ''] ?? ('needs_action' as const),
          self: email === self,
          optional,
        },
      ];
    });
  return [...list('RequiredAttendees', false), ...list('OptionalAttendees', true)];
}

/** A calendar item as Crewhall sees it; null when its times are unusable. */
export function toExt(
  item: XmlElement,
  selfEmail: string,
  seriesMasterId: string | null,
): ExtEvent | null {
  const id = childOf(item, 'ItemId');
  const startText = textOf(item, 'Start');
  const endText = textOf(item, 'End');
  if (!id?.attrs.Id || !startText || !endText) return null;
  const at = new Date(startText);
  const until = new Date(endText);
  if (Number.isNaN(at.getTime()) || Number.isNaN(until.getTime())) return null;
  const timeZone = zoneOf(textOf(item, 'StartTimeZoneId'));
  const allDay = textOf(item, 'IsAllDayEvent') === 'true';
  const status = textOf(item, 'LegacyFreeBusyStatus') ?? 'Busy';
  const mine = RESPONSE[textOf(item, 'MyResponseType') ?? ''];
  const sensitivity = textOf(item, 'Sensitivity');
  const organizer = childOf(childOf(item, 'Organizer'), 'Mailbox');
  const organizerEmail = textOf(organizer, 'EmailAddress')?.toLowerCase();
  const self = selfEmail.toLowerCase();
  const description = textOf(item, 'Body');
  return {
    externalId: id.attrs.Id,
    etag: id.attrs.ChangeKey ?? null,
    cancelled: textOf(item, 'IsCancelled') === 'true',
    parentExternalId: null,
    originalStart: null,
    title: textOf(item, 'Subject') ?? '',
    description: description ? description.slice(0, 10_000) : null,
    location: textOf(item, 'Location'),
    start: allDay ? { allDay: true, date: wallDate(at, timeZone) } : { allDay: false, at },
    end: allDay ? { allDay: true, date: wallDate(until, timeZone) } : { allDay: false, at: until },
    timeZone,
    rrule: null,
    exdates: [],
    unsupportedRecurrence: false,
    status: status === 'Tentative' ? 'tentative' : 'confirmed',
    busy: status !== 'Free' && status !== 'WorkingElsewhere' && mine !== 'declined',
    private: sensitivity === 'Private' || sensitivity === 'Confidential',
    data: {
      organizer: organizerEmail?.includes('@')
        ? {
            email: organizerEmail,
            name: textOf(organizer, 'Name'),
            self: organizerEmail === self || textOf(item, 'MyResponseType') === 'Organizer',
          }
        : null,
      attendees: attendeesOf(item, self),
      joinUrl: null,
      webUrl: null,
      readOnly: false,
      seriesMasterId,
    },
  };
}

// ---- writing ------------------------------------------------------------------------------------

const DAY_NAMES: Record<string, string> = {
  sunday: 'Sunday',
  monday: 'Monday',
  tuesday: 'Tuesday',
  wednesday: 'Wednesday',
  thursday: 'Thursday',
  friday: 'Friday',
  saturday: 'Saturday',
};
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const INDEX: Record<string, string> = {
  first: 'First',
  second: 'Second',
  third: 'Third',
  fourth: 'Fourth',
  last: 'Last',
};

const days = (v: unknown) => (v as string[]).map((d) => DAY_NAMES[d] ?? d).join(' ');

/** Crewhall's rule through the Graph form, which has the same shapes as EWS. */
export function recurrenceXml(rrule: string, startDate: string, tz: string) {
  const { pattern: p, range: r } = graphRecurrence(rrule, startDate, tz);
  const interval = `<t:Interval>${String(p.interval)}</t:Interval>`;
  let pattern: string;
  switch (p.type) {
    case 'daily':
      pattern = `<t:DailyRecurrence>${interval}</t:DailyRecurrence>`;
      break;
    case 'weekly':
      pattern =
        `<t:WeeklyRecurrence>${interval}<t:DaysOfWeek>${days(p.daysOfWeek)}</t:DaysOfWeek>` +
        `<t:FirstDayOfWeek>${DAY_NAMES[p.firstDayOfWeek as string]}</t:FirstDayOfWeek></t:WeeklyRecurrence>`;
      break;
    case 'absoluteMonthly':
      pattern = `<t:AbsoluteMonthlyRecurrence>${interval}<t:DayOfMonth>${String(p.dayOfMonth)}</t:DayOfMonth></t:AbsoluteMonthlyRecurrence>`;
      break;
    case 'relativeMonthly':
      pattern =
        `<t:RelativeMonthlyRecurrence>${interval}<t:DaysOfWeek>${days(p.daysOfWeek)}</t:DaysOfWeek>` +
        `<t:DayOfWeekIndex>${INDEX[p.index as string]}</t:DayOfWeekIndex></t:RelativeMonthlyRecurrence>`;
      break;
    case 'absoluteYearly':
      // EWS has no yearly interval other than one.
      if (p.interval !== 1) throw unsupported('recurrence');
      pattern = `<t:AbsoluteYearlyRecurrence><t:DayOfMonth>${String(p.dayOfMonth)}</t:DayOfMonth><t:Month>${MONTHS[(p.month as number) - 1]}</t:Month></t:AbsoluteYearlyRecurrence>`;
      break;
    case 'relativeYearly':
      if (p.interval !== 1) throw unsupported('recurrence');
      pattern =
        `<t:RelativeYearlyRecurrence><t:DaysOfWeek>${days(p.daysOfWeek)}</t:DaysOfWeek>` +
        `<t:DayOfWeekIndex>${INDEX[p.index as string]}</t:DayOfWeekIndex><t:Month>${MONTHS[(p.month as number) - 1]}</t:Month></t:RelativeYearlyRecurrence>`;
      break;
    default:
      throw unsupported('recurrence');
  }
  const start = `<t:StartDate>${String(r.startDate)}</t:StartDate>`;
  const range =
    r.type === 'numbered'
      ? `<t:NumberedRecurrence>${start}<t:NumberOfOccurrences>${String(r.numberOfOccurrences)}</t:NumberOfOccurrences></t:NumberedRecurrence>`
      : r.type === 'endDate'
        ? `<t:EndDateRecurrence>${start}<t:EndDate>${String(r.endDate)}</t:EndDate></t:EndDateRecurrence>`
        : `<t:NoEndRecurrence>${start}</t:NoEndRecurrence>`;
  return `<t:Recurrence>${pattern}${range}</t:Recurrence>`;
}

/** Midnight of an all-day date in a zone: what Exchange expects of an all-day event. */
function midnight(date: string, tz: string) {
  const w = parseWall(`${date}T00:00:00`)!;
  return zonedToUtc(w, tz).toISOString();
}

interface Times {
  start: string;
  end: string;
  allDay: boolean;
  /** A Windows zone name; all-day events in a zone Exchange has no name for use UTC. */
  zoneId: string;
}

function timesOf(input: ExtEventInput): Times | null {
  if (input.start === undefined || input.end === undefined) return null;
  const zoneId = windowsZoneOf(input.timeZone ?? 'UTC');
  if (input.allDay) {
    const tz = zoneId === 'UTC' ? 'UTC' : (input.timeZone ?? 'UTC');
    return {
      start: midnight(input.start, tz),
      end: midnight(input.end, tz),
      allDay: true,
      zoneId,
    };
  }
  return {
    start: new Date(input.start).toISOString(),
    end: new Date(input.end).toISOString(),
    allDay: false,
    zoneId,
  };
}

const attendeeXml = (emails: string[]) =>
  emails
    .map(
      (e) =>
        `<t:Attendee><t:Mailbox><t:EmailAddress>${x(e)}</t:EmailAddress></t:Mailbox></t:Attendee>`,
    )
    .join('');

const bodyXml = (text: string | null) => `<t:Body BodyType="Text">${x(text ?? '')}</t:Body>`;

/** A new calendar item, its fields in schema order. */
export function calendarItemXml(input: ExtEventInput) {
  const t = timesOf(input);
  const required = input.attendees?.filter((a) => !a.optional).map((a) => a.email) ?? [];
  const optional = input.attendees?.filter((a) => a.optional).map((a) => a.email) ?? [];
  const startDate =
    t && input.rrule
      ? input.allDay
        ? input.start!
        : wallDate(new Date(input.start!), input.timeZone ?? 'UTC')
      : null;
  return (
    `<t:CalendarItem>` +
    el('Subject', input.title) +
    (input.private !== undefined
      ? `<t:Sensitivity>${input.private ? 'Private' : 'Normal'}</t:Sensitivity>`
      : '') +
    (input.description !== undefined ? bodyXml(input.description) : '') +
    (t
      ? `<t:Start>${t.start}</t:Start><t:End>${t.end}</t:End><t:IsAllDayEvent>${t.allDay}</t:IsAllDayEvent>`
      : '') +
    (input.busy !== undefined
      ? `<t:LegacyFreeBusyStatus>${input.busy ? 'Busy' : 'Free'}</t:LegacyFreeBusyStatus>`
      : '') +
    el('Location', input.location) +
    (required.length ? `<t:RequiredAttendees>${attendeeXml(required)}</t:RequiredAttendees>` : '') +
    (optional.length ? `<t:OptionalAttendees>${attendeeXml(optional)}</t:OptionalAttendees>` : '') +
    (input.rrule && startDate
      ? recurrenceXml(input.rrule, startDate, input.timeZone ?? 'UTC')
      : '') +
    (t ? `<t:StartTimeZone Id="${x(t.zoneId)}"/><t:EndTimeZone Id="${x(t.zoneId)}"/>` : '') +
    `</t:CalendarItem>`
  );
}

const setField = (uri: string, inner: string) =>
  `<t:SetItemField><t:FieldURI FieldURI="${uri}"/><t:CalendarItem>${inner}</t:CalendarItem></t:SetItemField>`;
const deleteField = (uri: string) =>
  `<t:DeleteItemField><t:FieldURI FieldURI="${uri}"/></t:DeleteItemField>`;

/** The changes of an update, one field at a time. */
export function updatesXml(input: ExtEventInput) {
  const out: string[] = [];
  if (input.title !== undefined) out.push(setField('item:Subject', el('Subject', input.title)));
  if (input.description !== undefined) out.push(setField('item:Body', bodyXml(input.description)));
  if (input.location !== undefined) {
    out.push(
      input.location
        ? setField('calendar:Location', el('Location', input.location))
        : deleteField('calendar:Location'),
    );
  }
  const t = timesOf(input);
  if (t) {
    out.push(
      setField('calendar:Start', `<t:Start>${t.start}</t:Start>`),
      setField('calendar:End', `<t:End>${t.end}</t:End>`),
      setField('calendar:IsAllDayEvent', `<t:IsAllDayEvent>${t.allDay}</t:IsAllDayEvent>`),
      setField('calendar:StartTimeZone', `<t:StartTimeZone Id="${x(t.zoneId)}"/>`),
      setField('calendar:EndTimeZone', `<t:EndTimeZone Id="${x(t.zoneId)}"/>`),
    );
  }
  if (input.busy !== undefined) {
    out.push(
      setField(
        'calendar:LegacyFreeBusyStatus',
        `<t:LegacyFreeBusyStatus>${input.busy ? 'Busy' : 'Free'}</t:LegacyFreeBusyStatus>`,
      ),
    );
  }
  if (input.private !== undefined) {
    out.push(
      setField(
        'item:Sensitivity',
        `<t:Sensitivity>${input.private ? 'Private' : 'Normal'}</t:Sensitivity>`,
      ),
    );
  }
  if (input.attendees !== undefined) {
    const of = (optional: boolean) =>
      input.attendees!.filter((a) => a.optional === optional).map((a) => a.email);
    const write = (uri: string, tag: string, emails: string[]) =>
      out.push(
        emails.length
          ? setField(uri, `<t:${tag}>${attendeeXml(emails)}</t:${tag}>`)
          : deleteField(uri),
      );
    write('calendar:RequiredAttendees', 'RequiredAttendees', of(false));
    write('calendar:OptionalAttendees', 'OptionalAttendees', of(true));
  }
  return out.join('');
}

const firstItem = (msg: XmlElement) => childOf(msg, 'Items')?.children[0] ?? null;

export function exchangeClient(
  connection: () => Promise<EwsConnection>,
  selfEmail: string,
): ProviderClient {
  /** Ids in a window. A view has a size limit: too many items split it. */
  const listView = async (
    conn: EwsConnection,
    folder: string,
    from: number,
    to: number,
    out: Set<string>,
  ) => {
    let tooMany: boolean;
    try {
      const msg = await single(
        conn,
        `<m:FindItem Traversal="Shallow"><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape></m:ItemShape>` +
          `<m:CalendarView MaxEntriesReturned="1000" StartDate="${new Date(from).toISOString()}" EndDate="${new Date(to).toISOString()}"/>` +
          `<m:ParentFolderIds>${folderRef(folder)}</m:ParentFolderIds></m:FindItem>`,
      );
      const root = childOf(msg, 'RootFolder');
      tooMany = root?.attrs.IncludesLastItemInRange === 'false';
      if (!tooMany) {
        for (const item of childOf(root, 'Items')?.children ?? []) {
          const id = childOf(item, 'ItemId')?.attrs.Id;
          if (id) out.add(id);
        }
      }
    } catch (err) {
      if (
        !(err instanceof ProviderError) ||
        !['ErrorCalendarViewRangeTooBig', 'ErrorExceededFindCountLimit'].includes(err.reason)
      ) {
        throw err;
      }
      tooMany = true;
    }
    if (!tooMany) return;
    if (to - from <= DAY_MS) throw new ProviderError(500, 'calendar_view_too_big');
    const middle = from + Math.floor((to - from) / 2);
    await listView(conn, folder, from, middle, out);
    await listView(conn, folder, middle, to, out);
  };

  /** The id of an occurrence's series. Occurrences of one series share a UID: asked once. */
  const masterOf = async (conn: EwsConnection, occurrenceId: string): Promise<string | null> => {
    const msg = await single(
      conn,
      `<m:GetItem><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape></m:ItemShape>` +
        `<m:ItemIds><t:RecurringMasterItemId OccurrenceId="${x(occurrenceId)}"/></m:ItemIds></m:GetItem>`,
    );
    return childOf(firstItem(msg), 'ItemId')?.attrs.Id ?? null;
  };

  const eventsOf = async (conn: EwsConnection, ids: string[]) => {
    const masters = new Map<string, string | null>();
    const events: ExtEvent[] = [];
    const removedIds: string[] = [];
    for (const item of await getItems(conn, ids, TIMEZONE_FIELD)) {
      if (item.name !== 'CalendarItem') continue;
      const kind = textOf(item, 'CalendarItemType');
      let master: string | null = null;
      if (kind === 'Occurrence' || kind === 'Exception') {
        const uid = textOf(item, 'UID') ?? childOf(item, 'ItemId')?.attrs.Id ?? '';
        if (!masters.has(uid)) {
          masters.set(uid, await masterOf(conn, childOf(item, 'ItemId')!.attrs.Id!));
        }
        master = masters.get(uid) ?? null;
      }
      const ext = toExt(item, selfEmail, master);
      if (!ext) continue;
      if (ext.cancelled) removedIds.push(ext.externalId);
      else events.push(ext);
    }
    return { events, removedIds };
  };

  return {
    async listCalendars(): Promise<ExtCalendar[]> {
      const conn = await connection();
      const shape = `<m:FolderShape><t:BaseShape>AllProperties</t:BaseShape></m:FolderShape>`;
      const toCalendar = (f: XmlElement, primary: boolean): ExtCalendar[] => {
        const id = childOf(f, 'FolderId')?.attrs.Id;
        if (!id) return [];
        return [
          {
            externalId: id,
            name: (textOf(f, 'DisplayName') ?? 'Exchange').slice(0, 200),
            writable: textOf(childOf(f, 'EffectiveRights'), 'CreateContents') !== 'false',
            primary,
          },
        ];
      };
      const main = await single(
        conn,
        `<m:GetFolder>${shape}<m:FolderIds><t:DistinguishedFolderId Id="calendar"/></m:FolderIds></m:GetFolder>`,
      );
      const out = (childOf(main, 'Folders')?.children ?? []).flatMap((f) => toCalendar(f, true));
      const below = await single(
        conn,
        `<m:FindFolder Traversal="Deep">${shape}<m:ParentFolderIds><t:DistinguishedFolderId Id="calendar"/></m:ParentFolderIds></m:FindFolder>`,
      );
      const folders = childOf(childOf(below, 'RootFolder'), 'Folders');
      out.push(...childrenNamed(folders, 'CalendarFolder').flatMap((f) => toCalendar(f, false)));
      return out;
    },

    async delta(calendarId, state): Promise<DeltaResult> {
      const conn = await connection();
      const now = Date.now();
      const fresh =
        state?.cursor &&
        state.windowEnd &&
        Date.parse(state.windowEnd) - now > (SYNC_WINDOW.futureDays - 60) * DAY_MS;
      const changes = await syncFolder(conn, calendarId, fresh ? state!.cursor : null);
      if (fresh && !changes.any) {
        return {
          events: [],
          removedIds: [],
          state: {
            cursor: changes.syncState,
            windowStart: state!.windowStart,
            windowEnd: state!.windowEnd,
          },
          full: false,
        };
      }
      const from = now - SYNC_WINDOW.pastDays * DAY_MS;
      const to = now + SYNC_WINDOW.futureDays * DAY_MS;
      const ids = new Set<string>();
      for (let at = from; at < to; at += CHUNK_DAYS * DAY_MS) {
        await listView(conn, calendarId, at, Math.min(at + CHUNK_DAYS * DAY_MS, to), ids);
      }
      const { events, removedIds } = await eventsOf(conn, [...ids]);
      return {
        events,
        removedIds,
        state: {
          cursor: changes.syncState,
          windowStart: new Date(from).toISOString(),
          windowEnd: new Date(to).toISOString(),
        },
        full: true,
      };
    },

    async instances() {
      return [];
    },

    async occurrenceId() {
      return null;
    },

    async createEvent(calendarId, input) {
      const msg = await single(
        await connection(),
        `<m:CreateItem SendMeetingInvitations="SendToAllAndSaveCopy">` +
          `<m:SavedItemFolderId>${folderRef(calendarId)}</m:SavedItemFolderId>` +
          `<m:Items>${calendarItemXml(input)}</m:Items></m:CreateItem>`,
      );
      const id = childOf(firstItem(msg), 'ItemId')?.attrs.Id;
      if (!id) throw new ProviderError(500, 'no_item_id');
      return id;
    },

    async updateEvent(_calendarId, eventId, input, opts) {
      if (input.rrule) throw unsupported('recurrence');
      // A series' times and its rule's first day move together; that stays in Outlook here.
      if (input.seriesShift) throw unsupported('series_move');
      const updates = updatesXml(input);
      if (!updates) return eventId;
      const msg = await single(
        await connection(),
        `<m:UpdateItem ConflictResolution="${opts?.ifMatch ? 'NeverOverwrite' : 'AlwaysOverwrite'}" SendMeetingInvitationsOrCancellations="SendToAllAndSaveCopy">` +
          `<m:ItemChanges><t:ItemChange>${itemIdXml(eventId, opts?.ifMatch)}<t:Updates>${updates}</t:Updates></t:ItemChange></m:ItemChanges></m:UpdateItem>`,
      );
      return childOf(firstItem(msg), 'ItemId')?.attrs.Id ?? eventId;
    },

    async getEvent(_calendarId, eventId) {
      const conn = await connection();
      const { events } = await eventsOf(conn, [eventId]);
      return events[0] ?? null;
    },

    async deleteEvent(_calendarId, eventId) {
      try {
        await single(
          await connection(),
          `<m:DeleteItem DeleteType="MoveToDeletedItems" SendMeetingCancellations="SendToAllAndSaveCopy" AffectedTaskOccurrences="AllOccurrences">` +
            `<m:ItemIds>${itemIdXml(eventId)}</m:ItemIds></m:DeleteItem>`,
        );
      } catch (err) {
        if (err instanceof ProviderError && err.status === 404) return;
        throw err;
      }
    },

    async respond(_calendarId, eventId, response) {
      const conn = await connection();
      const [item] = await getItems(conn, [eventId]);
      const id = childOf(item, 'ItemId');
      if (!id?.attrs.Id) throw new ProviderError(404, 'ErrorItemNotFound');
      const tag =
        response === 'accepted'
          ? 'AcceptItem'
          : response === 'declined'
            ? 'DeclineItem'
            : 'TentativelyAcceptItem';
      await single(
        conn,
        `<m:CreateItem MessageDisposition="SendAndSaveCopy"><m:Items><t:${tag}>` +
          `<t:ReferenceItemId Id="${x(id.attrs.Id)}"${id.attrs.ChangeKey ? ` ChangeKey="${x(id.attrs.ChangeKey)}"` : ''}/>` +
          `</t:${tag}></m:Items></m:CreateItem>`,
      );
    },

    // The poll is all there is on Exchange; sync does not ask for these.
    async watch() {
      throw new ProviderError(501, 'no_push');
    },
    async renew() {
      return null;
    },
    async unwatch() {},
  };
}
