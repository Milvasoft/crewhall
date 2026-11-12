import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  invitations,
  orgMembers,
  organizations,
  sessions,
  spaces,
  users,
  type DbOrTx,
  type OrgRoleValue,
} from '@crewhall/db';
import { resolveLocale } from '@crewhall/i18n';
import type { CreateInvitation, Invitation, InvitationPreview } from '@crewhall/shared';
import type { Deps } from '../deps';
import { AppError } from '../http/errors';
import type { OrgRow, RequestInfo } from '../http/types';
import { inviteMail } from '../mail/templates';
import { audit } from './audit';
import { mailBrandForOrg } from './brand';
import { defaultSpaceIds, ensurePersonalSpace, joinSpaces } from './spaces';
import { paths } from '@crewhall/shared';

/** Invitations are valid for 7 days (design 1.9). */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Role a person gets in the spaces listed on the invitation (design 1.9 shows "İzleyen"). */
export const INVITED_SPACE_ROLE = 'viewer' as const;

type InvitationRow = typeof invitations.$inferSelect;
type UserRow = typeof users.$inferSelect;

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export const invitationUrl = (hubUrl: string, token: string) => `${hubUrl}${paths.invite(token)}`;

function toInvitation(row: InvitationRow, inviter: UserRow, url?: string): Invitation {
  return {
    id: row.id,
    email: row.email,
    role: row.role as Invitation['role'],
    invitedBy: {
      id: inviter.id,
      name: inviter.name,
      email: inviter.email,
      imageUrl: inviter.image,
    },
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    memberExpiresAt: row.memberExpiresAt?.toISOString() ?? null,
    ...(url ? { url } : {}),
  };
}

/** Spaces the invitee joins on accept: listed ones, plus default spaces unless a guest. */
async function spacesForInvitation(db: DbOrTx, orgId: string, row: InvitationRow) {
  const ids = new Set(row.spaceIds);
  if (row.role !== 'guest') for (const id of await defaultSpaceIds(db, orgId)) ids.add(id);
  if (ids.size === 0) return [];
  return db
    .select({ id: spaces.id, name: spaces.name })
    .from(spaces)
    .where(
      and(
        eq(spaces.orgId, orgId),
        inArray(spaces.id, [...ids]),
        eq(spaces.kind, 'shared'),
        isNull(spaces.archivedAt),
      ),
    );
}

export interface IssueInvitationInput {
  email: string;
  role: Exclude<OrgRoleValue, 'owner'>;
  spaceIds: string[];
  memberExpiresAt?: string | undefined;
  spaceRole?: 'viewer' | 'editor' | undefined;
}

/**
 * Creates (or renews) an invitation and e-mails it when SMTP is set up. Returns the
 * row and the one-time token; the token is never stored in clear.
 */
export async function issueInvitation(
  db: DbOrTx,
  org: OrgRow,
  inviter: UserRow,
  input: IssueInvitationInput,
  req: RequestInfo | undefined,
) {
  const email = input.email.trim();
  const [member] = await db
    .select({ id: orgMembers.id })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.userId))
    .where(and(eq(orgMembers.organizationId, org.id), sql`${users.email} = ${email}`));
  if (member) throw new AppError('conflict', { reason: 'already_member' });

  const spaceIds = [...new Set(input.spaceIds)];
  const fieldError = (field: string, code: string) =>
    new AppError('validation_failed', {
      in: 'body',
      issues: [{ path: [field], code, message: code }],
    });
  if (input.role !== 'guest' && (input.memberExpiresAt || input.spaceRole)) {
    throw fieldError(input.memberExpiresAt ? 'memberExpiresAt' : 'spaceRole', 'guests_only');
  }
  const memberExpiresAt = input.memberExpiresAt ? new Date(input.memberExpiresAt) : null;
  if (memberExpiresAt && memberExpiresAt <= new Date()) {
    throw fieldError('memberExpiresAt', 'in_past');
  }
  if (spaceIds.length) {
    const found = await db
      .select({ id: spaces.id })
      .from(spaces)
      .where(
        and(
          eq(spaces.orgId, org.id),
          inArray(spaces.id, spaceIds),
          eq(spaces.kind, 'shared'),
          isNull(spaces.archivedAt),
        ),
      );
    if (found.length !== spaceIds.length) {
      throw new AppError('validation_failed', {
        in: 'body',
        issues: [{ path: ['spaceIds'], code: 'unknown_space', message: 'unknown space' }],
      });
    }
  }

  // Renewing replaces any pending invitation for the same address.
  await db
    .update(invitations)
    .set({ status: 'canceled' })
    .where(
      and(
        eq(invitations.organizationId, org.id),
        sql`${invitations.email} = ${email}`,
        eq(invitations.status, 'pending'),
      ),
    );

  const token = randomBytes(24).toString('base64url');
  const [row] = await db
    .insert(invitations)
    .values({
      organizationId: org.id,
      email,
      role: input.role,
      inviterId: inviter.id,
      tokenHash: hashToken(token),
      spaceIds,
      memberExpiresAt,
      spaceRole: input.spaceRole ?? null,
      expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
    })
    .returning();
  if (!row) throw new AppError('internal');
  await audit(
    db,
    {
      orgId: org.id,
      actorId: inviter.id,
      action: 'org.invitation.create',
      targetType: 'invitation',
      targetId: row.id,
      meta: { email, role: input.role, spaceIds },
    },
    req,
  );
  return { row, token };
}

/** Sends the invitation e-mail; failures are logged, the link still works. */
export async function sendInvitationMail(
  deps: Pick<Deps, 'db' | 'env' | 'mailer' | 'logger'>,
  org: OrgRow,
  inviter: UserRow,
  row: InvitationRow,
  token: string,
) {
  if (!(await deps.mailer.enabledFor(org.id))) return;
  try {
    const brand = await mailBrandForOrg(deps.db, deps.env.HUB_URL, org.id);
    const targetSpaces = await spacesForInvitation(deps.db, org.id, row);
    const mail = inviteMail(brand, {
      locale: resolveLocale(org.settings.defaultLocale),
      to: row.email,
      inviterName: inviter.name,
      inviterEmail: inviter.email,
      role: row.role,
      spaces: targetSpaces.map((s) => ({ name: s.name, role: INVITED_SPACE_ROLE })),
      url: invitationUrl(deps.env.HUB_URL, token),
      expiresAt: row.expiresAt,
      twoFactorRequired: org.settings.requireTwoFactor || row.role === 'admin',
    });
    await deps.mailer.send({
      orgId: org.id,
      to: row.email,
      fromName: org.branding.orgName,
      ...mail,
    });
  } catch (err) {
    deps.logger.warn({ err, invitationId: row.id }, 'invitation mail failed');
  }
}

export async function createInvitation(
  deps: Deps,
  org: OrgRow,
  inviter: UserRow,
  input: CreateInvitation,
  req: RequestInfo,
): Promise<Invitation> {
  const { row, token } = await deps.db.transaction((tx) =>
    issueInvitation(tx, org, inviter, input, req),
  );
  await sendInvitationMail(deps, org, inviter, row, token);
  return toInvitation(row, inviter, invitationUrl(deps.env.HUB_URL, token));
}

export async function listInvitations(db: DbOrTx, orgId: string): Promise<Invitation[]> {
  const rows = await db
    .select({ i: invitations, u: users })
    .from(invitations)
    .innerJoin(users, eq(users.id, invitations.inviterId))
    .where(and(eq(invitations.organizationId, orgId), eq(invitations.status, 'pending')))
    .orderBy(desc(invitations.createdAt));
  return rows.map((r) => toInvitation(r.i, r.u));
}

export async function revokeInvitation(
  db: DbOrTx,
  orgId: string,
  actorId: string,
  invitationId: string,
  req: RequestInfo,
) {
  const [row] = await db
    .update(invitations)
    .set({ status: 'canceled' })
    .where(
      and(
        eq(invitations.id, invitationId),
        eq(invitations.organizationId, orgId),
        eq(invitations.status, 'pending'),
      ),
    )
    .returning();
  if (!row) throw new AppError('not_found');
  await audit(
    db,
    {
      orgId,
      actorId,
      action: 'org.invitation.revoke',
      targetType: 'invitation',
      targetId: row.id,
      meta: { email: row.email },
    },
    req,
  );
}

async function findUsable(db: DbOrTx, token: string) {
  const [row] = await db
    .select({ i: invitations, org: organizations, inviter: users })
    .from(invitations)
    .innerJoin(organizations, eq(organizations.id, invitations.organizationId))
    .innerJoin(users, eq(users.id, invitations.inviterId))
    .where(eq(invitations.tokenHash, hashToken(token)));
  if (!row) throw new AppError('not_found');
  if (row.i.status !== 'pending' || row.i.expiresAt.getTime() <= Date.now()) {
    throw new AppError('invitation_expired');
  }
  return row;
}

export async function previewInvitation(db: DbOrTx, token: string): Promise<InvitationPreview> {
  const { i, org, inviter } = await findUsable(db, token);
  const targetSpaces = await spacesForInvitation(db, org.id, i);
  const [account] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`${users.email} = ${i.email}`);
  return {
    orgName: org.branding.orgName,
    invitedByName: inviter.name,
    email: i.email,
    role: i.role,
    expiresAt: i.expiresAt.toISOString(),
    spaces: targetSpaces.map((s) => ({
      ...s,
      role: i.spaceIds.includes(s.id) ? (i.spaceRole ?? INVITED_SPACE_ROLE) : INVITED_SPACE_ROLE,
    })),
    hasAccount: Boolean(account),
  };
}

/**
 * Accepting joins the org with the invited role, opens the personal space, adds the
 * person to the invitation's spaces and makes the org active for this session.
 * The link reached the invited inbox, so the address counts as verified.
 */
export async function acceptInvitation(
  db: DbOrTx,
  token: string,
  user: { id: string; email: string; name: string },
  sessionId: string | null,
  req: RequestInfo,
  options: { defaultSpaceRole?: 'admin' | 'editor' | 'viewer' } = {},
) {
  const { i, org } = await findUsable(db, token);
  if (i.email.toLowerCase() !== user.email.toLowerCase()) {
    throw new AppError('invitation_email_mismatch');
  }
  const [existing] = await db
    .select()
    .from(orgMembers)
    .where(and(eq(orgMembers.organizationId, org.id), eq(orgMembers.userId, user.id)));
  if (existing?.status === 'suspended') throw new AppError('forbidden', { reason: 'suspended' });

  if (!existing) {
    await db.insert(orgMembers).values({
      organizationId: org.id,
      userId: user.id,
      role: i.role,
      status: 'active',
      joinedAt: new Date(),
      expiresAt: i.role === 'guest' ? i.memberExpiresAt : null,
    });
  }
  const role = existing?.role ?? i.role;
  if (role !== 'guest') {
    await ensurePersonalSpace(db, org.id, user);
    await joinSpaces(
      db,
      org.id,
      user.id,
      await defaultSpaceIds(db, org.id),
      options.defaultSpaceRole ?? INVITED_SPACE_ROLE,
      i.inviterId,
    );
  }
  await joinSpaces(db, org.id, user.id, i.spaceIds, i.spaceRole ?? INVITED_SPACE_ROLE, i.inviterId);

  await db
    .update(invitations)
    .set({ status: 'accepted', acceptedAt: new Date(), acceptedBy: user.id })
    .where(eq(invitations.id, i.id));
  await db.update(users).set({ emailVerified: true }).where(eq(users.id, user.id));
  if (sessionId) {
    await db
      .update(sessions)
      .set({ activeOrganizationId: org.id })
      .where(eq(sessions.id, sessionId));
  }
  if (!existing) {
    await audit(
      db,
      {
        orgId: org.id,
        actorId: user.id,
        action: 'org.member.join',
        targetType: 'user',
        targetId: user.id,
        meta: { role: i.role, invitationId: i.id, invitedBy: i.inviterId },
      },
      req,
    );
  }
  return org.id;
}
