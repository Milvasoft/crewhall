import { and, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
import { chatUserSettings, notifications, organizations, users, type Db } from '@crewhall/db';
import { resources, type AppLocale } from '@crewhall/i18n';
import type { Env } from '../../env';
import type { Logger } from '../../logger';
import type { Mailer } from '../../mail/mailer';
import { fill, mailParts, type MailBrand, type RenderedMail } from '../../mail/templates';
import { mailBrandForOrg } from '../brand';
import { chatEnabled } from '../chat/module';
import { localMinutes, settingsOrDefault } from './prefs';
import { paths, toCurrentPath } from '@crewhall/shared';

/**
 * E-mail digest (doc 17 §10, design 19.x "günlük özet"): notifications still unread after
 * 30 minutes, gathered hourly or daily (08:30 in the person's zone) into one mail.
 * Nothing to send → no mail. Runs every 15 minutes from the worker.
 */

export interface DigestDeps {
  db: Db;
  env: Env;
  logger: Logger;
  mailer: Mailer;
}

const DAILY_AT_MINUTES = 8 * 60 + 30;
const MAX_ITEMS = 50;

type Row = typeof notifications.$inferSelect;

function localDay(date: Date, timezone: string | null) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone ?? 'UTC' }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export function digestDue(
  s: { digest: 'off' | 'hourly' | 'daily'; lastDigestAt: Date | null; timezone: string | null },
  now: Date,
) {
  if (s.digest === 'off') return false;
  if (s.digest === 'hourly') {
    return !s.lastDigestAt || now.getTime() - s.lastDigestAt.getTime() >= 55 * 60_000;
  }
  if (localMinutes(now, s.timezone) < DAILY_AT_MINUTES) return false;
  return !s.lastDigestAt || localDay(s.lastDigestAt, s.timezone) < localDay(now, s.timezone);
}

export function digestMail(
  brand: MailBrand,
  locale: AppLocale,
  orgName: string,
  rows: Row[],
): RenderedMail {
  const t = resources[locale].email.chat.digest;
  const { para, heading, button, layout, esc } = mailParts;
  const sections: [string, Row[]][] = [
    [t.mentions, rows.filter((r) => r.category === 'mention')],
    [t.replies, rows.filter((r) => r.type === 'chat.reply' || r.type === 'chat.direct')],
    [t.assigned, rows.filter((r) => r.type.endsWith('.assigned'))],
    [t.meetings, rows.filter((r) => r.type.startsWith('meet.'))],
  ];
  const used = new Set(sections.flatMap(([, list]) => list.map((r) => r.id)));
  sections.push([t.other, rows.filter((r) => !used.has(r.id))]);
  const base = brand.hubUrl.replace(/\/$/, '');
  const blocks = [heading(t.heading), para(t.intro)];
  for (const [title, list] of sections) {
    if (list.length === 0) continue;
    blocks.push({
      html: `<h2 style="margin:20px 0 8px;font-size:16px;font-weight:800;color:#141516">${esc(title)}</h2>`,
      text: title,
    });
    for (const r of list) {
      const d = r.payload;
      const who = fill(t.inConversation, {
        actor: String(d.authorName ?? d.actorName ?? ''),
        conversation: String(d.conversationTitle ?? d.name ?? ''),
      });
      const excerpt = String(d.excerpt ?? '');
      const url = `${base}${toCurrentPath(r.url)}`;
      blocks.push({
        html: `<p style="margin:0 0 10px;font-size:14px;line-height:1.5;color:#141516"><a href="${esc(url)}" style="color:#141516;font-weight:700;text-decoration:none">${esc(who)}</a>${r.count > 1 ? ` <span style="color:#5b5f63">×${r.count}</span>` : ''}<br><span style="color:#5b5f63">${esc(excerpt)}</span></p>`,
        text: `${who}${r.count > 1 ? ` ×${r.count}` : ''}\n${excerpt}\n${url}`,
      });
    }
  }
  blocks.push(button(t.open, `${base}${paths.notifications()}`, brand.accent));
  return {
    subject: fill(t.subject, { org: orgName, count: String(rows.length) }),
    ...layout(brand, locale, blocks, [
      t.footerWhy,
      fill(t.footerManage, { url: `${base}${paths.notifications()}` }),
    ]),
  };
}

export async function runDigest(deps: DigestDeps, now = new Date()) {
  const { db } = deps;
  const pending = await db
    .selectDistinct({ orgId: notifications.orgId, userId: notifications.userId })
    .from(notifications)
    .where(
      and(
        eq(notifications.wantsEmail, true),
        isNull(notifications.emailedAt),
        isNull(notifications.readAt),
        isNull(notifications.dismissedAt),
        lt(notifications.createdAt, sql`${now}::timestamptz - interval '30 minutes'`),
        gt(notifications.createdAt, sql`${now}::timestamptz - interval '7 days'`),
      ),
    );
  let sent = 0;
  for (const p of pending) {
    try {
      const [saved] = await db
        .select()
        .from(chatUserSettings)
        .where(and(eq(chatUserSettings.orgId, p.orgId), eq(chatUserSettings.userId, p.userId)));
      const s = settingsOrDefault(saved, p.orgId, p.userId);
      if (!digestDue(s, now)) continue;
      const chatOn = await chatEnabled(db, p.orgId);
      const all = await db
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.orgId, p.orgId),
            eq(notifications.userId, p.userId),
            eq(notifications.wantsEmail, true),
            isNull(notifications.emailedAt),
            isNull(notifications.readAt),
            isNull(notifications.dismissedAt),
            lt(notifications.createdAt, sql`${now}::timestamptz - interval '30 minutes'`),
          ),
        )
        .orderBy(notifications.createdAt)
        .limit(MAX_ITEMS);
      // A turned-off chat module sends no chat items.
      const rows = chatOn ? all : all.filter((r) => !r.type.startsWith('chat.'));
      if (rows.length === 0) continue;
      const [user] = await db.select().from(users).where(eq(users.id, p.userId));
      const [org] = await db.select().from(organizations).where(eq(organizations.id, p.orgId));
      if (!user || !org) continue;
      if (!(await deps.mailer.enabledFor(p.orgId))) continue;
      const brand = await mailBrandForOrg(db, deps.env.HUB_URL, p.orgId);
      const mail = digestMail(brand, user.locale, org.branding.orgName, rows);
      await deps.mailer.send({
        orgId: p.orgId,
        to: user.email,
        fromName: org.branding.orgName,
        ...mail,
      });
      await db
        .update(notifications)
        .set({ emailedAt: now })
        .where(
          inArray(
            notifications.id,
            rows.map((r) => r.id),
          ),
        );
      await db
        .insert(chatUserSettings)
        .values({ orgId: p.orgId, userId: p.userId, lastDigestAt: now })
        .onConflictDoUpdate({
          target: [chatUserSettings.orgId, chatUserSettings.userId],
          set: { lastDigestAt: now },
        });
      sent += 1;
    } catch (err) {
      deps.logger.warn({ err, userId: p.userId }, 'digest mail failed');
    }
  }
  return sent;
}
