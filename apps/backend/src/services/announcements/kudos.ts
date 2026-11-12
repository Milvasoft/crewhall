import { and, asc, desc, eq, inArray, isNotNull, lt, ne, or, sql } from 'drizzle-orm';
import {
  celebrationPosts,
  celebrationSettings,
  conversations,
  directoryProfiles,
  kudos,
  kudosBadges,
  orgMembers,
  organizations,
  users,
  type DbOrTx,
} from '@crewhall/db';
import { resources, type AppLocale } from '@crewhall/i18n';
import {
  CHAT_LIMITS,
  DEFAULT_KUDOS_BADGES,
  KUDOS_LIMITS,
  paths,
  type Celebration,
  type CelebrationKind,
  type CelebrationSettings,
  type Celebrations,
  type CreateKudos,
  type CreateKudosBadge,
  type Kudos,
  type KudosBadge,
  type UpdateCelebrationSettings,
  type UpdateKudosBadge,
} from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import { fill } from '../../mail/templates';
import { audit } from '../audit';
import { membershipOf, requireMember, requirePermission, type Membership } from '../chat/access';
import { publishMessage, writeMessage } from '../chat/messages';
import { chatEnabled } from '../chat/module';
import { usersById } from '../chat/views';
import { createNotifications, deliverNotifications } from '../notifications/notify';
import type { AnnouncementActor } from './index';

/**
 * Thank-you wall (kudos), birthdays and work anniversaries: an extension of the announcements
 * module. Cards go from one active member to another with a badge; the six ready badges are
 * created on first use and the org's admins rename, reorder, archive or add to them.
 * Birthdays ('MM-DD') and first working days come from the directory profile; a birthday is
 * shown to others only when its person turned it on. A daily post in the org's channel (off
 * until an admin picks one) celebrates them.
 */

type BadgeRow = typeof kudosBadges.$inferSelect;
type KudosRow = typeof kudos.$inferSelect;
type SettingsRow = typeof celebrationSettings.$inferSelect;

const isGuest = (a: AnnouncementActor) => a.actor.orgRole === 'guest';
const isAdmin = (a: AnnouncementActor) =>
  a.actor.orgRole === 'owner' || a.actor.orgRole === 'admin';

function requireReader(a: AnnouncementActor) {
  if (isGuest(a)) throw new AppError('not_found');
}
function requireAdmin(a: AnnouncementActor) {
  requireReader(a);
  if (!isAdmin(a)) throw new AppError('forbidden');
}

/** Membership lookup for the bot author: nobody, so every member is notified. */
const NO_USER = '00000000-0000-0000-0000-000000000000';

// ---- badges --------------------------------------------------------------------------------

const toBadge = (b: BadgeRow): KudosBadge => ({
  id: b.id,
  key: b.key,
  emoji: b.emoji,
  name: b.name,
  position: b.position,
  archived: b.archivedAt !== null,
});

/** The six ready badges, once per org (the partial unique index keeps it idempotent). */
export async function ensureBadges(db: DbOrTx, orgId: string) {
  const [any] = await db
    .select({ id: kudosBadges.id })
    .from(kudosBadges)
    .where(and(eq(kudosBadges.orgId, orgId), isNotNull(kudosBadges.key)))
    .limit(1);
  if (any) return;
  await db
    .insert(kudosBadges)
    .values(
      DEFAULT_KUDOS_BADGES.map((b, i) => ({ orgId, key: b.key, emoji: b.emoji, position: i })),
    )
    .onConflictDoNothing();
}

export async function listBadges(db: DbOrTx, a: AnnouncementActor) {
  requireReader(a);
  await ensureBadges(db, a.org.id);
  const rows = await db
    .select()
    .from(kudosBadges)
    .where(eq(kudosBadges.orgId, a.org.id))
    .orderBy(asc(kudosBadges.position), asc(kudosBadges.createdAt));
  return { items: rows.map(toBadge), permissions: { manage: isAdmin(a) } };
}

async function loadBadge(db: DbOrTx, orgId: string, id: string) {
  const [row] = await db
    .select()
    .from(kudosBadges)
    .where(and(eq(kudosBadges.id, id), eq(kudosBadges.orgId, orgId)));
  if (!row) throw new AppError('not_found');
  return row;
}

export async function createBadge(db: DbOrTx, a: AnnouncementActor, input: CreateKudosBadge) {
  requireAdmin(a);
  await ensureBadges(db, a.org.id);
  const [n] = await db
    .select({ n: sql<number>`count(*)::int`, max: sql<number>`coalesce(max(position), -1)::int` })
    .from(kudosBadges)
    .where(eq(kudosBadges.orgId, a.org.id));
  if ((n?.n ?? 0) >= KUDOS_LIMITS.badges) {
    throw new AppError('conflict', { reason: 'badge_limit', max: KUDOS_LIMITS.badges });
  }
  const [row] = await db
    .insert(kudosBadges)
    .values({
      orgId: a.org.id,
      emoji: input.emoji,
      name: input.name,
      position: (n?.max ?? -1) + 1,
    })
    .returning();
  await audit(db, {
    orgId: a.org.id,
    actorId: a.userId,
    action: 'kudos.badge_create',
    targetType: 'kudos_badge',
    targetId: row!.id,
    meta: { name: input.name },
  });
  return toBadge(row!);
}

export async function updateBadge(
  db: DbOrTx,
  a: AnnouncementActor,
  id: string,
  input: UpdateKudosBadge,
) {
  requireAdmin(a);
  const row = await loadBadge(db, a.org.id, id);
  // Only a ready badge can fall back to its translated name.
  if (input.name === null && !row.key) {
    throw new AppError('bad_request', { field: 'name', reason: 'required' });
  }
  const [next] = await db
    .update(kudosBadges)
    .set({
      ...(input.emoji !== undefined ? { emoji: input.emoji } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.position !== undefined ? { position: input.position } : {}),
      ...(input.archived !== undefined
        ? { archivedAt: input.archived ? (row.archivedAt ?? new Date()) : null }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(kudosBadges.id, row.id))
    .returning();
  await audit(db, {
    orgId: a.org.id,
    actorId: a.userId,
    action: 'kudos.badge_update',
    targetType: 'kudos_badge',
    targetId: row.id,
    meta: { fields: Object.keys(input) },
  });
  return toBadge(next!);
}

// ---- cards -------------------------------------------------------------------------------

async function views(db: DbOrTx, a: AnnouncementActor, rows: KudosRow[]): Promise<Kudos[]> {
  if (!rows.length) return [];
  const people = await usersById(
    db,
    rows.flatMap((r) => [r.toUserId, ...(r.fromUserId ? [r.fromUserId] : [])]),
  );
  const badgeIds = [...new Set(rows.map((r) => r.badgeId).filter((v): v is string => !!v))];
  const badges = new Map(
    (badgeIds.length
      ? await db.select().from(kudosBadges).where(inArray(kudosBadges.id, badgeIds))
      : []
    ).map((b) => [b.id, toBadge(b)]),
  );
  return rows.flatMap((r) => {
    const to = people.get(r.toUserId);
    if (!to) return [];
    return [
      {
        id: r.id,
        from: r.fromUserId ? (people.get(r.fromUserId) ?? null) : null,
        to,
        badge: r.badgeId ? (badges.get(r.badgeId) ?? null) : null,
        message: r.message,
        createdAt: r.createdAt.toISOString(),
        permissions: { delete: r.fromUserId === a.userId || isAdmin(a) },
      },
    ];
  });
}

/** Keyset cursor: createdAt and id of the last card. */
const encodeCursor = (r: KudosRow) =>
  Buffer.from(`${r.createdAt.toISOString()}|${r.id}`).toString('base64url');
function decodeCursor(cursor: string) {
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const date = new Date(at ?? '');
  if (!id || Number.isNaN(date.getTime())) {
    throw new AppError('bad_request', { reason: 'invalid_cursor' });
  }
  return { at: date, id };
}

export async function listKudos(
  db: DbOrTx,
  a: AnnouncementActor,
  q: { userId?: string | undefined; cursor?: string | undefined; limit: number },
) {
  requireReader(a);
  const after = q.cursor ? decodeCursor(q.cursor) : null;
  const rows = await db
    .select()
    .from(kudos)
    .where(
      and(
        eq(kudos.orgId, a.org.id),
        q.userId ? eq(kudos.toUserId, q.userId) : undefined,
        after
          ? or(
              lt(kudos.createdAt, after.at),
              and(eq(kudos.createdAt, after.at), lt(kudos.id, after.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(kudos.createdAt), desc(kudos.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  return {
    items: await views(db, a, page),
    nextCursor: rows.length > q.limit ? encodeCursor(page[page.length - 1]!) : null,
  };
}

async function activeMember(db: DbOrTx, orgId: string, userId: string) {
  const [m] = await db
    .select({ role: orgMembers.role })
    .from(orgMembers)
    .where(
      and(
        eq(orgMembers.organizationId, orgId),
        eq(orgMembers.userId, userId),
        eq(orgMembers.status, 'active'),
        ne(orgMembers.role, 'guest'),
      ),
    );
  return !!m;
}

export async function createKudos(deps: Deps, a: AnnouncementActor, input: CreateKudos) {
  const { db } = deps;
  requireReader(a);
  if (input.toUserId === a.userId) throw new AppError('bad_request', { reason: 'kudos_self' });
  if (!(await activeMember(db, a.org.id, input.toUserId))) throw new AppError('not_found');
  const badge = await loadBadge(db, a.org.id, input.badgeId);
  if (badge.archivedAt) throw new AppError('bad_request', { reason: 'badge_archived' });
  const message = input.message?.trim() || null;
  const { row, notes } = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(kudos)
      .values({
        orgId: a.org.id,
        fromUserId: a.userId,
        toUserId: input.toUserId,
        badgeId: badge.id,
        message,
      })
      .returning();
    const [me] = await tx.select({ name: users.name }).from(users).where(eq(users.id, a.userId));
    const notes = await createNotifications(
      tx,
      [
        {
          orgId: a.org.id,
          userId: input.toUserId,
          type: 'kudos.received',
          category: 'announcements' as const,
          actorId: a.userId,
          // Cards have no page of their own: the wall opens from `url`.
          target: { type: 'announcement' as const, id: row!.id },
          data: {
            actorName: me?.name ?? null,
            emoji: badge.emoji,
            badgeKey: badge.key,
            badgeName: badge.name,
            excerpt: message ? message.slice(0, 200) : null,
          },
          url: paths.kudos(),
          urgent: false,
        },
      ],
      deps.presence,
    );
    return { row: row!, notes };
  });
  await deliverNotifications(deps, notes);
  const settings = await loadSettings(db, a.org.id);
  if (settings?.channelId && settings.kudos) {
    const locale = await orgLocale(db, a.org.id);
    const t = resources[locale].email.announcements.celebrate;
    const badgeName = badge.name ?? t.badges[badge.key as keyof typeof t.badges] ?? '';
    const text = fill(message ? t.kudosWithMessage : t.kudos, {
      emoji: badge.emoji,
      badge: badgeName,
      from: `<@${a.userId}>`,
      to: `<@${input.toUserId}>`,
      message: message ?? '',
    });
    await postToChannel(deps, a.org.id, settings.channelId, text).catch((err: unknown) =>
      deps.logger.warn({ err, orgId: a.org.id }, 'kudos post failed'),
    );
  }
  return (await views(db, a, [row]))[0]!;
}

export async function deleteKudos(db: DbOrTx, a: AnnouncementActor, id: string) {
  requireReader(a);
  const [row] = await db
    .select()
    .from(kudos)
    .where(and(eq(kudos.id, id), eq(kudos.orgId, a.org.id)));
  if (!row) throw new AppError('not_found');
  if (row.fromUserId !== a.userId && !isAdmin(a)) throw new AppError('forbidden');
  await db.delete(kudos).where(eq(kudos.id, row.id));
  if (row.fromUserId !== a.userId) {
    await audit(db, {
      orgId: a.org.id,
      actorId: a.userId,
      action: 'kudos.delete',
      targetType: 'kudos',
      targetId: row.id,
      meta: { from: row.fromUserId, to: row.toUserId },
    });
  }
}

// ---- celebrations ------------------------------------------------------------------------

/** 'YYYY-MM-DD' of `at` in `timeZone`. */
export function localDay(at: Date, timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

function localHour(at: Date, timeZone: string) {
  return Number(
    new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(at),
  );
}

function addDays(day: string, n: number) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** Does a yearly 'MM-DD' fall on `day`? 29 February is kept on 28 February in other years. */
export function fallsOn(monthDay: string, day: string) {
  const md = day.slice(5);
  if (monthDay === md) return true;
  return monthDay === '02-29' && md === '02-28' && !isLeap(Number(day.slice(0, 4)));
}

interface PersonDates {
  userId: string;
  birthday: string | null;
  birthdayVisible: boolean;
  startedOn: string | null;
}

/** Active, non-guest members with a birthday or a first working day on their profile. */
async function datedPeople(db: DbOrTx, orgId: string): Promise<PersonDates[]> {
  return db
    .select({
      userId: directoryProfiles.userId,
      birthday: directoryProfiles.birthday,
      birthdayVisible: directoryProfiles.birthdayVisible,
      startedOn: directoryProfiles.startedOn,
    })
    .from(directoryProfiles)
    .innerJoin(
      orgMembers,
      and(
        eq(orgMembers.userId, directoryProfiles.userId),
        eq(orgMembers.organizationId, directoryProfiles.orgId),
        eq(orgMembers.status, 'active'),
        ne(orgMembers.role, 'guest'),
      ),
    )
    .where(
      and(
        eq(directoryProfiles.orgId, orgId),
        or(isNotNull(directoryProfiles.birthday), isNotNull(directoryProfiles.startedOn)),
      ),
    );
}

/** What falls on `day`: birthdays shown by their person, anniversaries of a full year or more. */
function onDay(people: PersonDates[], day: string) {
  const out: { kind: CelebrationKind; userId: string; years: number | null }[] = [];
  const year = Number(day.slice(0, 4));
  for (const p of people) {
    if (p.birthday && p.birthdayVisible && fallsOn(p.birthday, day)) {
      out.push({ kind: 'birthday', userId: p.userId, years: null });
    }
    if (p.startedOn && fallsOn(p.startedOn.slice(5), day)) {
      const years = year - Number(p.startedOn.slice(0, 4));
      if (years >= 1) out.push({ kind: 'anniversary', userId: p.userId, years });
    }
  }
  return out;
}

async function loadSettings(db: DbOrTx, orgId: string) {
  const [row] = await db
    .select()
    .from(celebrationSettings)
    .where(eq(celebrationSettings.orgId, orgId));
  return row ?? null;
}

const DEFAULT_TIME_ZONE = 'Europe/Istanbul';

export async function getCelebrations(
  db: DbOrTx,
  a: AnnouncementActor,
  q: { days: number },
): Promise<Celebrations> {
  requireReader(a);
  const tz = (await loadSettings(db, a.org.id))?.timeZone ?? DEFAULT_TIME_ZONE;
  const today = localDay(new Date(), tz);
  const people = await datedPeople(db, a.org.id);
  const found: (Omit<Celebration, 'user'> & { userId: string })[] = [];
  for (let i = 0; i <= q.days; i++) {
    const day = addDays(today, i);
    for (const c of onDay(people, day)) found.push({ ...c, date: day });
  }
  const summaries = await usersById(
    db,
    found.map((f) => f.userId),
  );
  const list = found.flatMap((f) => {
    const user = summaries.get(f.userId);
    return user ? [{ kind: f.kind, user, date: f.date, years: f.years }] : [];
  });
  return {
    today: list.filter((c) => c.date === today),
    upcoming: list.filter((c) => c.date !== today),
  };
}

const toSettings = (row: SettingsRow | null, a: AnnouncementActor): CelebrationSettings => ({
  channelId: row?.channelId ?? null,
  birthdays: row?.birthdays ?? true,
  anniversaries: row?.anniversaries ?? true,
  kudos: row?.kudos ?? false,
  timeZone: row?.timeZone ?? DEFAULT_TIME_ZONE,
  permissions: { manage: isAdmin(a) },
});

export async function getSettings(db: DbOrTx, a: AnnouncementActor) {
  requireReader(a);
  return toSettings(await loadSettings(db, a.org.id), a);
}

export async function updateSettings(
  db: DbOrTx,
  a: AnnouncementActor,
  input: UpdateCelebrationSettings,
) {
  requireAdmin(a);
  if (input.channelId) {
    // The admin must be able to write there; a direct or meeting chat is not a channel.
    const m = await requireMember(db, a, input.channelId);
    requirePermission(a, m, 'write');
    if (m.conv.type !== 'group' && m.conv.type !== 'space') {
      throw new AppError('bad_request', { field: 'channelId', reason: 'not_a_channel' });
    }
  }
  const set = {
    ...(input.channelId !== undefined ? { channelId: input.channelId } : {}),
    ...(input.birthdays !== undefined ? { birthdays: input.birthdays } : {}),
    ...(input.anniversaries !== undefined ? { anniversaries: input.anniversaries } : {}),
    ...(input.kudos !== undefined ? { kudos: input.kudos } : {}),
    ...(input.timeZone !== undefined ? { timeZone: input.timeZone } : {}),
  };
  const [row] = await db
    .insert(celebrationSettings)
    .values({ orgId: a.org.id, ...set })
    .onConflictDoUpdate({
      target: celebrationSettings.orgId,
      set: { ...set, updatedAt: new Date() },
    })
    .returning();
  await audit(db, {
    orgId: a.org.id,
    actorId: a.userId,
    action: 'celebrations.settings_update',
    targetType: 'org',
    targetId: a.org.id,
    meta: { fields: Object.keys(input) },
  });
  return toSettings(row ?? null, a);
}

async function orgLocale(db: DbOrTx, orgId: string): Promise<AppLocale> {
  const [org] = await db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  return org?.settings.defaultLocale === 'en' ? 'en' : 'tr';
}

/**
 * Written by the "Kutlamalar" bot (no author, like an automation message). Skipped when chat
 * is off for the org or the channel is gone or archived.
 */
async function postToChannel(deps: Deps, orgId: string, channelId: string, text: string) {
  const { db } = deps;
  if (!(await chatEnabled(db, orgId))) return null;
  const [conv] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, channelId), eq(conversations.orgId, orgId)));
  if (!conv || conv.archivedAt) return null;
  const locale = await orgLocale(db, orgId);
  const bot: Membership = { ...(await membershipOf(db, conv, NO_USER)), isMember: true };
  const result = await db.transaction((tx) =>
    writeMessage(deps, tx, bot, {
      authorId: null,
      webhookId: null,
      kind: 'webhook',
      text: text.slice(0, CHAT_LIMITS.messageChars),
      automation: {
        ruleId: orgId,
        ruleName: resources[locale].email.announcements.celebrate.botName,
      },
    }),
  );
  await publishMessage(deps, { ...conv, lastSeq: result.msg.seq }, 'message.created', result.msg);
  await deliverNotifications(deps, result.notes);
  return result.msg;
}

/** The morning post goes out from this local hour on (the job runs hourly). */
export const CELEBRATION_HOUR = 9;

/**
 * Hourly job: for each org with a channel, once its local morning has come, post today's
 * birthdays (one message) and work anniversaries (one per person) that were not posted yet.
 */
export async function postCelebrations(deps: Deps, now = new Date()) {
  const { db } = deps;
  const orgs = await db
    .select()
    .from(celebrationSettings)
    .where(isNotNull(celebrationSettings.channelId));
  let posted = 0;
  for (const s of orgs) {
    if (!s.channelId || (!s.birthdays && !s.anniversaries)) continue;
    if (localHour(now, s.timeZone) < CELEBRATION_HOUR) continue;
    const day = localDay(now, s.timeZone);
    const due = onDay(await datedPeople(db, s.orgId), day).filter((c) =>
      c.kind === 'birthday' ? s.birthdays : s.anniversaries,
    );
    if (!due.length) continue;
    // Claim first: a second worker (or a retry) finds the rows taken and posts nothing.
    const claimed = await db
      .insert(celebrationPosts)
      .values(due.map((c) => ({ orgId: s.orgId, kind: c.kind, userId: c.userId, day })))
      .onConflictDoNothing()
      .returning({ kind: celebrationPosts.kind, userId: celebrationPosts.userId });
    if (!claimed.length) continue;
    const t = resources[await orgLocale(db, s.orgId)].email.announcements.celebrate;
    const texts: string[] = [];
    const birthdays = claimed.filter((c) => c.kind === 'birthday').map((c) => `<@${c.userId}>`);
    if (birthdays.length) texts.push(fill(t.birthday, { names: birthdays.join(', ') }));
    for (const c of claimed.filter((x) => x.kind === 'anniversary')) {
      const years = due.find((d) => d.kind === 'anniversary' && d.userId === c.userId)?.years ?? 1;
      texts.push(
        fill(years === 1 ? t.anniversaryOne : t.anniversary, {
          name: `<@${c.userId}>`,
          years: String(years),
        }),
      );
    }
    for (const text of texts) {
      try {
        if (await postToChannel(deps, s.orgId, s.channelId, text)) posted += 1;
      } catch (err) {
        deps.logger.warn({ err, orgId: s.orgId }, 'celebration post failed');
      }
    }
  }
  return posted;
}
