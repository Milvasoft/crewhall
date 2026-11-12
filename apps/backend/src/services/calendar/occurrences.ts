import type { CalendarProvider } from '@crewhall/shared';
import { and, eq, gt, inArray, isNotNull, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import {
  boardCards,
  boardColumns,
  boards,
  calendarAccounts,
  calendarAttendees,
  calendarEvents,
  calendars,
  cardAssignees,
  meetingInvitees,
  meetings,
  meetingSessions,
  nodes,
  spaces,
  type DbOrTx,
} from '@crewhall/db';
import {
  can,
  dateToDay,
  dayToDate,
  expandRRule,
  zonedDay,
  parseRRule,
  startOfZonedDay,
  type CalendarOccurrence,
  type FreeBusy,
  type MeetingRecurrence,
  type OccurrencesQuery,
  type SpaceColor,
  paths,
} from '@crewhall/shared';
import type { z } from 'zod';
import type { OccurrencesQuery as QuerySchema } from '@crewhall/shared';
import { AppError } from '../../http/errors';
import { isModuleEnabled } from '../identity/modules';
import { nodeResource, roleForPath, spaceRoleOf, userSharePaths } from '../drive/access';
import { readableCalendars, type CalActor, type CalendarAccess, type EventRow } from './access';
import { eventAccessFor, expandRow, wireTimes } from './events';
import { meetingLinks } from './meeting';
import { settingsFor } from './settings';

type Query = z.output<typeof QuerySchema>;
export type { OccurrencesQuery };

const DAY_MS = 86_400_000;

/** Meetings of a calendar event show (and count as busy) through the event only. */
const notLinkedToEvent = sql`${meetings.id} not in (select ${calendarEvents.meetingId} from ${calendarEvents} where ${calendarEvents.meetingId} is not null and ${calendarEvents.deletedAt} is null)`;
const LIMIT = 3000;

/** Rows of series and single events that may have an occurrence in [from, to). */
function rangeCondition(from: Date, to: Date): SQL {
  // All-day rows sort as UTC midnights; a day of slack each side covers every zone.
  const f = new Date(from.getTime() - DAY_MS);
  const t = new Date(to.getTime() + DAY_MS);
  return and(
    lt(calendarEvents.startsAt, t),
    or(isNull(calendarEvents.seriesEndsAt), gt(calendarEvents.seriesEndsAt, f)),
  )!;
}

export interface ExpandedEvent {
  row: EventRow;
  series: EventRow;
  key: string;
  start: string;
  end: string;
}

/** Series in range expanded with their changed and removed occurrences. */
export async function expandSeries(
  db: DbOrTx,
  seriesRows: EventRow[],
  from: Date,
  to: Date,
): Promise<ExpandedEvent[]> {
  if (!seriesRows.length) return [];
  const ids = seriesRows.map((r) => r.id);
  const overrides = await db
    .select()
    .from(calendarEvents)
    .where(and(inArray(calendarEvents.parentId, ids), isNull(calendarEvents.deletedAt)));
  const out: ExpandedEvent[] = [];
  for (const s of seriesRows) {
    const mine = overrides.filter((o) => o.parentId === s.id);
    const skip = new Set([...s.exdates, ...mine.map((o) => o.recurrenceId!)]);
    for (const o of expandRow(s, from, to, skip, LIMIT)) {
      out.push({ row: s, series: s, key: o.key, start: o.start, end: o.end });
    }
    for (const o of mine) {
      if (o.status === 'cancelled') continue;
      const inRange = o.allDay
        ? o.startsAt.getTime() < to.getTime() + DAY_MS &&
          o.endsAt.getTime() > from.getTime() - DAY_MS
        : o.startsAt < to && o.endsAt > from;
      if (!inRange) continue;
      const t = wireTimes(o);
      out.push({ row: o, series: s, key: o.recurrenceId!, start: t.start, end: t.end });
    }
  }
  return out;
}

const meetingRule: Record<MeetingRecurrence, string | null> = {
  none: null,
  daily: 'FREQ=DAILY',
  weekdays: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
  weekly: 'FREQ=WEEKLY',
};

/** Occurrences of scheduled meetings; meet steps them by whole days in UTC (schedule.ts). */
function meetingTimes(
  m: { startsAt: Date; durationMinutes: number; recurrence: MeetingRecurrence },
  from: Date,
  to: Date,
) {
  const duration = m.durationMinutes * 60_000;
  const text = meetingRule[m.recurrence];
  if (!text) {
    return m.startsAt < to && m.startsAt.getTime() + duration > from.getTime()
      ? [
          {
            key: m.startsAt.toISOString(),
            start: m.startsAt,
            end: new Date(m.startsAt.getTime() + duration),
          },
        ]
      : [];
  }
  return expandRRule({
    rule: parseRRule(text)!,
    allDay: false,
    start: m.startsAt,
    timeZone: 'UTC',
    duration,
    from,
    to,
    limit: 500,
  }).map((o) => ({ key: o.key, start: o.start as Date, end: o.end as Date }));
}

export async function listOccurrences(
  db: DbOrTx,
  a: CalActor,
  q: Query,
): Promise<{ items: CalendarOccurrence[] }> {
  const from = new Date(q.from);
  const to = new Date(q.to);
  const settings = await settingsFor(db, a.org.id, a.userId);
  const all = await readableCalendars(db, a);
  const personal = all.find(
    (c) => c.calendar.kind === 'personal' && c.calendar.ownerId === a.userId,
  );

  let shown: CalendarAccess[];
  if (q.spaceId) {
    shown = all.filter((c) => c.calendar.spaceId === q.spaceId);
    if (!shown.length) throw new AppError('not_found');
  } else if (q.calendarIds) {
    const wanted = new Set(q.calendarIds);
    shown = all.filter((c) => wanted.has(c.calendar.id));
  } else {
    const hidden = new Set(settings.hiddenCalendarIds);
    shown = all.filter((c) => !hidden.has(c.calendar.id));
  }
  const shownIds = shown.map((c) => c.calendar.id);
  const byId = new Map(all.map((c) => [c.calendar.id, c]));
  // Invitations land in the personal calendar (shown with it, hidden with it).
  const withInvites =
    !q.spaceId && personal !== undefined && shownIds.includes(personal.calendar.id);

  const owned: SQL[] = [];
  if (shownIds.length) owned.push(inArray(calendarEvents.calendarId, shownIds));
  if (withInvites) {
    owned.push(
      sql`${calendarEvents.id} in (select ${calendarAttendees.eventId} from ${calendarAttendees} where ${calendarAttendees.userId} = ${a.userId}${settings.showDeclined ? sql`` : sql` and ${calendarAttendees.response} <> 'declined'`})`,
    );
  }
  const seriesRows = owned.length
    ? await db
        .select()
        .from(calendarEvents)
        .where(
          and(
            eq(calendarEvents.orgId, a.org.id),
            isNull(calendarEvents.parentId),
            isNull(calendarEvents.deletedAt),
            ne(calendarEvents.status, 'cancelled'),
            rangeCondition(from, to),
            or(...owned),
          ),
        )
        .limit(LIMIT)
    : [];
  const expanded = await expandSeries(db, seriesRows, from, to);
  const access = await eventAccessFor(
    db,
    a,
    [...new Map(expanded.map((e) => [e.row.id, e.row])).values()],
    new Map(seriesRows.map((r) => [r.id, r])),
  );
  const attendeeCounts = seriesRows.length
    ? await db
        .select({ id: calendarAttendees.eventId, n: sql<number>`count(*)::int` })
        .from(calendarAttendees)
        .where(
          inArray(
            calendarAttendees.eventId,
            seriesRows.map((r) => r.id),
          ),
        )
        .groupBy(calendarAttendees.eventId)
    : [];

  const links = await meetingLinks(
    db,
    'http://localhost',
    seriesRows.map((r) => r.meetingId),
  );
  // Provider of each mirrored calendar (for the Google / Microsoft mark in the views).
  const accountIds = [
    ...new Set(all.map((c) => c.calendar.accountId).filter((x): x is string => Boolean(x))),
  ];
  const providers = accountIds.length
    ? new Map(
        (
          await db
            .select({ id: calendarAccounts.id, provider: calendarAccounts.provider })
            .from(calendarAccounts)
            .where(inArray(calendarAccounts.id, accountIds))
        ).map((r) => [r.id, r.provider]),
      )
    : new Map<string, CalendarProvider>();
  const items: CalendarOccurrence[] = [];
  for (const e of expanded) {
    const acc = access.get(e.row.id);
    if (!acc) continue;
    if (
      acc.attendee?.response === 'declined' &&
      !settings.showDeclined &&
      !shownIds.includes(e.row.calendarId)
    ) {
      continue;
    }
    const cal = shownIds.includes(e.row.calendarId) ? byId.get(e.row.calendarId)! : personal;
    const color = (cal?.space?.color ?? cal?.calendar.color ?? 's1') as SpaceColor;
    items.push({
      key: `event:${e.series.id}:${e.key}`,
      source: 'event',
      sourceId: e.row.id,
      seriesId: e.series.rrule ? e.series.id : null,
      recurrenceId: e.series.rrule ? e.key : null,
      calendarId: cal?.calendar.id ?? null,
      color,
      title: acc.hidden ? '' : e.row.title,
      // A busy-only mirror stores no title: it shows as "Meşgul" to its owner too.
      hidden: acc.hidden || (cal?.calendar.kind === 'external' && !e.row.title),
      location: acc.hidden ? null : e.row.location,
      allDay: e.row.allDay,
      start: e.start,
      end: e.end,
      status: e.row.status,
      busy: e.row.busy,
      recurring: Boolean(e.series.rrule),
      myResponse: acc.attendee?.response ?? null,
      attendeeCount: attendeeCounts.find((c) => c.id === e.series.id)?.n ?? 0,
      editable: acc.canEdit && !acc.hidden,
      // An event with a Crewhall meeting opens its room.
      url: !acc.hidden && e.series.meetingId ? (links.get(e.series.meetingId)?.path ?? null) : null,
      flag: null,
      provider: cal?.calendar.accountId ? (providers.get(cal.calendar.accountId) ?? null) : null,
    });
  }

  const spaceIds = shown
    .filter((c) => c.calendar.kind === 'space' && c.calendar.spaceId)
    .map((c) => c.calendar.spaceId!);
  const spaceColor = new Map(
    shown.filter((c) => c.space).map((c) => [c.calendar.spaceId!, c.space!.color]),
  );
  const personalColor = (personal?.calendar.color ?? 's1') as SpaceColor;
  const personalOn = withInvites;

  if (q.meetings && settings.showMeetings && (await isModuleEnabled(db, a.org.id, 'meet'))) {
    items.push(
      ...(await meetingOccurrences(db, a, from, to, spaceIds, personalOn, (sid) =>
        sid ? (spaceColor.get(sid) ?? personalColor) : personalColor,
      )),
    );
  }
  if (q.cards && settings.showCards && (await isModuleEnabled(db, a.org.id, 'boards'))) {
    items.push(
      ...(await cardOccurrences(
        db,
        a,
        from,
        to,
        spaceIds,
        personalOn,
        (sid) => spaceColor.get(sid) ?? personalColor,
        settings.timeZone,
      )),
    );
  }
  items.sort((x, y) => (x.start < y.start ? -1 : x.start > y.start ? 1 : 0));
  return { items: items.slice(0, LIMIT) };
}

async function meetingOccurrences(
  db: DbOrTx,
  a: CalActor,
  from: Date,
  to: Date,
  spaceIds: string[],
  personal: boolean,
  colorOf: (spaceId: string | null) => SpaceColor,
): Promise<CalendarOccurrence[]> {
  const who: SQL[] = [];
  if (spaceIds.length) who.push(inArray(meetings.spaceId, spaceIds));
  if (personal) {
    who.push(eq(meetings.hostUserId, a.userId));
    who.push(
      sql`${meetings.id} in (select ${meetingInvitees.meetingId} from ${meetingInvitees} where ${meetingInvitees.userId} = ${a.userId})`,
    );
  }
  if (!who.length) return [];
  const rows = await db
    .select()
    .from(meetings)
    .where(
      and(
        eq(meetings.orgId, a.org.id),
        eq(meetings.kind, 'scheduled'),
        isNull(meetings.cancelledAt),
        notLinkedToEvent,
        isNotNull(meetings.startsAt),
        isNotNull(meetings.durationMinutes),
        lt(meetings.startsAt, to),
        or(...who),
      ),
    )
    .limit(500);
  if (!rows.length) return [];
  const live = await db
    .select({ meetingId: meetingSessions.meetingId })
    .from(meetingSessions)
    .where(
      and(
        inArray(
          meetingSessions.meetingId,
          rows.map((r) => r.id),
        ),
        isNull(meetingSessions.endedAt),
      ),
    );
  const liveIds = new Set(live.map((l) => l.meetingId));
  // Moving a meeting in the calendar changes its time (updateMeeting): its moderators may, as in
  // meet (host, made moderator, space Admin/Owner). A series moves from its own dialog.
  const spaceRoles = new Map<string, Awaited<ReturnType<typeof spaceRoleOf>>>();
  for (const spaceId of new Set(rows.flatMap((r) => (r.spaceId ? [r.spaceId] : [])))) {
    spaceRoles.set(spaceId, await spaceRoleOf(db, spaceId, a.userId));
  }
  const movable = (m: (typeof rows)[number]) => {
    if (m.recurrence !== 'none') return false;
    if (m.hostUserId === a.userId || (m.settings.moderatorIds ?? []).includes(a.userId))
      return true;
    const role = m.spaceId ? spaceRoles.get(m.spaceId) : null;
    return role === 'admin' || role === 'owner';
  };
  const now = Date.now();
  const out: CalendarOccurrence[] = [];
  for (const m of rows) {
    for (const o of meetingTimes(
      { startsAt: m.startsAt!, durationMinutes: m.durationMinutes!, recurrence: m.recurrence },
      from,
      to,
    )) {
      const isNow = o.start.getTime() <= now + 15 * 60_000 && o.end.getTime() >= now;
      out.push({
        key: `meeting:${m.id}:${o.key}`,
        source: 'meeting',
        sourceId: m.id,
        seriesId: null,
        recurrenceId: m.recurrence === 'none' ? null : o.key,
        calendarId: null,
        color: colorOf(m.spaceId),
        title: m.title,
        hidden: false,
        location: null,
        allDay: false,
        start: o.start.toISOString(),
        end: o.end.toISOString(),
        status: 'confirmed',
        busy: true,
        recurring: m.recurrence !== 'none',
        myResponse: null,
        attendeeCount: 0,
        editable: movable(m),
        url: paths.meetingRoom(m.joinSlug),
        flag: liveIds.has(m.id) && isNow ? 'live' : null,
      });
    }
  }
  return out;
}

async function cardOccurrences(
  db: DbOrTx,
  a: CalActor,
  from: Date,
  to: Date,
  spaceIds: string[],
  personal: boolean,
  colorOf: (spaceId: string) => SpaceColor,
  timeZone: string,
): Promise<CalendarOccurrence[]> {
  const who: SQL[] = [];
  if (spaceIds.length) who.push(inArray(nodes.spaceId, spaceIds));
  if (personal) {
    who.push(
      sql`${boardCards.id} in (select ${cardAssignees.cardId} from ${cardAssignees} where ${cardAssignees.userId} = ${a.userId})`,
    );
  }
  if (!who.length) return [];
  const rows = await db
    .select({ card: boardCards, node: nodes, board: boards, column: boardColumns })
    .from(boardCards)
    .innerJoin(boards, eq(boards.nodeId, boardCards.boardNodeId))
    .innerJoin(nodes, eq(nodes.id, boardCards.boardNodeId))
    .innerJoin(spaces, eq(spaces.id, nodes.spaceId))
    .innerJoin(boardColumns, eq(boardColumns.id, boardCards.columnId))
    .where(
      and(
        eq(boardCards.orgId, a.org.id),
        isNotNull(boardCards.dueAt),
        // A due date is a day: a day of slack each side, the day test is below.
        gt(boardCards.dueAt, new Date(from.getTime() - DAY_MS)),
        lt(boardCards.dueAt, new Date(to.getTime() + DAY_MS)),
        isNull(boardCards.archivedAt),
        isNull(boardCards.deletedAt),
        isNull(nodes.deletedAt),
        isNull(spaces.deletedAt),
        or(...who),
      ),
    )
    .limit(1000);
  // Cards are due on a day (the board's date picker); they sit in the all-day row on the
  // person's local date of the due instant.
  const fromDay = zonedDay(from.getTime(), timeZone);
  const toDay = zonedDay(to.getTime() - 1, timeZone);
  // The due date moves by drag where the person may edit the card (board editors, as on the board).
  const roles = new Map<string, Awaited<ReturnType<typeof spaceRoleOf>>>();
  const shares = new Map<string, Awaited<ReturnType<typeof userSharePaths>>>();
  for (const spaceId of new Set(rows.map((r) => r.node.spaceId))) {
    roles.set(spaceId, await spaceRoleOf(db, spaceId, a.userId));
    shares.set(spaceId, await userSharePaths(db, spaceId, a.userId));
  }
  const canEditCard = (n: { spaceId: string; path: string }) =>
    can(
      a.actor,
      'space.edit_content',
      nodeResource(
        a,
        roleForPath(roles.get(n.spaceId) ?? null, shares.get(n.spaceId) ?? [], n.path),
      ),
    );
  const out: CalendarOccurrence[] = [];
  for (const { card, node, board, column } of rows) {
    const key = `${board.settings.key}-${card.number}`;
    const day = zonedDay(card.dueAt!.getTime(), timeZone);
    if (day < fromDay || day > toDay) continue;
    out.push({
      key: `card:${card.id}:${dayToDate(day)}`,
      source: 'card' as const,
      sourceId: card.id,
      seriesId: null,
      recurrenceId: null,
      calendarId: null,
      color: colorOf(node.spaceId),
      title: `${key} · ${card.title}`,
      hidden: false,
      location: node.name,
      allDay: true,
      start: dayToDate(day),
      end: dayToDate(day + 1),
      status: 'confirmed' as const,
      busy: false,
      recurring: false,
      myResponse: null,
      attendeeCount: 0,
      editable: canEditCard(node),
      url: paths.boardCard(node.id, key),
      flag: column.isDone || card.doneAt ? ('done' as const) : null,
    });
  }
  return out;
}

// ---- availability -----------------------------------------------------------------------------

/**
 * Busy intervals of org members (doc: "uygunluk"): their personal calendars, events they are
 * invited to and have not declined, and scheduled meetings they host or are invited to.
 * Only times leave the server, never titles. Free (transparent) events do not count.
 */
export async function freeBusy(
  db: DbOrTx,
  a: CalActor,
  q: { userIds: string[]; from: string; to: string },
): Promise<FreeBusy> {
  if (a.actor.orgRole === 'guest') throw new AppError('forbidden');
  const from = new Date(q.from);
  const to = new Date(q.to);
  const userIds = [...new Set(q.userIds)];
  const personalCals = await db
    .select({ id: calendars.id, ownerId: calendars.ownerId })
    .from(calendars)
    .where(
      and(
        eq(calendars.orgId, a.org.id),
        // Mirrored Google / Microsoft calendars count for their owner as well.
        inArray(calendars.kind, ['personal', 'external']),
        isNull(calendars.deletedAt),
        inArray(calendars.ownerId, userIds),
      ),
    );
  const invites = await db
    .select({
      eventId: calendarAttendees.eventId,
      userId: calendarAttendees.userId,
      response: calendarAttendees.response,
    })
    .from(calendarAttendees)
    .where(
      and(
        eq(calendarAttendees.orgId, a.org.id),
        inArray(calendarAttendees.userId, userIds),
        ne(calendarAttendees.response, 'declined'),
      ),
    );
  const conds: SQL[] = [];
  if (personalCals.length)
    conds.push(
      inArray(
        calendarEvents.calendarId,
        personalCals.map((c) => c.id),
      ),
    );
  if (invites.length)
    conds.push(inArray(calendarEvents.id, [...new Set(invites.map((i) => i.eventId))]));
  const rows = conds.length
    ? await db
        .select()
        .from(calendarEvents)
        .where(
          and(
            eq(calendarEvents.orgId, a.org.id),
            isNull(calendarEvents.parentId),
            isNull(calendarEvents.deletedAt),
            ne(calendarEvents.status, 'cancelled'),
            rangeCondition(from, to),
            or(...conds),
          ),
        )
        .limit(LIMIT)
    : [];
  const expanded = await expandSeries(db, rows, from, to);
  const busy = new Map<string, { start: number; end: number; tentative: boolean }[]>(
    userIds.map((u) => [u, []]),
  );
  const add = (userId: string, start: number, end: number, tentative: boolean) =>
    busy.get(userId)?.push({
      start: Math.max(start, from.getTime()),
      end: Math.min(end, to.getTime()),
      tentative,
    });

  const settingsCache = new Map<string, string>();
  const zoneOf = async (userId: string) => {
    if (!settingsCache.has(userId)) {
      settingsCache.set(userId, (await settingsFor(db, a.org.id, userId)).timeZone);
    }
    return settingsCache.get(userId)!;
  };
  for (const e of expanded) {
    if (!e.row.busy) continue;
    const owner = personalCals.find((c) => c.id === e.series.calendarId)?.ownerId ?? null;
    const holders = new Map<string, boolean>();
    if (owner) holders.set(owner, e.row.status === 'tentative');
    for (const i of invites.filter((x) => x.eventId === e.series.id)) {
      holders.set(i.userId!, i.response !== 'accepted' || e.row.status === 'tentative');
    }
    for (const [userId, tentative] of holders) {
      let s: number;
      let en: number;
      if (e.row.allDay) {
        // All-day: the holder's local days.
        const tz = await zoneOf(userId);
        s = startOfZonedDay(dateToDay(e.start), tz).getTime();
        en = startOfZonedDay(dateToDay(e.end), tz).getTime();
      } else {
        s = Date.parse(e.start);
        en = Date.parse(e.end);
      }
      if (en > from.getTime() && s < to.getTime()) add(userId, s, en, tentative);
    }
  }

  if (await isModuleEnabled(db, a.org.id, 'meet')) {
    const hosted = await db
      .select()
      .from(meetings)
      .where(
        and(
          eq(meetings.orgId, a.org.id),
          eq(meetings.kind, 'scheduled'),
          isNull(meetings.cancelledAt),
          notLinkedToEvent,
          isNotNull(meetings.startsAt),
          isNotNull(meetings.durationMinutes),
          lt(meetings.startsAt, to),
          or(
            inArray(meetings.hostUserId, userIds),
            sql`${meetings.id} in (select ${meetingInvitees.meetingId} from ${meetingInvitees} where ${inArray(meetingInvitees.userId, userIds)})`,
          ),
        ),
      )
      .limit(500);
    const inv = hosted.length
      ? await db
          .select({ meetingId: meetingInvitees.meetingId, userId: meetingInvitees.userId })
          .from(meetingInvitees)
          .where(
            and(
              inArray(
                meetingInvitees.meetingId,
                hosted.map((m) => m.id),
              ),
              inArray(meetingInvitees.userId, userIds),
            ),
          )
      : [];
    for (const m of hosted) {
      const holders = new Set<string>();
      if (m.hostUserId && userIds.includes(m.hostUserId)) holders.add(m.hostUserId);
      for (const i of inv.filter((x) => x.meetingId === m.id)) holders.add(i.userId!);
      for (const o of meetingTimes(
        { startsAt: m.startsAt!, durationMinutes: m.durationMinutes!, recurrence: m.recurrence },
        from,
        to,
      )) {
        for (const u of holders) add(u, o.start.getTime(), o.end.getTime(), false);
      }
    }
  }

  return {
    items: userIds.map((userId) => ({ userId, busy: merge(busy.get(userId) ?? []) })),
  };
}

/** Sorted, overlapping intervals merged; a firm interval wins over a tentative one. */
function merge(list: { start: number; end: number; tentative: boolean }[]) {
  const sorted = list.filter((x) => x.end > x.start).sort((x, y) => x.start - y.start);
  const out: { start: number; end: number; tentative: boolean }[] = [];
  for (const x of sorted) {
    const last = out[out.length - 1];
    if (last && x.start <= last.end && x.tentative === last.tentative) {
      last.end = Math.max(last.end, x.end);
    } else out.push({ ...x });
  }
  return out.map((x) => ({
    start: new Date(x.start).toISOString(),
    end: new Date(x.end).toISOString(),
    tentative: x.tentative,
  }));
}
