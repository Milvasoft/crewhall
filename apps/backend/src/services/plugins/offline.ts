import { and, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { orgMembers, pluginOfflineGrants, users, type DbOrTx } from '@crewhall/db';
import { PluginOfflineTokenRequest } from '@crewhall/plugin-sdk/server';
import type { PluginOfflineGrant } from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { AppEnv, RequestInfo } from '../../http/types';
import { audit } from '../audit';
import { loadInstallation } from './installations';
import { limited, signedInstallation } from './notify';
import { issueSessionToken } from './tokens';

/**
 * Background access (docs/contracts/eklentiler.md › Arka planda çalışma). A plugin needs it to
 * bring in a change from another system while nobody has it open. Three locks: the admin gave
 * the installation `offline:access`, the person said yes in Crewhall's own dialog, and the
 * plugin server proves itself with the installation secret. The token is an ordinary 5-minute
 * session token: the person's rights, the installation's permissions, audited as `via: plugin`.
 */

const OFFLINE = 'offline:access';
/** Permissions that mean nothing to the REST API stay out of the token. */
const NOT_IN_TOKEN = new Set([OFFLINE, 'notifications:write']);
const TOKENS_PER_MINUTE = 120;
const UUID = /^[0-9a-f-]{36}$/i;

export async function offlineGrant(
  db: DbOrTx,
  orgId: string,
  installationId: string,
  userId: string,
): Promise<PluginOfflineGrant> {
  const row = await loadInstallation(db, orgId, installationId);
  const [grant] = await db
    .select({ grantedAt: pluginOfflineGrants.grantedAt })
    .from(pluginOfflineGrants)
    .where(
      and(
        eq(pluginOfflineGrants.installationId, installationId),
        eq(pluginOfflineGrants.userId, userId),
      ),
    );
  const available = row.enabled && row.permissions.includes(OFFLINE);
  return {
    available,
    granted: available && !!grant,
    grantedAt: available && grant ? grant.grantedAt.toISOString() : null,
  };
}

export async function setOfflineGrant(
  deps: Pick<Deps, 'db'>,
  orgId: string,
  installationId: string,
  userId: string,
  granted: boolean,
  req: RequestInfo,
): Promise<PluginOfflineGrant> {
  const row = await loadInstallation(deps.db, orgId, installationId);
  if (granted) {
    if (!row.enabled) throw new AppError('plugin_disabled');
    if (!row.permissions.includes(OFFLINE)) throw new AppError('plugin_offline_not_granted');
    await deps.db
      .insert(pluginOfflineGrants)
      .values({ installationId, userId, orgId })
      .onConflictDoNothing();
  } else {
    await deps.db
      .delete(pluginOfflineGrants)
      .where(
        and(
          eq(pluginOfflineGrants.installationId, installationId),
          eq(pluginOfflineGrants.userId, userId),
        ),
      );
  }
  await audit(
    deps.db,
    {
      orgId,
      actorId: userId,
      action: granted ? 'plugin.offline_grant' : 'plugin.offline_revoke',
      targetType: 'plugin_installation',
      targetId: installationId,
      meta: { pluginId: row.pluginId },
    },
    req,
  );
  return offlineGrant(deps.db, orgId, installationId, userId);
}

/** POST /api/plugins/v1/offline-token, from the plugin server as the installation. */
export async function createOfflineToken(deps: Deps, c: Context<AppEnv>) {
  const body = await c.req.text();
  const row = await signedInstallation(deps, c, body);
  if (!row.enabled) throw new AppError('plugin_disabled');
  if (!row.permissions.includes(OFFLINE)) throw new AppError('plugin_offline_not_granted');
  await limited(c, deps, row.id, 'plugin_offline', TOKENS_PER_MINUTE, row.orgId);
  const parsed = PluginOfflineTokenRequest.safeParse(JSON.parse(body || '{}'));
  if (!parsed.success) throw new AppError('validation_failed');
  const { userId } = parsed.data;
  if (!UUID.test(userId)) throw new AppError('plugin_offline_not_granted');
  const [hit] = await deps.db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      status: orgMembers.status,
      role: orgMembers.role,
    })
    .from(pluginOfflineGrants)
    .innerJoin(users, eq(users.id, pluginOfflineGrants.userId))
    .innerJoin(
      orgMembers,
      and(eq(orgMembers.organizationId, row.orgId), eq(orgMembers.userId, users.id)),
    )
    .where(
      and(eq(pluginOfflineGrants.installationId, row.id), eq(pluginOfflineGrants.userId, userId)),
    );
  // Someone who left, was deactivated or became a guest keeps no plugin acting for them.
  if (!hit || hit.status !== 'active' || hit.role === 'guest') {
    throw new AppError('plugin_offline_not_granted');
  }
  return issueSessionToken(deps.db, deps.env, {
    orgId: row.orgId,
    installationId: row.id,
    pluginId: row.pluginId,
    user: { id: hit.id, name: hit.name, email: hit.email },
    scopes: row.permissions.filter((p) => !NOT_IN_TOKEN.has(p)),
  });
}
