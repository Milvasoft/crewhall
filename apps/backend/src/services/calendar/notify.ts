import { eq, inArray } from 'drizzle-orm';
import { resources, type AppLocale } from '@crewhall/i18n';
import { calendarAttendees, calendarEvents, users } from '@crewhall/db';
import type { Deps } from '../../deps';
import { button, facts, fill, heading, layout, para, type Block } from '../../mail/templates';
import { mailBrandForOrg } from '../brand';
import { notify, type NotificationInput } from '../notifications/notify';
import type { CalActor, EventRow } from './access';
import { buildIcs } from './ics';
import { meetingLinks } from './meeting';
import { icsEventsFor } from './resources';
import { paths, withQuery } from '@crewhall/shared';

/**
 * Invitations and their follow-ups (roadmap 14): org members get a notification (bell, push,
 * digest, following their preferences), outside addresses an e-mail with an iTIP .ics
 * (REQUEST or CANCEL). Mail failures are logged and never undo the change.
 */

export type ChangeKind = 'invited' | 'updated' | 'cancelled' | 'response';

export interface Recipient {
  userId: string | null;
  email: string;
  name: string | null;
  optional: boolean;
}

type CalendarMail = (typeof resources)['tr']['email']['calendar'];
const dict = (locale: AppLocale) => resources[locale].email.calendar as CalendarMail;

export const eventUrl = (seriesId: string) => withQuery(paths.calendar(), { event: seriesId });

function whenText(row: EventRow, locale: AppLocale) {
  const tag = locale === 'tr' ? 'tr-TR' : 'en-GB';
  if (row.allDay) {
    const f = new Intl.DateTimeFormat(tag, { dateStyle: 'full', timeZone: 'UTC' });
    const last = new Date(row.endsAt.getTime() - 86_400_000);
    return last.getTime() > row.startsAt.getTime()
      ? `${f.format(row.startsAt)} – ${f.format(last)}`
      : f.format(row.startsAt);
  }
  const f = new Intl.DateTimeFormat(tag, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: row.timeZone,
    timeZoneName: 'short',
  });
  return `${f.format(row.startsAt)} – ${new Intl.DateTimeFormat(tag, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: row.timeZone,
  }).format(row.endsAt)}`;
}

export async function announceChange(
  deps: Deps,
  a: CalActor,
  row: EventRow,
  kind: ChangeKind,
  only?: Recipient[],
  response?: 'accepted' | 'declined' | 'tentative',
) {
  const seriesId = row.parentId ?? row.id;
  const [series] = row.parentId
    ? await deps.db.select().from(calendarEvents).where(eq(calendarEvents.id, seriesId))
    : [row];
  if (!series) return;
  const url = eventUrl(seriesId);

  if (kind === 'response') {
    if (!series.organizerId || series.organizerId === a.userId) return;
    await notify(deps, [
      {
        orgId: a.org.id,
        userId: series.organizerId,
        type: 'calendar.response',
        category: 'meetings',
        actorId: a.userId,
        target: { type: 'event', id: seriesId },
        data: { title: series.title, kind: response ?? 'accepted' },
        url,
      },
    ]);
    return;
  }

  const recipients: Recipient[] =
    only ??
    (
      await deps.db.select().from(calendarAttendees).where(eq(calendarAttendees.eventId, seriesId))
    ).map((x) => ({ userId: x.userId, email: x.email, name: x.name, optional: x.optional }));
  const people = recipients.filter((r) => r.userId && r.userId !== a.userId);
  const outside = recipients.filter((r) => !r.userId);

  if (people.length) {
    const inputs: NotificationInput[] = people.map((p) => ({
      orgId: a.org.id,
      userId: p.userId!,
      type: `calendar.${kind}`,
      category: 'meetings',
      actorId: a.userId,
      target: { type: 'event', id: seriesId },
      data: {
        title: row.title,
        start: row.allDay ? row.startDate : row.startsAt.toISOString(),
        allDay: row.allDay,
      },
      url,
    }));
    try {
      await notify(deps, inputs);
    } catch (err) {
      deps.logger.warn({ err, eventId: seriesId }, 'calendar notification failed');
    }
  }
  if (outside.length) await mailOutside(deps, a, series, row, kind, outside);
}

async function mailOutside(
  deps: Deps,
  a: CalActor,
  series: EventRow,
  row: EventRow,
  kind: Exclude<ChangeKind, 'response'>,
  outside: Recipient[],
) {
  const brand = await mailBrandForOrg(deps.db, deps.env.HUB_URL, a.org.id);
  const events = (await icsEventsFor(deps.db, [series], deps.env.HUB_URL)).get(series.id) ?? [];
  const cancel = kind === 'cancelled';
  const ics = buildIcs({
    method: cancel ? 'CANCEL' : 'REQUEST',
    events: cancel ? events.map((e) => ({ ...e, status: 'cancelled' as const })) : events,
  });
  const attendeeNames = (
    await deps.db.select().from(calendarAttendees).where(eq(calendarAttendees.eventId, series.id))
  ).map((x) => x.name ?? x.email);
  const organizer = series.organizerId
    ? (
        await deps.db
          .select({ name: users.name })
          .from(users)
          .where(inArray(users.id, [series.organizerId]))
      )[0]
    : undefined;
  const locale = (a.org.settings as { defaultLocale?: AppLocale }).defaultLocale ?? 'tr';
  const d = dict(locale);
  const vars = {
    title: row.title,
    when: whenText(row, locale),
    inviterName: organizer?.name ?? a.userName,
    orgName: brand.branding.orgName,
  };
  const link = series.meetingId
    ? ((await meetingLinks(deps.db, deps.env.HUB_URL, [series.meetingId])).get(series.meetingId)
        ?.url ?? null)
    : null;
  const rows: [string, string][] = [[d.when, vars.when]];
  if (row.location) rows.push([d.where, row.location]);
  if (link) rows.push([d.meeting, link]);
  if (series.rrule) rows.push([d.repeats, d.recurring]);
  if (row.description) rows.push([d.details, row.description.slice(0, 1000)]);
  if (attendeeNames.length) rows.push([d.people, attendeeNames.slice(0, 12).join(', ')]);
  const part = cancel ? d.cancel : kind === 'updated' ? d.update : d.invite;
  const blocks: Block[] = [
    heading(fill(part.title, vars)),
    ...(part.body ? [para(fill(part.body, vars))] : []),
    facts(rows),
    ...(link && !cancel ? [button(d.join, link, brand.accent), para(d.guestNote, true)] : []),
    para(d.icsNote, true),
  ];
  for (const r of outside) {
    try {
      await deps.mailer.send({
        orgId: a.org.id,
        to: r.email,
        subject: fill(part.subject, vars),
        fromName: brand.branding.orgName,
        ...layout(brand, locale, blocks, [fill(d.footer, vars)]),
        icalEvent: { method: cancel ? 'CANCEL' : 'REQUEST', content: ics, filename: 'davet.ics' },
      });
    } catch (err) {
      deps.logger.warn({ err, to: r.email, eventId: series.id }, 'calendar mail failed');
    }
  }
}
