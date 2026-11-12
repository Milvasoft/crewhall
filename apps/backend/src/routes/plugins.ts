import { eq } from 'drizzle-orm';
import { users } from '@crewhall/db';
import {
  JWKS_PATH,
  OFFLINE_TOKEN_PATH,
  NOTIFICATIONS_CLEAR_PATH,
  NOTIFICATIONS_PATH,
} from '@crewhall/plugin-sdk/server';
import { can, CLIENT_HEADER, parseClientHeader } from '@crewhall/shared';
import { AppError } from '../http/errors';
import type { Router } from '../http/route';
import type { OrgCtx } from '../http/types';
import { orgContext } from '../services/membership';
import { runPluginCommand } from '../services/plugins/commands';
import {
  catalogFor,
  installPlugin,
  listInstallations,
  loadInstallation,
  lookupPlugin,
  updateInstallation,
  surfaces,
  uninstallPlugin,
  upgradePlugin,
} from '../services/plugins/installations';
import {
  clearPluginNotifications,
  createPluginNotification,
  linkUser,
  listPluginNotificationPrefs,
  personalSurfaces,
  updatePluginNotificationPref,
} from '../services/plugins/notify';
import { createOfflineToken, offlineGrant, setOfflineGrant } from '../services/plugins/offline';
import { issueSessionToken, jwks } from '../services/plugins/tokens';

function requireAdmin(ctx: Pick<OrgCtx<never>, 'actor' | 'org'>) {
  if (!can(ctx.actor, 'org.update_settings', { type: 'org', org: orgContext(ctx.org) })) {
    throw new AppError('forbidden');
  }
}

/** Plugins (docs/contracts/eklentiler.md). */
export function registerPlugins(r: Router): void {
  // ---- Yönetim › Eklentiler ----
  r.org('listPluginCatalog', async (ctx) => {
    requireAdmin(ctx);
    return { items: await catalogFor(ctx.deps, ctx.org, ctx.query.q) };
  });
  r.org('lookupPlugin', (ctx) => {
    requireAdmin(ctx);
    return lookupPlugin(ctx.deps, ctx.org, ctx.query.ref);
  });
  r.org('listPluginInstallations', async (ctx) => {
    requireAdmin(ctx);
    return { items: await listInstallations(ctx.deps, ctx.org) };
  });
  r.org(
    'installPlugin',
    (ctx) => {
      requireAdmin(ctx);
      return installPlugin(ctx.deps, ctx.org, ctx.body, ctx.user.id, ctx.req);
    },
    { status: 201 },
  );
  r.org('updatePluginInstallation', (ctx) => {
    requireAdmin(ctx);
    return updateInstallation(
      ctx.deps,
      ctx.org,
      ctx.params.installationId,
      ctx.body,
      ctx.user.id,
      ctx.req,
    );
  });
  r.org('upgradePlugin', (ctx) => {
    requireAdmin(ctx);
    return upgradePlugin(
      ctx.deps,
      ctx.org,
      ctx.params.installationId,
      ctx.body,
      ctx.user.id,
      ctx.req,
    );
  });
  r.org('uninstallPlugin', async (ctx) => {
    requireAdmin(ctx);
    await uninstallPlugin(ctx.deps, ctx.org, ctx.params.installationId, ctx.user.id, ctx.req);
    return {};
  });

  // ---- People ----
  r.org('listPluginSurfaces', async (ctx) => {
    // Guests see no plugins: a plugin acts with a member's permissions.
    if (ctx.actor.orgRole === 'guest') return { items: [] };
    const personal = await personalSurfaces(ctx.deps.db, ctx.org.id, ctx.user.id);
    const platform = parseClientHeader(ctx.c.req.header(CLIENT_HEADER))?.platform;
    const mobile = platform === 'ios' || platform === 'android';
    const items = (await surfaces(ctx.deps.db, ctx.org.id)).map((s) => ({
      ...s,
      hiddenOnMobile: personal.get(s.installationId)?.showMobile === false,
      pinnedTabs: personal.get(s.installationId)?.pinnedTabs ?? [],
    }));
    // The mobile apps simply do not get plugins the person turned off there.
    return { items: mobile ? items.filter((s) => !s.hiddenOnMobile) : items };
  });
  r.org('createPluginSessionToken', async (ctx) => {
    if (ctx.actor.orgRole === 'guest') throw new AppError('forbidden', { reason: 'guest' });
    const row = await loadInstallation(ctx.deps.db, ctx.org.id, ctx.params.installationId);
    if (!row.enabled) throw new AppError('plugin_disabled');
    const [user] = await ctx.deps.db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, ctx.user.id));
    // From now on the installation may notify this person (if it has notifications:write).
    await linkUser(ctx.deps.db, row, ctx.user.id);
    return issueSessionToken(ctx.deps.db, ctx.deps.env, {
      orgId: ctx.org.id,
      installationId: row.id,
      pluginId: row.pluginId,
      user: user!,
      scopes: row.permissions,
    });
  });
  r.org('getPluginOfflineGrant', (ctx) =>
    offlineGrant(ctx.deps.db, ctx.org.id, ctx.params.installationId, ctx.user.id),
  );
  r.org('grantPluginOffline', (ctx) => {
    if (ctx.actor.orgRole === 'guest') throw new AppError('forbidden', { reason: 'guest' });
    return setOfflineGrant(
      ctx.deps,
      ctx.org.id,
      ctx.params.installationId,
      ctx.user.id,
      true,
      ctx.req,
    );
  });
  r.org('revokePluginOffline', (ctx) =>
    setOfflineGrant(ctx.deps, ctx.org.id, ctx.params.installationId, ctx.user.id, false, ctx.req),
  );
  r.org('listPluginNotificationPrefs', async (ctx) => ({
    items: await listPluginNotificationPrefs(ctx.deps.db, ctx.org.id, ctx.user.id),
  }));
  r.org('updatePluginNotificationPref', (ctx) =>
    updatePluginNotificationPref(
      ctx.deps.db,
      ctx.org.id,
      ctx.user.id,
      ctx.params.installationId,
      ctx.body,
    ),
  );
  r.org('runPluginCommand', (ctx) =>
    runPluginCommand(
      ctx.deps,
      { org: ctx.org, actor: ctx.actor, userId: ctx.user.id },
      ctx.params.conversationId,
      ctx.body,
      ctx.req,
    ),
  );

  // ---- Plugin servers ----
  // createPluginNotification: the plugin server as the installation, signed with its secret.
  r.rawPublic('POST', NOTIFICATIONS_PATH, async ({ c, deps }) =>
    c.json(await createPluginNotification(deps, c), 201),
  );
  r.rawPublic('POST', NOTIFICATIONS_CLEAR_PATH, async ({ c, deps }) =>
    c.json(await clearPluginNotifications(deps, c)),
  );
  r.rawPublic('POST', OFFLINE_TOKEN_PATH, async ({ c, deps }) =>
    c.json(await createOfflineToken(deps, c)),
  );
  r.rawPublic('GET', JWKS_PATH, async ({ c, deps }) => {
    c.header('Cache-Control', 'public, max-age=300');
    return c.json(await jwks(deps.db));
  });
}
