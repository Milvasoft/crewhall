import { and, asc, eq, sql } from 'drizzle-orm';
import {
  identitySessions,
  orgMembers,
  organizations,
  passkeys,
  sessions,
  type DbOrTx,
} from '@crewhall/db';
import type { Actor, OrgPermission } from '@crewhall/shared';
import type { MemberRow, OrgRow } from '../http/types';
import { liveMember } from './guests';
import { isDemoMode } from './demo-flag';

export async function activeMemberships(db: DbOrTx, userId: string) {
  return db
    .select({ member: orgMembers, org: organizations })
    .from(orgMembers)
    .innerJoin(organizations, eq(organizations.id, orgMembers.organizationId))
    .where(and(eq(orgMembers.userId, userId), liveMember()))
    .orderBy(asc(orgMembers.joinedAt), asc(orgMembers.createdAt));
}

/**
 * The session's active org, falling back to the first active membership. The
 * fallback is written back to the session so every client sees the same org.
 */
export async function resolveActiveOrg(
  db: DbOrTx,
  userId: string,
  session: { id: string; activeOrganizationId?: string | null },
): Promise<{ org: OrgRow; member: MemberRow } | null> {
  const rows = await activeMemberships(db, userId);
  const chosen = rows.find((r) => r.org.id === session.activeOrganizationId) ?? rows[0] ?? null;
  const chosenId = chosen?.org.id ?? null;
  if ((session.activeOrganizationId ?? null) !== chosenId) {
    await db
      .update(sessions)
      .set({ activeOrganizationId: chosenId })
      .where(eq(sessions.id, session.id));
  }
  return chosen;
}

export async function hasPasskey(db: DbOrTx, userId: string) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(passkeys)
    .where(eq(passkeys.userId, userId));
  return (row?.n ?? 0) > 0;
}

/**
 * 2FA policy (design 1.14 and "Zorunlu 2FA"): the org setting applies to everyone,
 * owners and admins always need it. TOTP or a passkey satisfies it.
 */
export function twoFactorPolicyApplies(org: OrgRow, member: MemberRow) {
  // Live demo: visitors share the sample accounts, so no second factor is asked.
  if (isDemoMode()) return false;
  return org.settings.requireTwoFactor || member.role === 'owner' || member.role === 'admin';
}

export async function needsTwoFactorEnrolment(
  db: DbOrTx,
  org: OrgRow,
  member: MemberRow,
  user: { id: string; twoFactorEnabled?: boolean | null },
  sessionId?: string,
) {
  if (!twoFactorPolicyApplies(org, member)) return false;
  if (user.twoFactorEnabled) return false;
  if (sessionId && (await sessionHasTrustedMfa(db, sessionId))) return false;
  return !(await hasPasskey(db, user.id));
}

/** SSO sign-in whose IdP MFA the org trusts (identity module) satisfies the 2FA policy. */
export async function sessionHasTrustedMfa(db: DbOrTx, sessionId: string) {
  const [row] = await db
    .select({ mfa: identitySessions.mfa })
    .from(identitySessions)
    .where(eq(identitySessions.sessionId, sessionId));
  return row?.mfa === true;
}

export const toActor = (member: MemberRow): Actor => ({
  userId: member.userId,
  orgRole: member.role,
  orgPermissions: member.permissions as OrgPermission[],
});

export const orgContext = (org: OrgRow) => ({
  settings: {
    membersCanCreateSpaces: org.settings.membersCanCreateSpaces,
    publicLinksEnabled: org.settings.publicLinksEnabled,
  },
});
