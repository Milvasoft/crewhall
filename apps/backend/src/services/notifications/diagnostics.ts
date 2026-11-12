import { and, desc, eq } from 'drizzle-orm';
import {
  conversationMembers,
  notifications,
  orgMembers,
  pushDevices,
  type DbOrTx,
} from '@crewhall/db';
import {
  PushSkipReason,
  type OrgSettings,
  type PushDiagnostics,
  type PushProvider,
} from '@crewhall/shared';
import { AppError } from '../../http/errors';
import type { PresenceTracker } from '../../realtime/presence';
import { getNotificationPrefs, inQuietHours, liveVisibility, loadSettings } from './prefs';

const RECENT = 30;

/**
 * "Why didn't this person get this push?": the decision is made when a notification is created
 * (notifications.push_skip), the providers answer when it is sent (push_outcome), and the live
 * part (who is at a session right now) comes from the api's own presence.
 */
export async function pushDiagnostics(
  deps: { db: DbOrTx; presence: Pick<PresenceTracker, 'sessions'> },
  org: { id: string; settings: Pick<OrgSettings, 'modules'> | null },
  userId: string,
  conversationId?: string,
): Promise<PushDiagnostics> {
  const { db } = deps;
  const [member] = await db
    .select({ id: orgMembers.userId })
    .from(orgMembers)
    .where(and(eq(orgMembers.organizationId, org.id), eq(orgMembers.userId, userId)));
  if (!member) throw new AppError('member_not_found');
  const now = new Date();
  const settings = (await loadSettings(db, org.id, [userId])).get(userId)!;
  const prefs = await getNotificationPrefs(db, org.id, userId, org.settings);
  const devices = await db
    .select()
    .from(pushDevices)
    .where(and(eq(pushDevices.orgId, org.id), eq(pushDevices.userId, userId)));
  const rows = await db
    .select()
    .from(notifications)
    .where(and(eq(notifications.orgId, org.id), eq(notifications.userId, userId)))
    .orderBy(desc(notifications.updatedAt))
    .limit(RECENT);
  const [membership] = conversationId
    ? await db
        .select({ notify: conversationMembers.notify, mutedUntil: conversationMembers.mutedUntil })
        .from(conversationMembers)
        .where(
          and(
            eq(conversationMembers.conversationId, conversationId),
            eq(conversationMembers.userId, userId),
          ),
        )
    : [];
  return {
    userId,
    now: now.toISOString(),
    visibility: liveVisibility(settings, now),
    quietHours: prefs.quietHours,
    inQuietHours: inQuietHours(settings, now),
    sessions: deps.presence.sessions(userId),
    devices: devices.map((d) => ({
      id: d.id,
      provider: d.provider as PushProvider,
      platform: d.platform,
      appVersion: d.appVersion,
      lastSeenAt: d.lastSeenAt.toISOString(),
      disabledAt: d.disabledAt?.toISOString() ?? null,
      disabledReason: d.disabledReason,
      mutedUntil: d.mutedUntil?.toISOString() ?? null,
    })),
    groups: prefs.groups ?? [],
    conversation: membership
      ? { notify: membership.notify, mutedUntil: membership.mutedUntil?.toISOString() ?? null }
      : null,
    recent: rows.map((r) => ({
      id: r.id,
      type: r.type,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      count: r.count,
      wantsPush: r.wantsPush,
      pushSkip: PushSkipReason.safeParse(r.pushSkip).data ?? null,
      pushedAt: r.pushedAt?.toISOString() ?? null,
      readAt: r.readAt?.toISOString() ?? null,
      outcome: r.pushOutcome,
    })),
  };
}
