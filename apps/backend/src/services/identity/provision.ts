import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  externalIdentities,
  organizations,
  orgMembers,
  spaceMembers,
  spaces,
  users,
  type DbOrTx,
} from '@crewhall/db';
import type { IdpRoleMapping, OrgRole, SpaceRole } from '@crewhall/shared';
import { resolveLocale } from '@crewhall/i18n';
import { signupBypass } from '../../auth/auth';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { RequestInfo } from '../../http/types';
import { INVITED_SPACE_ROLE } from '../invitations';
import { defaultSpaceIds, ensurePersonalSpace, joinSpaces } from '../spaces';
import { identityAudit } from './audit';
import { mappingsOf, type ProviderRow } from './providers';

/** What an IdP or directory says about a person after a successful authentication. */
export interface ExternalProfile {
  subject: string;
  /** Earlier subjects of the same person (Entra: `sub` before the object id was used). */
  altSubjects?: string[];
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  groups: string[];
  dn?: string | null;
  /** The IdP reported multi-factor authentication (amr/acr). */
  mfa?: boolean;
}

const ORG_RANK: Record<string, number> = { guest: 1, member: 2, admin: 3, owner: 4 };
const SPACE_RANK: Record<string, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 };

/** `cn=Developers,ou=groups,dc=x` → `Developers`. */
function firstRdnValue(group: string) {
  const m = /^[^=,]+=((?:\\.|[^,])+)/.exec(group);
  return m?.[1]?.replace(/\\(.)/g, '$1') ?? null;
}

export function groupMatches(mapping: string, group: string) {
  const a = mapping.trim().toLowerCase();
  const b = group.trim().toLowerCase();
  if (a === b) return true;
  const cn = firstRdnValue(group)?.toLowerCase();
  return cn !== undefined && cn === a;
}

export interface ResolvedRoles {
  /** Highest mapped org role; null when no org-role mapping matched. */
  orgRole: Exclude<OrgRole, 'owner'> | null;
  /** Whether any mapping sets an org role at all (then the default applies to non-matches). */
  hasOrgMappings: boolean;
  spaces: Map<string, Exclude<SpaceRole, 'owner'>>;
  /** Spaces some mapping manages (membership removed when no group grants it). */
  managedSpaces: Set<string>;
}

export function resolveRoles(mappings: IdpRoleMapping[], groups: string[]): ResolvedRoles {
  let orgRole: ResolvedRoles['orgRole'] = null;
  const spaceRoles = new Map<string, Exclude<SpaceRole, 'owner'>>();
  const managed = new Set<string>();
  for (const m of mappings) {
    if (m.spaceId) managed.add(m.spaceId);
    if (!groups.some((g) => groupMatches(m.group, g))) continue;
    if (m.orgRole && (!orgRole || ORG_RANK[m.orgRole]! > ORG_RANK[orgRole]!)) orgRole = m.orgRole;
    if (m.spaceId) {
      const role = m.spaceRole ?? 'viewer';
      const current = spaceRoles.get(m.spaceId);
      if (!current || SPACE_RANK[role]! > SPACE_RANK[current]!) spaceRoles.set(m.spaceId, role);
    }
  }
  return {
    orgRole,
    hasOrgMappings: mappings.some((m) => m.orgRole),
    spaces: spaceRoles,
    managedSpaces: managed,
  };
}

async function findUserByEmail(db: DbOrTx, email: string) {
  const [row] = await db
    .select()
    .from(users)
    .where(sql`${users.email} = ${email}`);
  return row ?? null;
}

async function createUser(
  create: UserCreator,
  provider: ProviderRow,
  profile: ExternalProfile,
  orgLocale: string,
) {
  const email = profile.email!.toLowerCase();
  const name = profile.name?.trim() || email.split('@')[0]!;
  const user = await signupBypass.run(true, () =>
    create(
      { email, name, emailVerified: true, locale: resolveLocale(orgLocale) },
      provider.kind === 'ldap'
        ? { method: 'ldap' }
        : {
            method: provider.kind === 'saml' ? 'sso-saml' : 'sso-oidc',
            sso: { providerId: provider.id },
          },
    ),
  );
  if (!user) throw new AppError('internal');
  return user;
}

/**
 * Applies the provider's mappings: org role (never to or from owner) and space memberships.
 * Memberships the directory manages are rows added by the system (added_by null).
 */
export async function applyRoles(
  db: DbOrTx,
  provider: ProviderRow,
  userId: string,
  roles: ResolvedRoles,
  member: typeof orgMembers.$inferSelect,
  req: RequestInfo | null,
) {
  const changes: Record<string, unknown> = {};
  if (member.role !== 'owner' && roles.hasOrgMappings) {
    const target = roles.orgRole ?? provider.defaultRole;
    if (target !== member.role) {
      await db.update(orgMembers).set({ role: target }).where(eq(orgMembers.id, member.id));
      changes.orgRole = { from: member.role, to: target };
      if (target !== 'guest') {
        const [user] = await db.select().from(users).where(eq(users.id, userId));
        if (user) await ensurePersonalSpace(db, provider.orgId, user);
      }
    }
  }
  const effectiveRole = (changes.orgRole as { to?: string } | undefined)?.to ?? member.role;
  if (roles.managedSpaces.size) {
    const current = await db
      .select({
        spaceId: spaceMembers.spaceId,
        role: spaceMembers.role,
        addedBy: spaceMembers.addedBy,
      })
      .from(spaceMembers)
      .where(
        and(
          eq(spaceMembers.userId, userId),
          inArray(spaceMembers.spaceId, [...roles.managedSpaces]),
        ),
      );
    const byId = new Map(current.map((c) => [c.spaceId, c]));
    const added: string[] = [];
    const removed: string[] = [];
    for (const spaceId of roles.managedSpaces) {
      const want = roles.spaces.get(spaceId);
      const have = byId.get(spaceId);
      if (want && !have) {
        const [space] = await db
          .select({ id: spaces.id })
          .from(spaces)
          .where(
            and(
              eq(spaces.id, spaceId),
              eq(spaces.orgId, provider.orgId),
              eq(spaces.kind, 'shared'),
              isNull(spaces.archivedAt),
            ),
          );
        if (!space) continue;
        await db
          .insert(spaceMembers)
          .values({ spaceId, userId, orgId: provider.orgId, role: want, addedBy: null })
          .onConflictDoNothing();
        added.push(spaceId);
      } else if (
        want &&
        have &&
        have.addedBy === null &&
        have.role !== want &&
        have.role !== 'owner'
      ) {
        await db
          .update(spaceMembers)
          .set({ role: want })
          .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)));
        added.push(spaceId);
      } else if (!want && have && have.addedBy === null && have.role !== 'owner') {
        await db
          .delete(spaceMembers)
          .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)));
        removed.push(spaceId);
      }
    }
    if (added.length) changes.spacesSet = added;
    if (removed.length) changes.spacesRemoved = removed;
  }
  if (Object.keys(changes).length) {
    await identityAudit(
      db,
      {
        orgId: provider.orgId,
        actorId: null,
        action: 'identity.role.sync',
        targetType: 'user',
        targetId: userId,
        meta: { provider: provider.id, role: effectiveRole, ...changes },
      },
      req,
    );
  }
}

/** better-auth's internalAdapter.createUser (runs the user hooks: locale, invite-only gate). */
export type UserCreator = (
  data: { email: string; name: string; emailVerified: boolean; locale: string },
  source: { method: string; sso?: { providerId: string } },
) => Promise<{ id: string } | null>;

export function userCreatorOf(deps: Pick<Deps, 'auth'>): UserCreator {
  return async (data, source) =>
    (await deps.auth.$context).internalAdapter.createUser(data, source);
}

export interface ProvisionResult {
  userId: string;
  orgId: string;
  created: boolean;
  linked: boolean;
  externalId: string;
}

/**
 * The Crewhall account for an authenticated external identity (design: JIT, account
 * linking by e-mail, group → role/space mapping). Throws AppError with the sso_* codes.
 */
export async function provisionUser(
  deps: Pick<Deps, 'db'>,
  create: UserCreator,
  provider: ProviderRow,
  profile: ExternalProfile,
  req: RequestInfo | null,
  /** SCIM provisioning: not a sign-in, so no last-login time. */
  opts: { scim?: boolean } = {},
): Promise<ProvisionResult> {
  const { db } = deps;
  const [org] = await db.select().from(organizations).where(eq(organizations.id, provider.orgId));
  if (!org) throw new AppError('sso_login_failed');
  const email = profile.email?.trim().toLowerCase() || null;

  let created = false;
  let linked = false;
  let [existingLink] = await db
    .select()
    .from(externalIdentities)
    .where(
      and(
        eq(externalIdentities.providerId, provider.id),
        eq(externalIdentities.subject, profile.subject),
      ),
    );
  for (const alt of profile.altSubjects ?? []) {
    if (existingLink) break;
    [existingLink] = await db
      .select()
      .from(externalIdentities)
      .where(
        and(eq(externalIdentities.providerId, provider.id), eq(externalIdentities.subject, alt)),
      );
  }
  let found = existingLink?.userId ?? null;

  if (!found) {
    if (!email) throw new AppError('sso_login_failed', { reason: 'no_email' });
    const byEmail = await findUserByEmail(db, email);
    if (byEmail) {
      if (!provider.linkExistingByEmail) throw new AppError('sso_email_conflict');
      if (!profile.emailVerified) throw new AppError('sso_email_unverified');
      found = byEmail.id;
      // The same person under a new id in the same directory (entry re-created): keep the link row.
      const [prior] = await db
        .select()
        .from(externalIdentities)
        .where(
          and(eq(externalIdentities.providerId, provider.id), eq(externalIdentities.userId, found)),
        );
      if (prior) existingLink = prior;
      else linked = true;
    } else {
      if (!provider.jitProvisioning) throw new AppError('sso_account_not_linked');
      if (!profile.emailVerified) throw new AppError('sso_email_unverified');
      const user = await createUser(
        create,
        provider,
        { ...profile, email },
        org.settings.defaultLocale,
      );
      found = user.id;
      created = true;
    }
  }

  const userId: string = found;
  const roles = resolveRoles(mappingsOf(provider), profile.groups);
  const result = await db.transaction(async (tx) => {
    const [member] = await tx
      .select()
      .from(orgMembers)
      .where(and(eq(orgMembers.organizationId, org.id), eq(orgMembers.userId, userId)));
    let memberRow: typeof orgMembers.$inferSelect | null = member ?? null;
    if (memberRow?.status === 'suspended') {
      // Reactivate only what the directory sync suspended; an admin's suspension stands.
      if (existingLink?.suspendedBySync) {
        memberRow =
          (
            await tx
              .update(orgMembers)
              .set({ status: 'active' })
              .where(eq(orgMembers.id, memberRow.id))
              .returning()
          )[0] ?? null;
        await identityAudit(
          tx,
          {
            orgId: org.id,
            actorId: null,
            action: 'identity.user.reactivate',
            targetType: 'user',
            targetId: userId,
            meta: { provider: provider.id, via: 'sign_in' },
          },
          req,
        );
      } else {
        throw new AppError('sso_access_denied');
      }
    }
    if (!memberRow || memberRow.status === 'invited') {
      if (!provider.jitProvisioning && !memberRow) throw new AppError('sso_access_denied');
      const role = roles.orgRole ?? provider.defaultRole;
      if (memberRow) {
        memberRow =
          (
            await tx
              .update(orgMembers)
              .set({ status: 'active', joinedAt: new Date() })
              .where(eq(orgMembers.id, memberRow.id))
              .returning()
          )[0] ?? null;
      } else {
        memberRow =
          (
            await tx
              .insert(orgMembers)
              .values({
                organizationId: org.id,
                userId,
                role,
                status: 'active',
                joinedAt: new Date(),
              })
              .returning()
          )[0] ?? null;
      }
      if (!memberRow) throw new AppError('internal');
      const [user] = await tx.select().from(users).where(eq(users.id, userId));
      if (memberRow.role !== 'guest' && user) {
        await ensurePersonalSpace(tx, org.id, user);
        await joinSpaces(
          tx,
          org.id,
          userId,
          await defaultSpaceIds(tx, org.id),
          INVITED_SPACE_ROLE,
          userId,
        );
      }
      await identityAudit(
        tx,
        {
          orgId: org.id,
          actorId: userId,
          action: 'identity.user.provision',
          targetType: 'user',
          targetId: userId,
          meta: {
            provider: provider.id,
            kind: provider.kind,
            role: memberRow.role,
            created,
            ...(opts.scim ? { via: 'scim' } : {}),
          },
        },
        req,
      );
      await applyRoles(tx, provider, userId, roles, memberRow, req);
    } else if (provider.syncRoles) {
      await applyRoles(tx, provider, userId, roles, memberRow, req);
    }

    const values = {
      email,
      dn: profile.dn ?? null,
      groups: profile.groups,
      directoryStatus: 'active' as const,
      suspendedBySync: false,
      ...(opts.scim ? {} : { lastLoginAt: new Date() }),
    };
    let externalId: string;
    if (existingLink) {
      await tx
        .update(externalIdentities)
        .set({ ...values, subject: profile.subject })
        .where(eq(externalIdentities.id, existingLink.id));
      externalId = existingLink.id;
    } else {
      const [row] = await tx
        .insert(externalIdentities)
        .values({
          orgId: org.id,
          providerId: provider.id,
          userId,
          subject: profile.subject,
          ...values,
        })
        .onConflictDoUpdate({
          target: [externalIdentities.providerId, externalIdentities.userId],
          set: { subject: profile.subject, ...values },
        })
        .returning({ id: externalIdentities.id });
      externalId = row!.id;
      if (linked) {
        await identityAudit(
          tx,
          {
            orgId: org.id,
            actorId: userId,
            action: 'identity.user.link',
            targetType: 'user',
            targetId: userId,
            meta: { provider: provider.id, subject: profile.subject },
          },
          req,
        );
      }
    }
    // The IdP is the source of the display name.
    if (profile.name?.trim()) {
      await tx
        .update(users)
        .set({ name: profile.name.trim() })
        .where(and(eq(users.id, userId), sql`${users.name} <> ${profile.name.trim()}`));
    }
    return { externalId };
  });

  return { userId, orgId: org.id, created, linked, externalId: result.externalId };
}
