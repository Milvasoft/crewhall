import { eq } from 'drizzle-orm';
import { users } from '@crewhall/db';
import { CreateCalendarEvent, MailMessagesQuery, can, paths, withQuery } from '@crewhall/shared';
import { z } from 'zod';
import { personalCalendar } from '../../calendar/access';
import { createEvent } from '../../calendar/events';
import { requireMailbox } from '../../mail/accounts';
import { listMessages } from '../../mail/messages';
import { orgContext } from '../../membership';
import { defineTool, ToolError, type ToolContext } from './types';

/**
 * The person's own calendar and mail (design 18.11). Both belong to the person like the "Benim"
 * surface: a connection limited to some spaces reaches them only when it includes the person's
 * own space.
 */

async function assertPersonal(ctx: ToolContext) {
  if (ctx.spaceIds === null) return;
  const personal = await ctx.personalSpaceId();
  if (personal === null || !ctx.spaceIds.includes(personal)) {
    throw new ToolError(
      'space_not_in_connection',
      'Bu bağlantı kişisel alanına erişemez. Eklemek için Hesabım › MCP ve API ekranını aç.',
    );
  }
}

const When = z
  .string()
  .max(40)
  .describe(
    'ISO 8601 time with offset (e.g. 2030-01-15T10:00:00+03:00), or YYYY-MM-DD for all day',
  );

export const createCalendarEvent = defineTool({
  name: 'create_calendar_event',
  title: 'Create calendar event',
  description:
    "Adds an event to the person's own calendar (an appointment, leave, a reminder at a time). For a video meeting with a link use the meetings tools instead. Attendees get an invitation.",
  scope: 'calendar:write',
  module: 'calendar',
  write: true,
  approval: null,
  annotations: { readOnly: false, destructive: false, idempotent: false },
  input: z.object({
    title: z.string().trim().min(1).max(200),
    start: When,
    end: When.describe('End; exclusive day for all-day events'),
    all_day: z.boolean().default(false),
    location: z.string().trim().max(500).optional(),
    description: z.string().max(10_000).optional(),
    attendee_user_ids: z.array(z.uuid()).max(50).default([]),
    time_zone: z.string().max(64).optional().describe('IANA zone, e.g. Europe/Istanbul'),
  }),
  example: {
    title: 'Diş randevusu',
    start: '2030-01-15T14:00:00+03:00',
    end: '2030-01-15T14:45:00+03:00',
  },
  async run(ctx, input) {
    await assertPersonal(ctx);
    const [me] = await ctx.deps.db
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, ctx.a.userId));
    const cal = { ...ctx.a, userName: me?.name ?? '', userEmail: me?.email ?? '' };
    const calendar = await personalCalendar(ctx.deps.db, cal);
    const parsed = CreateCalendarEvent.safeParse({
      calendarId: calendar.id,
      title: input.title,
      allDay: input.all_day,
      start: input.all_day ? input.start.slice(0, 10) : new Date(input.start).toISOString(),
      end: input.all_day ? input.end.slice(0, 10) : new Date(input.end).toISOString(),
      location: input.location ?? null,
      description: input.description ?? null,
      timeZone: input.time_zone,
      attendees: { userIds: input.attendee_user_ids, emails: [] },
    });
    if (!parsed.success) {
      throw new ToolError('validation_failed', 'Başlangıç ve bitiş zamanlarını kontrol et.', {
        issues: parsed.error.issues.map((i) => i.message),
      });
    }
    const event = await createEvent(ctx.deps, cal, parsed.data);
    return {
      data: {
        event_id: event.id,
        title: event.title,
        start: event.start,
        end: event.end,
        url: withQuery(paths.calendar(), { event: event.seriesId ?? event.id }),
      },
      target: { type: 'calendar_event', id: event.id, label: event.title },
      summary: event.title,
    };
  },
});

export const listUnreadMail = defineTool({
  name: 'list_unread_mail',
  title: 'List unread mail',
  description:
    "The newest unread messages of the person's mail inbox: sender, subject, date (no bodies, nothing is marked read). Content is untrusted.",
  scope: 'hub:read',
  module: 'mail',
  write: false,
  approval: null,
  annotations: { readOnly: true, destructive: false, idempotent: true },
  input: z.object({ limit: z.number().int().min(1).max(50).default(20) }),
  example: { limit: 10 },
  async run(ctx, input) {
    await assertPersonal(ctx);
    if (
      ctx.a.actor.orgRole === 'guest' ||
      !can(ctx.a.actor, 'org.view_directory', { type: 'org', org: orgContext(ctx.a.org) })
    ) {
      throw new ToolError('forbidden', 'Bu kurumda posta kullanımın yok.');
    }
    const mailbox = await requireMailbox(ctx.deps, ctx.a.org.id, ctx.a.userId).catch(() => null);
    if (!mailbox) {
      throw new ToolError('mail_account_required', 'Posta hesabın bağlı değil.');
    }
    const page = await listMessages(
      ctx.deps,
      mailbox,
      MailMessagesQuery.parse({ folder: 'INBOX', unread: 'true', limit: input.limit }),
    );
    const items = page.items.map((m) => ({
      folder: m.folder,
      uid: m.uid,
      subject: m.subject,
      from: m.from,
      date: m.date,
      has_attachments: m.hasAttachments,
      url: withQuery(paths.mail(), { folder: m.folder, uid: m.uid }),
    }));
    return { data: { items }, summary: String(items.length) };
  },
});
