import type { PushSkipReason } from '@crewhall/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { notifications, type Db, type DbOrTx } from '@crewhall/db';
import type { Notification, NotificationCategory, NotificationSource } from '@crewhall/shared';
import { toCurrentPath } from '@crewhall/shared';
import type { Jobs } from '../../jobs/queue';
import type { Logger } from '../../logger';
import { userTopic, type Bus } from '../../realtime/bus';
import type { PresenceReader } from '../../realtime/presence';
import { usersById } from '../chat/views';
import { inQuietHours, liveVisibility, loadPrefs, loadSettings, prefForType } from './prefs';

/**
 * Notifications (doc 17 §10): the row is written in the same transaction as the event
 * that caused it; delivery (WS now, push via the push.send job, e-mail via the digest)
 * happens after commit, so a rolled-back event never notifies.
 */

export interface NotifyDeps {
  db: Db;
  bus: Bus;
  jobs: Jobs;
  logger: Logger;
  /** Api process only: people with a focused session get no push. */
  presence?: PresenceReader | null;
}

export type NotificationRow = typeof notifications.$inferSelect;

export interface NotificationInput {
  orgId: string;
  userId: string;
  type: string;
  category: NotificationCategory;
  actorId: string | null;
  target: {
    type:
      | 'message'
      | 'conversation'
      | 'node'
      | 'link'
      | 'card'
      | 'meeting'
      | 'space'
      | 'webhook'
      | 'announcement'
      | 'event'
      | 'approval'
      | 'plugin';
    id: string;
    conversationId?: string | null;
    seq?: number | null;
    spaceId?: string | null;
  };
  data: Record<string, string | number | boolean | null>;
  url: string;
  /** Unread rows with the same key merge into one ("5 yeni mention"). */
  groupKey?: string | null;
  /** Critical alerts: high priority, through quiet hours and Do not disturb. */
  urgent?: boolean;
  /** Push only, no bell row (an incoming call rings the phone; the missed call is the row). */
  pushOnly?: boolean;
  /**
   * Every device, whatever is on screen elsewhere (an incoming call rings the phone even while
   * the chat is open on the web): skips the H8 open-conversation rule and focused sessions.
   */
  everyDevice?: boolean;
  /** Bell only, no push or desktop (a plugin the person muted). */
  silent?: boolean;
  /**
   * The sender's own desktop switch (a plugin's channel): false never shows an OS notification,
   * true allows one even with `silent`; the person's rows still apply. Missing: not when silent.
   */
  desktop?: boolean;
}

/** Writes the rows (respecting preferences); call inside the event's transaction. */
export async function createNotifications(
  db: DbOrTx,
  inputs: NotificationInput[],
  presence?: PresenceReader | null,
): Promise<NotificationRow[]> {
  if (inputs.length === 0) return [];
  const orgId = inputs[0]!.orgId;
  const userIds = [...new Set(inputs.map((i) => i.userId))];
  const prefs = await loadPrefs(db, orgId, userIds);
  const settings = await loadSettings(db, orgId, userIds);
  const out: NotificationRow[] = [];
  const now = new Date();
  for (const input of inputs) {
    // H8: the person is looking at this conversation; the message is simply read there.
    const conv = input.target.conversationId;
    if (conv && !input.everyDevice && presence?.isViewingConversation?.(input.userId, conv)) {
      continue;
    }
    const pref = prefForType(prefs.get(input.userId), input.type, input.category);
    if (!pref.inApp && !pref.push && !pref.email && !pref.desktop) continue;
    const s = settings.get(input.userId)!;
    const visibility = liveVisibility(s, now);
    const urgent = input.urgent === true;
    const quiet =
      visibility === 'busy' || (!urgent && (visibility === 'dnd' || inQuietHours(s, now)));
    // At a session right now: the push is held, not dropped (holdPush), and goes to the phone if
    // the row is still unread once they stopped using that session.
    const attending = !input.everyDevice && presence?.hasFocusedSession(input.userId) === true;
    // Why this row will not push (Yönetim › Üyeler › push tanılama).
    const pushSkip: PushSkipReason | null = !pref.push
      ? 'pref_off'
      : input.silent === true
        ? 'silent'
        : visibility === 'busy'
          ? 'busy'
          : !urgent && visibility === 'dnd'
            ? 'dnd'
            : !urgent && inQuietHours(s, now)
              ? 'quiet_hours'
              : attending
                ? 'attending'
                : null;
    const values = {
      orgId: input.orgId,
      userId: input.userId,
      type: input.type,
      category: input.category,
      actorId: input.actorId,
      targetType: input.target.type,
      targetId: input.target.id,
      conversationId: input.target.conversationId ?? null,
      seq: input.target.seq ?? null,
      spaceId: input.target.spaceId ?? null,
      payload: input.data,
      url: input.url,
      groupKey: input.groupKey ?? null,
      wantsPush: pref.push && !quiet && input.silent !== true,
      pushSkip,
      // The OS notification comes from the bell's live event, so it needs a bell row; it may show
      // while the app is open elsewhere, quiet hours and Do not disturb still apply.
      wantsDesktop:
        pref.desktop &&
        pref.inApp &&
        !input.pushOnly &&
        !quiet &&
        (input.desktop ?? input.silent !== true),
      wantsEmail: pref.email,
      urgent,
      // Turned off in the app: no bell row, but push/e-mail may still go.
      dismissedAt: pref.inApp && !input.pushOnly ? null : now,
    };
    const [row] = values.groupKey
      ? await db
          .insert(notifications)
          .values(values)
          .onConflictDoUpdate({
            target: [notifications.userId, notifications.orgId, notifications.groupKey],
            targetWhere: sql`${notifications.groupKey} is not null and ${notifications.readAt} is null and ${notifications.dismissedAt} is null`,
            set: {
              count: sql`${notifications.count} + 1`,
              actorId: values.actorId,
              targetType: values.targetType,
              targetId: values.targetId,
              seq: values.seq,
              payload: values.payload,
              url: values.url,
              wantsPush: values.wantsPush,
              pushSkip: values.pushSkip,
              pushOutcome: null,
              wantsDesktop: values.wantsDesktop,
              urgent: values.urgent,
              snoozedUntil: null,
              pushedAt: null,
              updatedAt: now,
            },
          })
          .returning()
      : await db.insert(notifications).values(values).returning();
    if (row) out.push(row);
  }
  return out;
}

/**
 * Pushes of one conversation are grouped in windows this long: the first goes at once, the rest
 * go together when the window ends (singletonNextSlot), so the last message always arrives.
 */
const PUSH_GROUP_SECONDS = 15;
const URGENT_REPEAT_SECONDS = 5 * 60;
/** A held push is looked at again this often while its person is still at a session ... */
let PUSH_HOLD_MS = 2 * 60_000;
/** ... and given up after this long: they used the app all along and had the bell. */
let PUSH_HOLD_MAX_MS = 30 * 60_000;

/** Held pushes of this api process, one per person and group (a burst of messages holds once). */
const held = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * The person was at a focused session when the row was written (push_skip "attending"): instead of
 * no push at all, wait while they keep using it, then send if the row is still unread (push.send
 * checks read state and sends the group's newest row). Kept in memory: a restart drops the hold
 * and the row stays "attending" in the push diagnostics.
 */
function holdPush(deps: NotifyDeps, row: NotificationRow, waitedMs = 0) {
  const presence = deps.presence;
  if (!presence) return;
  const key = `${row.userId}:${row.groupKey ?? row.id}`;
  if (waitedMs === 0 && held.has(key)) return;
  const timer = setTimeout(() => {
    held.delete(key);
    const waited = waitedMs + PUSH_HOLD_MS;
    if (presence.hasFocusedSession(row.userId)) {
      if (waited < PUSH_HOLD_MAX_MS) holdPush(deps, row, waited);
      else
        deps.logger.info(
          { notificationId: row.id, userId: row.userId },
          'held push dropped: still at a session',
        );
      return;
    }
    deps.logger.info(
      { notificationId: row.id, userId: row.userId, waitedMs: waited },
      'held push released',
    );
    deps.jobs
      .send(
        'push.send',
        { notificationId: row.id },
        {
          singletonKey: `push:${row.userId}:${row.groupKey ?? row.id}`,
          singletonSeconds: PUSH_GROUP_SECONDS,
          singletonNextSlot: true,
        },
      )
      .catch((err: unknown) =>
        deps.logger.warn({ err, notificationId: row.id }, 'held push could not be queued'),
      );
  }, PUSH_HOLD_MS);
  timer.unref?.();
  held.set(key, timer);
}

/** Tests: forget held pushes and shorten the hold. */
export function setPushHoldForTests(holdMs = 2 * 60_000, maxMs = 30 * 60_000) {
  for (const t of held.values()) clearTimeout(t);
  held.clear();
  PUSH_HOLD_MS = holdMs;
  PUSH_HOLD_MAX_MS = maxMs;
}

/** After commit: bell over WS, push jobs. */
export async function deliverNotifications(deps: NotifyDeps, rows: NotificationRow[]) {
  if (rows.length === 0) return;
  const views = await toNotifications(deps.db, rows);
  const counts = new Map<string, number>();
  for (const [i, row] of rows.entries()) {
    try {
      if (!row.dismissedAt) {
        let unread = counts.get(row.userId);
        if (unread === undefined) {
          unread = await unreadCount(deps.db, row.orgId, row.userId);
          counts.set(row.userId, unread);
        }
        deps.bus.publish(userTopic(row.userId), {
          type: 'notification',
          notification: views[i]!,
          unreadCount: unread,
        });
      }
      if (row.wantsPush && row.pushSkip === 'attending') {
        holdPush(deps, row);
      } else if (row.wantsPush) {
        await deps.jobs.send(
          'push.send',
          { notificationId: row.id },
          {
            singletonKey: `push:${row.userId}:${row.groupKey ?? row.id}`,
            singletonSeconds: PUSH_GROUP_SECONDS,
            singletonNextSlot: true,
          },
        );
        if (row.urgent) {
          await deps.jobs.send(
            'push.send',
            { notificationId: row.id, repeat: true },
            { startAfterSeconds: URGENT_REPEAT_SECONDS, singletonKey: `repeat:${row.id}` },
          );
        }
      }
    } catch (err) {
      deps.logger.warn({ err, notificationId: row.id }, 'notification delivery failed');
    }
  }
}

/** Convenience for events outside a transaction (link status, webhook failures). */
export async function notify(deps: NotifyDeps, inputs: NotificationInput[]) {
  const rows = await createNotifications(deps.db, inputs, deps.presence);
  await deliverNotifications(deps, rows);
  return rows;
}

const visibleInbox = (orgId: string, userId: string) =>
  and(
    eq(notifications.orgId, orgId),
    eq(notifications.userId, userId),
    isNull(notifications.dismissedAt),
    sql`(${notifications.snoozedUntil} is null or ${notifications.snoozedUntil} <= now())`,
  );

export async function unreadCount(db: DbOrTx, orgId: string, userId: string) {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(visibleInbox(orgId, userId), isNull(notifications.readAt)));
  return r?.n ?? 0;
}

export function sourceOf(type: string, category: string): NotificationSource {
  const prefix = type.split('.')[0];
  if (type === 'chat.alert' || type === 'chat.webhook_failing' || prefix === 'link') {
    return 'alerts';
  }
  switch (prefix) {
    case 'chat':
      return 'chat';
    case 'page':
    case 'wiki':
      return 'pages';
    case 'board':
    case 'boards':
      return 'boards';
    case 'meet':
    case 'meeting':
    case 'calendar':
      return 'meetings';
    case 'drive':
    case 'space':
      return 'drive';
    case 'vault':
      return 'vault';
    case 'announcement':
      return 'announcements';
    case 'forms':
    case 'automations':
      return 'alerts';
    case 'approval':
      return 'account';
    case 'plugin':
      return 'alerts';
    default:
      return category === 'security' || category === 'portal' ? 'account' : 'chat';
  }
}

export async function toNotifications(db: DbOrTx, rows: NotificationRow[]) {
  const people = await usersById(
    db,
    rows.map((r) => r.actorId).filter((v): v is string => !!v),
  );
  return rows.map((r): Notification => ({
    id: r.id,
    type: r.type,
    category: r.category as Notification['category'],
    source: sourceOf(r.type, r.category),
    actor: r.actorId ? (people.get(r.actorId) ?? null) : null,
    target: {
      type: r.targetType as Notification['target']['type'],
      id: r.targetId,
      conversationId: r.conversationId,
      seq: r.seq,
      spaceId: r.spaceId,
    },
    // Rows of API 33 carried a plugin's "not on the desktop" in the payload; now wants_desktop.
    desktop: r.wantsDesktop && r.payload.desktop !== false,
    data: Object.fromEntries(Object.entries(r.payload).filter(([k]) => k !== 'desktop')),
    count: r.count,
    // Rows from before the English paths still hold Turkish ones (paths.ts).
    url: toCurrentPath(r.url),
    readAt: r.readAt?.toISOString() ?? null,
    snoozedUntil:
      r.snoozedUntil && r.snoozedUntil.getTime() > Date.now() ? r.snoozedUntil.toISOString() : null,
    dismissedAt: r.dismissedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export { visibleInbox };
