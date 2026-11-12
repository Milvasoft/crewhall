import { Empty, def, items } from '../endpoint-def';
import {
  InstallPlugin,
  PluginCatalogItem,
  PluginCatalogQuery,
  PluginCommandResult,
  PluginInstallation,
  PluginLookupQuery,
  PluginNotificationPref,
  PluginOfflineGrant,
  PluginSessionToken,
  PluginSurface,
  RunPluginCommand,
  UpdatePluginInstallation,
  UpdatePluginNotificationPref,
  UpgradePlugin,
} from '../schemas/plugins';

/**
 * Plugins (docs/contracts/eklentiler.md). The marketplace protocol and the plugin-server calls
 * (lifecycle, commands, tools, events) are not part of this client contract.
 */
export const pluginsEndpoints = {
  // ---- Yönetim › Eklentiler (org owner and admins) ----
  /** The marketplace catalog for this installation, with what is installed here. */
  listPluginCatalog: def({
    method: 'GET',
    path: '/api/v1/plugins/catalog',
    auth: 'session',
    query: PluginCatalogQuery,
    response: items(PluginCatalogItem),
  }),
  /** API 30: one listing by id or install link, unlisted ones included. */
  lookupPlugin: def({
    method: 'GET',
    path: '/api/v1/plugins/catalog/lookup',
    auth: 'session',
    query: PluginLookupQuery,
    response: PluginCatalogItem,
  }),
  listPluginInstallations: def({
    method: 'GET',
    path: '/api/v1/plugins/installations',
    auth: 'session',
    response: items(PluginInstallation),
  }),
  /** Fetches and verifies the signed package, tells the plugin server, stores the approval. */
  installPlugin: def({
    method: 'POST',
    path: '/api/v1/plugins/installations',
    auth: 'session',
    body: InstallPlugin,
    response: PluginInstallation,
  }),
  updatePluginInstallation: def({
    method: 'PATCH',
    path: '/api/v1/plugins/installations/:installationId',
    auth: 'session',
    body: UpdatePluginInstallation,
    response: PluginInstallation,
  }),
  /** To a newer signed version; new permissions need `acceptPermissions`. */
  upgradePlugin: def({
    method: 'POST',
    path: '/api/v1/plugins/installations/:installationId/upgrade',
    auth: 'session',
    body: UpgradePlugin,
    response: PluginInstallation,
  }),
  uninstallPlugin: def({
    method: 'DELETE',
    path: '/api/v1/plugins/installations/:installationId',
    auth: 'session',
    response: Empty,
  }),

  // ---- People ----
  /** Tabs, cards and commands of the org's active plugins. */
  listPluginSurfaces: def({
    method: 'GET',
    path: '/api/v1/plugins/surfaces',
    auth: 'session',
    response: items(PluginSurface),
  }),
  /** A 5-minute session token for a plugin frame (the bridge's `token` request). */
  createPluginSessionToken: def({
    method: 'POST',
    path: '/api/v1/plugins/installations/:installationId/token',
    auth: 'session',
    response: PluginSessionToken,
  }),
  /** API 50: background access, a person's own say. Never open to tokens. */
  getPluginOfflineGrant: def({
    method: 'GET',
    path: '/api/v1/plugins/installations/:installationId/offline',
    auth: 'session',
    response: PluginOfflineGrant,
  }),
  grantPluginOffline: def({
    method: 'PUT',
    path: '/api/v1/plugins/installations/:installationId/offline',
    auth: 'session',
    response: PluginOfflineGrant,
  }),
  revokePluginOffline: def({
    method: 'DELETE',
    path: '/api/v1/plugins/installations/:installationId/offline',
    auth: 'session',
    response: PluginOfflineGrant,
  }),
  /** API 31: the plugins that may notify me, and how (Bildirim ayarları › Eklentiler). */
  listPluginNotificationPrefs: def({
    method: 'GET',
    path: '/api/v1/me/plugin-notification-prefs',
    auth: 'session',
    response: items(PluginNotificationPref),
  }),
  updatePluginNotificationPref: def({
    method: 'PATCH',
    path: '/api/v1/me/plugin-notification-prefs/:installationId',
    auth: 'session',
    body: UpdatePluginNotificationPref,
    response: PluginNotificationPref,
  }),
  /** `/command args` typed in a chat composer. */
  runPluginCommand: def({
    method: 'POST',
    path: '/api/v1/chat/conversations/:conversationId/plugin-commands',
    auth: 'session',
    body: RunPluginCommand,
    response: PluginCommandResult,
  }),
};
