import { and, desc, eq, gt } from 'drizzle-orm';
import { sessions, users, type DbOrTx } from '@crewhall/db';
import type { Me, OrgPermission, SessionInfo } from '@crewhall/shared';
import { resolveLocale } from '@crewhall/i18n';
import { AppError } from '../http/errors';
import type { AuthSession, AuthUser, RequestInfo } from '../http/types';
import { audit } from './audit';
import {
  activeMemberships,
  hasPasskey,
  resolveActiveOrg,
  sessionHasTrustedMfa,
  twoFactorPolicyApplies,
} from './membership';
import { enabledModules } from './identity/modules';
import { personalSpaceId } from './spaces';
import { trashRetentionDays } from './trash/retention';
import { isInstallAdmin } from './backups/service';

export async function getMe(db: DbOrTx, userId: string, session: AuthSession): Promise<Me> {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) throw new AppError('unauthenticated');
  const active = await resolveActiveOrg(db, userId, session);
  const memberships = await activeMemberships(db, userId);
  const passkey = await hasPasskey(db, userId);
  const twoFactorRequired =
    active !== null &&
    twoFactorPolicyApplies(active.org, active.member) &&
    !user.twoFactorEnabled &&
    !passkey &&
    !(await sessionHasTrustedMfa(db, session.id));
  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      imageUrl: user.image,
      locale: resolveLocale(user.locale),
      twoFactorEnabled: user.twoFactorEnabled,
      hasPasskey: passkey,
    },
    activeOrgId: active?.org.id ?? null,
    memberships: memberships.map(({ member, org }) => ({
      orgId: org.id,
      orgName: org.name,
      orgSlug: org.slug,
      role: member.role,
      permissions: member.permissions as OrgPermission[],
    })),
    personalSpaceId: active ? await personalSpaceId(db, active.org.id, userId) : null,
    twoFactorRequired,
    modules: enabledModules(active?.org.settings),
    trashRetentionDays: trashRetentionDays(active?.org.settings),
    installAdmin: active ? await isInstallAdmin(db, active.org.id, active.member.role) : false,
    accessExpiresAt: active?.member.expiresAt?.toISOString() ?? null,
  };
}

export async function updateMe(
  db: DbOrTx,
  user: AuthUser,
  input: { name?: string | undefined; locale?: 'tr' | 'en' | undefined },
) {
  const patch: Partial<typeof users.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.locale !== undefined) patch.locale = input.locale;
  if (Object.keys(patch).length) await db.update(users).set(patch).where(eq(users.id, user.id));
}

export async function switchOrg(db: DbOrTx, userId: string, sessionId: string, orgId: string) {
  const rows = await activeMemberships(db, userId);
  if (!rows.some((r) => r.org.id === orgId))
    throw new AppError('forbidden', { reason: 'not_a_member' });
  await db.update(sessions).set({ activeOrganizationId: orgId }).where(eq(sessions.id, sessionId));
}

export async function listSessions(
  db: DbOrTx,
  userId: string,
  currentId: string,
): Promise<SessionInfo[]> {
  const rows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, new Date())))
    .orderBy(desc(sessions.updatedAt));
  return rows.map((s) => ({
    id: s.id,
    current: s.id === currentId,
    userAgent: s.userAgent,
    ip: s.ipAddress,
    createdAt: s.createdAt.toISOString(),
    lastActiveAt: s.updatedAt.toISOString(),
  }));
}

/** Signs out one of the user's sessions (another device, or this one). */
export async function revokeSession(
  db: DbOrTx,
  userId: string,
  sessionId: string,
  req: RequestInfo,
) {
  const [row] = await db
    .delete(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
    .returning({ id: sessions.id, orgId: sessions.activeOrganizationId });
  if (!row) throw new AppError('not_found');
  await audit(
    db,
    {
      orgId: row.orgId,
      actorId: userId,
      action: 'session.revoke',
      targetType: 'session',
      targetId: row.id,
    },
    req,
  );
}
