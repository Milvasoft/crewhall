import { and, asc, eq } from 'drizzle-orm';
import { externalIdentities, identityProviders, orgMembers, sessions, users } from '@crewhall/db';
import type { IdpSyncSummary, LdapConfig } from '@crewhall/shared';
import type { BaseDeps, Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { RequestInfo } from '../../http/types';
import { identityAudit } from './audit';
import { findUser, listUsers, verifyPassword, withServiceBind, type DirectoryUser } from './ldap';
import { applyRoles, provisionUser, resolveRoles, type UserCreator } from './provision';
import { configOf, domainOf, mappingsOf, secretOf, type ProviderRow } from './providers';

type LdapRow = ProviderRow & { kind: 'ldap' };

/** What directory access needs; the worker's job deps qualify. */
export type DirectoryDeps = Pick<BaseDeps, 'db' | 'env' | 'logger'>;

export async function enabledDirectories(deps: Pick<BaseDeps, 'db'>, orgId?: string) {
  const rows = await deps.db
    .select()
    .from(identityProviders)
    .where(
      and(
        eq(identityProviders.kind, 'ldap'),
        eq(identityProviders.enabled, true),
        ...(orgId ? [eq(identityProviders.orgId, orgId)] : []),
      ),
    )
    .orderBy(asc(identityProviders.position), asc(identityProviders.createdAt));
  return rows as LdapRow[];
}

export type DirectoryLookup =
  { status: 'found'; provider: LdapRow; user: DirectoryUser } | { status: 'not_found' };

/**
 * Finds the person in the enabled directories. A typed e-mail whose domain is mapped to a
 * directory goes there first. Throws idp_unavailable only when no directory could be asked.
 */
export async function lookupDirectoryUser(
  deps: DirectoryDeps,
  username: string,
): Promise<DirectoryLookup> {
  const all = await enabledDirectories(deps);
  if (!all.length) throw new AppError('ldap_disabled');
  const domain = username.includes('@') ? domainOf(username) : null;
  const ordered = domain
    ? [
        ...all.filter((p) => p.domains.includes(domain)),
        ...all.filter((p) => !p.domains.includes(domain)),
      ]
    : all;
  let reached = 0;
  for (const provider of ordered) {
    const config = configOf(provider);
    try {
      const user = await withServiceBind(config, secretOf(deps.env, provider), (c) =>
        findUser(c, config, username),
      );
      reached++;
      if (user) return { status: 'found', provider, user };
    } catch (err) {
      deps.logger.warn({ err, provider: provider.id }, 'directory lookup failed');
    }
  }
  if (!reached) throw new AppError('idp_unavailable');
  return { status: 'not_found' };
}

export async function checkDirectoryPassword(
  deps: DirectoryDeps,
  provider: LdapRow,
  dn: string,
  password: string,
) {
  try {
    return await verifyPassword(configOf(provider), dn, password);
  } catch (err) {
    deps.logger.warn({ err, provider: provider.id }, 'directory bind failed');
    throw new AppError('idp_unavailable');
  }
}

/** Directory entry → Crewhall account (JIT, link, role mapping). */
export async function provisionDirectoryUser(
  deps: Pick<Deps, 'db'>,
  create: UserCreator,
  provider: LdapRow,
  user: DirectoryUser,
  req: RequestInfo | null,
) {
  if (user.disabled) throw new AppError('sso_access_denied');
  return provisionUser(
    deps,
    create,
    provider,
    {
      subject: user.uid,
      email: user.email,
      // The directory is the organization's own source of truth for addresses.
      emailVerified: true,
      name: user.name,
      groups: user.groups,
      dn: user.dn,
    },
    req,
  );
}

/**
 * Directory sync (worker, hourly; or "Şimdi senkronize et"): people removed from or disabled
 * in the directory are suspended, those the sync suspended come back when active again,
 * groups and mapped roles are refreshed. Owners are never suspended by a sync.
 */
export async function syncDirectory(
  deps: DirectoryDeps,
  provider: LdapRow,
  actorId: string | null,
): Promise<IdpSyncSummary> {
  const config: LdapConfig = configOf(provider);
  const summary: IdpSyncSummary = { checked: 0, updated: 0, suspended: 0, reactivated: 0 };
  let entries: DirectoryUser[];
  try {
    entries = await withServiceBind(config, secretOf(deps.env, provider), (c) =>
      listUsers(c, config),
    );
  } catch (err) {
    await deps.db
      .update(identityProviders)
      .set({
        lastSyncAt: new Date(),
        lastSyncOk: false,
        lastError: err instanceof Error ? err.message.slice(0, 500) : String(err),
      })
      .where(eq(identityProviders.id, provider.id));
    throw new AppError('idp_unavailable');
  }
  const byUid = new Map(entries.map((e) => [e.uid, e]));
  const linked = await deps.db
    .select({ ext: externalIdentities, member: orgMembers })
    .from(externalIdentities)
    .leftJoin(
      orgMembers,
      and(
        eq(orgMembers.userId, externalIdentities.userId),
        eq(orgMembers.organizationId, provider.orgId),
      ),
    )
    .where(eq(externalIdentities.providerId, provider.id));
  const mappings = mappingsOf(provider);

  for (const { ext, member } of linked) {
    summary.checked++;
    const entry = byUid.get(ext.subject);
    const status = !entry ? 'missing' : entry.disabled ? 'disabled' : 'active';
    if (status !== 'active') {
      if (member && member.status === 'active' && member.role !== 'owner') {
        await deps.db.transaction(async (tx) => {
          await tx
            .update(orgMembers)
            .set({ status: 'suspended' })
            .where(eq(orgMembers.id, member.id));
          await tx
            .update(externalIdentities)
            .set({ directoryStatus: status, suspendedBySync: true })
            .where(eq(externalIdentities.id, ext.id));
          // Signed-in devices lose access at once.
          await tx
            .delete(sessions)
            .where(
              and(
                eq(sessions.userId, ext.userId),
                eq(sessions.activeOrganizationId, provider.orgId),
              ),
            );
          await identityAudit(tx, {
            orgId: provider.orgId,
            actorId,
            action: 'identity.user.suspend',
            targetType: 'user',
            targetId: ext.userId,
            meta: { provider: provider.id, reason: status },
          });
        });
        summary.suspended++;
      } else if (ext.directoryStatus !== status) {
        await deps.db
          .update(externalIdentities)
          .set({ directoryStatus: status })
          .where(eq(externalIdentities.id, ext.id));
      }
      continue;
    }
    if (member?.status === 'suspended' && ext.suspendedBySync) {
      await deps.db.transaction(async (tx) => {
        await tx.update(orgMembers).set({ status: 'active' }).where(eq(orgMembers.id, member.id));
        await identityAudit(tx, {
          orgId: provider.orgId,
          actorId,
          action: 'identity.user.reactivate',
          targetType: 'user',
          targetId: ext.userId,
          meta: { provider: provider.id, via: 'sync' },
        });
      });
      summary.reactivated++;
    }
    const groupsChanged = entry!.groups.join('\n') !== ext.groups.join('\n');
    await deps.db
      .update(externalIdentities)
      .set({
        directoryStatus: 'active',
        suspendedBySync: false,
        groups: entry!.groups,
        dn: entry!.dn,
        email: entry!.email,
      })
      .where(eq(externalIdentities.id, ext.id));
    if (entry!.name) {
      await deps.db.update(users).set({ name: entry!.name }).where(eq(users.id, ext.userId));
    }
    if (groupsChanged && provider.syncRoles && mappings.length && member) {
      const roles = resolveRoles(mappings, entry!.groups);
      await applyRoles(deps.db, provider, ext.userId, roles, member, null);
      summary.updated++;
    }
  }

  await deps.db
    .update(identityProviders)
    .set({ lastSyncAt: new Date(), lastSyncOk: true, lastSync: summary, lastError: null })
    .where(eq(identityProviders.id, provider.id));
  await identityAudit(deps.db, {
    orgId: provider.orgId,
    actorId,
    action: 'identity.provider.sync',
    targetType: 'identity_provider',
    targetId: provider.id,
    meta: { ...summary },
  });
  return summary;
}

/** Worker job: every enabled directory with sync on. */
export async function syncAllDirectories(deps: DirectoryDeps) {
  const rows = (await enabledDirectories(deps)).filter((p) => p.syncEnabled);
  for (const provider of rows) {
    try {
      await syncDirectory(deps, provider, null);
    } catch (err) {
      deps.logger.warn({ err, provider: provider.id }, 'directory sync failed');
    }
  }
  return rows.length;
}
