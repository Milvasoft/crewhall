import { resources, type AppLocale } from '@crewhall/i18n';
import type { Deps } from '../../deps';
import {
  button,
  facts,
  fallbackLink,
  fill,
  heading,
  layout,
  para,
  type Block,
} from '../../mail/templates';
import { mailBrandForOrg } from '../brand';
import type { MeetingRow } from './access';
import { meetingUrl } from './access';
import { buildIcs } from './ics';

/** Design 19.11: invitation with the guest link and an .ics; update and cancel variants. */

type MeetMail = (typeof resources)['tr']['email']['meet'];
const dict = (locale: AppLocale) => resources[locale].email.meet as MeetMail;

export interface MailRecipient {
  email: string;
  name: string | null;
  guest: boolean;
  locale: AppLocale;
}

function when(m: MeetingRow, locale: AppLocale, timeZone: string) {
  if (!m.startsAt) return '';
  const tag = locale === 'tr' ? 'tr-TR' : 'en-GB';
  const date = new Intl.DateTimeFormat(tag, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(m.startsAt);
  if (!m.durationMinutes) return date;
  const end = new Date(m.startsAt.getTime() + m.durationMinutes * 60_000);
  const endTime = new Intl.DateTimeFormat(tag, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(end);
  return `${date} – ${endTime}`;
}

function fromAddress(mailFrom: string | undefined) {
  const raw = mailFrom ?? 'crewhall@localhost';
  return /<([^>]+)>/.exec(raw)?.[1] ?? raw;
}

/**
 * Sends one mail per recipient; failures are logged and do not undo the change
 * (the meeting exists and the link works without the mail).
 */
export async function sendMeetingMails(
  deps: Deps,
  input: {
    meeting: MeetingRow;
    kind: 'invite' | 'update' | 'cancel';
    recipients: MailRecipient[];
    /** Everybody invited, for the ATTENDEE lines. */
    attendees: { name: string | null; email: string }[];
    inviter: { name: string };
    timeZone?: string;
  },
) {
  const { meeting: m } = input;
  if (!m.startsAt || !m.durationMinutes || !input.recipients.length) return;
  const brand = await mailBrandForOrg(deps.db, deps.env.HUB_URL, m.orgId);
  const url = meetingUrl(deps.env.HUB_URL, m.joinSlug);
  const tz = input.timeZone ?? 'Europe/Istanbul';
  const ics = buildIcs({
    method: input.kind === 'cancel' ? 'CANCEL' : 'REQUEST',
    uid: `${m.id}@${new URL(deps.env.HUB_URL).host}`,
    sequence: m.icsSequence,
    start: m.startsAt,
    durationMinutes: m.durationMinutes,
    recurrence: m.recurrence,
    title: m.title,
    description: [m.description ?? '', url].filter(Boolean).join('\n\n'),
    url,
    organizer: { name: brand.branding.orgName, email: fromAddress(deps.env.MAIL_FROM) },
    attendees: input.attendees,
  });

  for (const r of input.recipients) {
    const d = dict(r.locale);
    const layoutDict = resources[r.locale].email.layout;
    const vars = {
      title: m.title,
      when: when(m, r.locale, tz),
      inviterName: input.inviter.name,
      orgName: brand.branding.orgName,
      hours: String(m.settings.guestLinkHours),
    };
    const rows: [string, string][] = [
      [d.invite.when, vars.when],
      [d.invite.where, d.online],
    ];
    if (m.recurrence !== 'none') rows.push([d.invite.repeats, d.recurrence[m.recurrence]]);
    if (m.description) rows.push([d.invite.agenda, m.description]);
    if (input.attendees.length) {
      rows.push([
        d.invite.people,
        input.attendees
          .slice(0, 12)
          .map((x) => x.name ?? x.email)
          .join(', '),
      ]);
    }
    let subject: string;
    let blocks: Block[];
    if (input.kind === 'cancel') {
      subject = fill(d.cancel.subject, vars);
      blocks = [heading(fill(d.cancel.title, vars)), para(fill(d.cancel.body, vars)), facts(rows)];
    } else {
      const lead =
        input.kind === 'update'
          ? [heading(fill(d.update.title, vars)), para(fill(d.update.body, vars))]
          : [heading(fill(d.invite.title, vars))];
      subject = fill(input.kind === 'update' ? d.update.subject : d.invite.subject, vars);
      blocks = [
        ...lead,
        facts(rows),
        button(d.invite.cta, url, brand.accent),
        para(r.guest ? fill(d.invite.guestNote, vars) : d.invite.memberNote, true),
        para(d.invite.icsNote, true),
        fallbackLink(r.locale, url),
      ];
    }
    const footer = [
      r.guest
        ? fill(d.invite.guestFooter, vars)
        : fill(layoutDict.sentFor, { orgName: brand.branding.orgName, email: r.email }),
    ];
    try {
      await deps.mailer.send({
        orgId: m.orgId,
        to: r.email,
        subject,
        fromName: brand.branding.orgName,
        ...layout(brand, r.locale, blocks, footer),
        icalEvent: {
          method: input.kind === 'cancel' ? 'CANCEL' : 'REQUEST',
          content: ics,
          filename: 'davet.ics',
        },
      });
    } catch (err) {
      deps.logger.warn({ err, to: r.email, meetingId: m.id }, 'meeting mail failed');
    }
  }
}
