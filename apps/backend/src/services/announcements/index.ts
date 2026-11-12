import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import {
  announcementReads,
  announcements,
  notifications,
  orgMembers,
  organizations,
  users,
  type DbOrTx,
} from '@crewhall/db';
import {
  ANNOUNCEMENT_LIMITS,
  can,
  type Announcement,
  type CreateAnnouncement,
  type UpdateAnnouncement,
  paths,
} from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { JobDeps } from '../../jobs/handlers';
import { audit } from '../audit';
import { mailBrandForOrg } from '../brand';
import { usersById } from '../chat/views';
import { orgContext } from '../membership';
import { createNotifications, deliverNotifications } from '../notifications/notify';
import type { DriveActor } from '../drive/access';
import { announcementMail } from './mail';

/**
 * Internal announcements (roadmap 19): an org-wide feed for active members (guests excluded).
 * Publishing is an org permission (`announcements.publish`); each one is managed by its
 * author or an org admin who can publish.
 */

export type AnnouncementActor = DriveActor;
type Row = typeof announcements.$inferSelect;

const isGuest = (a: AnnouncementActor) => a.actor.orgRole === 'guest';
const isAdmin = (a: AnnouncementActor) =>
  a.actor.orgRole === 'owner' || a.actor.orgRole === 'admin';

export const canPublish = (a: AnnouncementActor) =>
  can(a.actor, 'announcements.publish', { type: 'org', org: orgContext(a.org) });

const canManage = (a: AnnouncementActor, row: Row) =>
  canPublish(a) && (row.authorId === a.userId || isAdmin(a));

/** Guests are outside the internal feed; they get 404 as if it did not exist. */
function requireReader(a: AnnouncementActor) {
  if (isGuest(a)) throw new AppError('not_found');
}

/** Active, non-guest members: the audience of every announcement in the org. */
const audienceWhere = (orgId: string) =>
  and(
    eq(orgMembers.organizationId, orgId),
    eq(orgMembers.status, 'active'),
    ne(orgMembers.role, 'guest'),
  );

async function audienceIds(db: DbOrTx, orgId: string) {
  const rows = await db
    .select({ userId: orgMembers.userId })
    .from(orgMembers)
    .where(audienceWhere(orgId));
  return rows.map((r) => r.userId);
}

async function load(db: DbOrTx, a: AnnouncementActor, id: string) {
  requireReader(a);
  const [row] = await db
    .select()
    .from(announcements)
    .where(and(eq(announcements.id, id), eq(announcements.orgId, a.org.id)));
  if (!row) throw new AppError('not_found');
  return row;
}

/** Rows → contract shape for the caller (counts count current audience members only). */
async function views(db: DbOrTx, a: AnnouncementActor, rows: Row[]): Promise<Announcement[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const counts = await db
    .select({
      id: announcementReads.announcementId,
      reads: sql<number>`count(*)::int`,
      acks: sql<number>`count(${announcementReads.ackedAt})::int`,
    })
    .from(announcementReads)
    .innerJoin(
      orgMembers,
      and(eq(orgMembers.userId, announcementReads.userId), audienceWhere(a.org.id)),
    )
    .innerJoin(announcements, eq(announcements.id, announcementReads.announcementId))
    .where(
      and(
        inArray(announcementReads.announcementId, ids),
        // The author is not a reader of their own announcement (B3).
        sql`${announcementReads.userId} is distinct from ${announcements.authorId}`,
      ),
    )
    .groupBy(announcementReads.announcementId);
  const byId = new Map(counts.map((c) => [c.id, c]));
  const mine = new Map(
    (
      await db
        .select()
        .from(announcementReads)
        .where(
          and(
            inArray(announcementReads.announcementId, ids),
            eq(announcementReads.userId, a.userId),
          ),
        )
    ).map((r) => [r.announcementId, r]),
  );
  const people = await usersById(
    db,
    rows.map((r) => r.authorId).filter((v): v is string => !!v),
  );
  const audience = new Set(await audienceIds(db, a.org.id));
  return rows.map((r) => {
    const c = byId.get(r.id);
    const m = mine.get(r.id);
    return {
      id: r.id,
      title: r.title,
      body: r.body,
      author: r.authorId ? (people.get(r.authorId) ?? null) : null,
      pinnedAt: r.pinnedAt?.toISOString() ?? null,
      requiresAck: r.requiresAck,
      publishedAt: r.publishedAt.toISOString(),
      editedAt: r.editedAt?.toISOString() ?? null,
      audienceCount: audience.size - (r.authorId && audience.has(r.authorId) ? 1 : 0),
      readCount: c?.reads ?? 0,
      ackCount: c?.acks ?? 0,
      my: { readAt: m?.readAt.toISOString() ?? null, ackedAt: m?.ackedAt?.toISOString() ?? null },
      permissions: { manage: canManage(a, r) },
    };
  });
}

const view = async (db: DbOrTx, a: AnnouncementActor, row: Row) => (await views(db, a, [row]))[0]!;

/** Not opened yet, or asked to confirm and not confirmed. */
const unreadSql = (userId: string) => sql`not exists (
  select 1 from ${announcementReads} r
  where r.announcement_id = ${announcements.id} and r.user_id = ${userId}::uuid
    and (r.acked_at is not null or not ${announcements.requiresAck}))`;

export async function listAnnouncements(
  db: DbOrTx,
  a: AnnouncementActor,
  q: { unreadOnly?: boolean | undefined; cursor?: string | undefined; limit: number },
) {
  requireReader(a);
  let offset = 0;
  if (q.cursor) {
    offset = Number(Buffer.from(q.cursor, 'base64url').toString('utf8'));
    if (!Number.isInteger(offset) || offset < 0) {
      throw new AppError('bad_request', { reason: 'invalid_cursor' });
    }
  }
  const rows = await db
    .select()
    .from(announcements)
    .where(and(eq(announcements.orgId, a.org.id), q.unreadOnly ? unreadSql(a.userId) : undefined))
    .orderBy(
      sql`${announcements.pinnedAt} is null`,
      desc(announcements.pinnedAt),
      desc(announcements.publishedAt),
      desc(announcements.id),
    )
    .limit(q.limit + 1)
    .offset(offset);
  const more = rows.length > q.limit;
  return {
    items: await views(db, a, rows.slice(0, q.limit)),
    nextCursor: more ? Buffer.from(String(offset + q.limit)).toString('base64url') : null,
  };
}

export async function announcementCounts(db: DbOrTx, a: AnnouncementActor) {
  if (isGuest(a)) return { unread: 0, pendingAck: 0 };
  const [r] = await db
    .select({
      unread: sql<number>`count(*) filter (where not exists (
        select 1 from ${announcementReads} r
        where r.announcement_id = ${announcements.id} and r.user_id = ${a.userId}::uuid))::int`,
      pendingAck: sql<number>`count(*) filter (where ${announcements.requiresAck} and not exists (
        select 1 from ${announcementReads} r
        where r.announcement_id = ${announcements.id} and r.user_id = ${a.userId}::uuid
          and r.acked_at is not null))::int`,
    })
    .from(announcements)
    .where(eq(announcements.orgId, a.org.id));
  return { unread: r?.unread ?? 0, pendingAck: r?.pendingAck ?? 0 };
}

export async function getAnnouncement(db: DbOrTx, a: AnnouncementActor, id: string) {
  return view(db, a, await load(db, a, id));
}

async function checkPinLimit(db: DbOrTx, orgId: string, exceptId?: string) {
  const [n] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(announcements)
    .where(
      and(
        eq(announcements.orgId, orgId),
        isNotNull(announcements.pinnedAt),
        exceptId ? ne(announcements.id, exceptId) : undefined,
      ),
    );
  if ((n?.n ?? 0) >= ANNOUNCEMENT_LIMITS.pinned) {
    throw new AppError('conflict', { reason: 'pin_limit', max: ANNOUNCEMENT_LIMITS.pinned });
  }
}

export async function createAnnouncement(
  deps: Deps,
  a: AnnouncementActor,
  input: CreateAnnouncement,
) {
  const { db } = deps;
  requireReader(a);
  if (!canPublish(a)) throw new AppError('forbidden');
  if (input.pinned) await checkPinLimit(db, a.org.id);
  const { row, notes } = await db.transaction(async (tx) => {
    const now = new Date();
    const [row] = await tx
      .insert(announcements)
      .values({
        orgId: a.org.id,
        authorId: a.userId,
        title: input.title,
        body: input.body,
        pinnedAt: input.pinned ? now : null,
        requiresAck: input.requiresAck,
        publishedAt: now,
      })
      .returning();
    // The author has read their own announcement.
    await tx
      .insert(announcementReads)
      .values({ announcementId: row!.id, userId: a.userId, orgId: a.org.id, ackedAt: now });
    const recipients = (await audienceIds(tx, a.org.id)).filter((id) => id !== a.userId);
    const [author] = await tx
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, a.userId));
    const notes = await createNotifications(
      tx,
      recipients.map((userId) => ({
        orgId: a.org.id,
        userId,
        type: 'announcement.published',
        category: 'announcements' as const,
        actorId: a.userId,
        target: { type: 'announcement' as const, id: row!.id },
        data: {
          title: input.title,
          excerpt: excerpt(input.body),
          authorName: author?.name ?? null,
          important: input.pinned || input.requiresAck,
          requiresAck: input.requiresAck,
        },
        url: paths.announcement(row!.id),
        urgent: false,
      })),
      deps.presence,
    );
    await audit(tx, {
      orgId: a.org.id,
      actorId: a.userId,
      action: 'announcement.publish',
      targetType: 'announcement',
      targetId: row!.id,
      meta: { title: input.title, pinned: input.pinned, requiresAck: input.requiresAck },
    });
    return { row: row!, notes };
  });
  await deliverNotifications(deps, notes);
  // E-mail goes out from the worker, right away rather than in the digest.
  await deps.jobs.send('announcement.email', { announcementId: row.id });
  return view(db, a, row);
}

export function excerpt(body: string, max = 200) {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export async function updateAnnouncement(
  deps: Deps,
  a: AnnouncementActor,
  id: string,
  input: UpdateAnnouncement,
) {
  const { db } = deps;
  const row = await load(db, a, id);
  if (!canManage(a, row)) throw new AppError('forbidden');
  if (input.pinned === true && !row.pinnedAt) await checkPinLimit(db, a.org.id, row.id);
  const textChanged =
    (input.title !== undefined && input.title !== row.title) ||
    (input.body !== undefined && input.body !== row.body);
  const now = new Date();
  const [next] = await db
    .update(announcements)
    .set({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.requiresAck !== undefined ? { requiresAck: input.requiresAck } : {}),
      ...(input.pinned !== undefined
        ? { pinnedAt: input.pinned ? (row.pinnedAt ?? now) : null }
        : {}),
      ...(textChanged ? { editedAt: now } : {}),
    })
    .where(eq(announcements.id, row.id))
    .returning();
  await audit(db, {
    orgId: a.org.id,
    actorId: a.userId,
    action: 'announcement.update',
    targetType: 'announcement',
    targetId: row.id,
    meta: { fields: Object.keys(input) },
  });
  return view(db, a, next!);
}

export async function deleteAnnouncement(deps: Deps, a: AnnouncementActor, id: string) {
  const { db } = deps;
  const row = await load(db, a, id);
  if (!canManage(a, row)) throw new AppError('forbidden');
  await db.transaction(async (tx) => {
    // Its notifications go with it (the bell would open a missing page).
    await tx
      .delete(notifications)
      .where(
        and(
          eq(notifications.orgId, a.org.id),
          eq(notifications.targetType, 'announcement'),
          eq(notifications.targetId, row.id),
        ),
      );
    await tx.delete(announcements).where(eq(announcements.id, row.id));
    await audit(tx, {
      orgId: a.org.id,
      actorId: a.userId,
      action: 'announcement.delete',
      targetType: 'announcement',
      targetId: row.id,
      meta: { title: row.title },
    });
  });
}

async function markRead(db: DbOrTx, a: AnnouncementActor, row: Row, ack: boolean) {
  const now = new Date();
  await db
    .insert(announcementReads)
    .values({
      announcementId: row.id,
      userId: a.userId,
      orgId: a.org.id,
      readAt: now,
      ackedAt: ack ? now : null,
    })
    .onConflictDoUpdate({
      target: [announcementReads.announcementId, announcementReads.userId],
      // The first opening stays the read time; a confirmation is kept once given.
      set: ack
        ? {
            ackedAt: sql`coalesce(${announcementReads.ackedAt}, ${now.toISOString()}::timestamptz)`,
          }
        : { readAt: sql`${announcementReads.readAt}` },
    });
  // Opening it reads the bell row too.
  await db
    .update(notifications)
    .set({ readAt: now })
    .where(
      and(
        eq(notifications.orgId, a.org.id),
        eq(notifications.userId, a.userId),
        eq(notifications.targetType, 'announcement'),
        eq(notifications.targetId, row.id),
        isNull(notifications.readAt),
      ),
    );
}

export async function readAnnouncement(db: DbOrTx, a: AnnouncementActor, id: string) {
  const row = await load(db, a, id);
  await markRead(db, a, row, false);
  return view(db, a, row);
}

export async function acknowledgeAnnouncement(db: DbOrTx, a: AnnouncementActor, id: string) {
  const row = await load(db, a, id);
  if (!row.requiresAck) throw new AppError('invalid_target');
  await markRead(db, a, row, true);
  return view(db, a, row);
}

export async function listReaders(db: DbOrTx, a: AnnouncementActor, id: string) {
  const row = await load(db, a, id);
  if (!canManage(a, row)) throw new AppError('forbidden');
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      image: users.image,
      readAt: announcementReads.readAt,
      ackedAt: announcementReads.ackedAt,
    })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.userId))
    .leftJoin(
      announcementReads,
      and(
        eq(announcementReads.announcementId, row.id),
        eq(announcementReads.userId, orgMembers.userId),
      ),
    )
    .where(
      and(audienceWhere(a.org.id), row.authorId ? ne(orgMembers.userId, row.authorId) : undefined),
    )
    .orderBy(
      sql`${announcementReads.readAt} is null`,
      desc(announcementReads.readAt),
      asc(users.name),
    );
  return {
    items: rows.map((r) => ({
      user: { id: r.id, name: r.name, email: r.email, imageUrl: r.image ?? null },
      readAt: r.readAt?.toISOString() ?? null,
      ackedAt: r.ackedAt?.toISOString() ?? null,
    })),
    audienceCount: rows.length,
    readCount: rows.filter((r) => r.readAt).length,
    ackCount: rows.filter((r) => r.ackedAt).length,
  };
}

/**
 * announcement.email job: one mail per notification row that wants e-mail (preferences),
 * marked emailed so the digest does not repeat it.
 */
export async function sendAnnouncementEmails(deps: JobDeps, announcementId: string) {
  const { db } = deps;
  const [row] = await db.select().from(announcements).where(eq(announcements.id, announcementId));
  if (!row) return 0;
  if (!(await deps.mailer.enabledFor(row.orgId))) return 0;
  const pending = await db
    .select({ id: notifications.id, userId: notifications.userId })
    .from(notifications)
    .where(
      and(
        eq(notifications.targetType, 'announcement'),
        eq(notifications.targetId, row.id),
        eq(notifications.wantsEmail, true),
        isNull(notifications.emailedAt),
      ),
    );
  if (pending.length === 0) return 0;
  const [org] = await db.select().from(organizations).where(eq(organizations.id, row.orgId));
  if (!org) return 0;
  const brand = await mailBrandForOrg(db, deps.env.HUB_URL, row.orgId);
  const author = row.authorId ? (await usersById(db, [row.authorId])).get(row.authorId) : null;
  const people = new Map(
    (
      await db
        .select({ id: users.id, email: users.email, locale: users.locale })
        .from(users)
        .where(
          inArray(
            users.id,
            pending.map((p) => p.userId),
          ),
        )
    ).map((u) => [u.id, u]),
  );
  let sent = 0;
  for (const p of pending) {
    const u = people.get(p.userId);
    if (!u) continue;
    try {
      const mail = announcementMail(brand, u.locale, {
        title: row.title,
        body: row.body,
        authorName: author?.name ?? null,
        requiresAck: row.requiresAck,
        url: `${deps.env.HUB_URL.replace(/\/$/, '')}${paths.announcement(row.id)}`,
      });
      await deps.mailer.send({
        orgId: row.orgId,
        to: u.email,
        fromName: org.branding.orgName,
        ...mail,
      });
      await db
        .update(notifications)
        .set({ emailedAt: new Date() })
        .where(eq(notifications.id, p.id));
      sent++;
    } catch (err) {
      deps.logger.warn({ err, announcementId, userId: p.userId }, 'announcement mail failed');
    }
  }
  return sent;
}
