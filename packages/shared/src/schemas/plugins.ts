import { z } from 'zod';
import {
  CatalogEntry,
  LocalizedText,
  PluginBrowserCapability,
  PluginCard,
  PluginHosting,
  PluginCommand,
  PluginPermission,
  PluginTab,
  RiskLevel,
} from '@crewhall/plugin-sdk';
import { Id, Timestamp } from './common';
import { UserSummary } from './org';

/**
 * Plugins (docs/contracts/eklentiler.md): installed from the central marketplace as signed
 * manifests. Crewhall never runs plugin code; tabs and cards are sandboxed iframes on the
 * plugin's own origin, commands, tools and events are signed requests to its server.
 */

export const PluginStatus = z.enum(['active', 'disabled']);

export const PluginInstallation = z.object({
  id: Id,
  pluginId: z.string(),
  version: z.string(),
  name: LocalizedText,
  description: LocalizedText,
  publisher: z.object({ name: z.string(), url: z.string().optional() }),
  /** Absolute URL on the plugin origin, or null. */
  icon: z.string().nullable(),
  /** Where its tabs, cards and requests go: the admin's own origin for a self-hosted plugin. */
  origin: z.string(),
  /** API 30: `self` when the org runs its own copy at `selfOrigin`. */
  hosting: PluginHosting.optional(),
  selfOrigin: z.string().nullable().optional(),
  risk: RiskLevel,
  riskNote: LocalizedText.nullable(),
  /** What the admin approved; a person's token never gets more than they have themselves. */
  permissions: z.array(PluginPermission),
  /** API 26: what the installed version asks for; the rest of it was not granted. */
  requestedPermissions: z.array(PluginPermission).optional(),
  /** API 32: browser features granted to its frames, and what the version asks for. */
  browser: z.array(PluginBrowserCapability).optional(),
  requestedBrowser: z.array(PluginBrowserCapability).optional(),
  status: PluginStatus,
  entryPoints: z.object({
    tabs: z.array(PluginTab),
    cards: z.array(PluginCard),
    commands: z.array(PluginCommand),
    tools: z.array(z.object({ name: z.string(), description: z.string(), write: z.boolean() })),
    events: z.array(z.object({ type: z.string() })),
  }),
  /** A newer approved version in the catalog (null when none or the catalog is unreachable). */
  update: z
    .object({
      version: z.string(),
      /** Permissions the update newly asks for: it waits for the admin to decide on them. */
      addedPermissions: z.array(PluginPermission),
      /** API 32: browser features it newly asks for (asked again like permissions). */
      addedBrowser: z.array(PluginBrowserCapability).optional(),
    })
    .nullable(),
  installedBy: UserSummary.nullable(),
  installedAt: Timestamp,
  updatedAt: Timestamp,
});
export type PluginInstallation = z.infer<typeof PluginInstallation>;

export const PluginCatalogItem = CatalogEntry.extend({
  /** Installed here, and in which version. */
  installedVersion: z.string().nullable(),
  installationId: Id.nullable(),
});
export type PluginCatalogItem = z.infer<typeof PluginCatalogItem>;

export const PluginCatalogQuery = z.object({ q: z.string().trim().max(100).optional() });

/**
 * API 30: one listing by its plugin id (`com.acme.tool`) or the marketplace's install link
 * (`https://market…/p/com.acme.tool`); unlisted plugins are found only this way.
 */
export const PluginLookupQuery = z.object({ ref: z.string().trim().min(3).max(500) });

export const InstallPlugin = z.object({
  pluginId: z.string().max(100),
  version: z.string().max(64),
  /**
   * The admin's approval: any subset of the manifest's permissions (API 26; before, all of
   * them). The plugin learns what was granted in the install request and in session tokens.
   */
  permissions: z.array(PluginPermission),
  /**
   * API 30, self-hosted plugins only (`hosting: 'self'`): the org's own https origin. Crewhall
   * reads `<origin>/.well-known/crewhall-plugin.json` and installs only when it is the signed
   * manifest with this origin.
   */
  selfOrigin: z.string().trim().max(255).optional(),
  /**
   * API 32: the browser features granted, any subset of what the manifest asks for. Left out
   * grants none.
   */
  browser: z.array(PluginBrowserCapability).optional(),
});
export type InstallPlugin = z.infer<typeof InstallPlugin>;

export const UpdatePluginInstallation = z.object({
  enabled: z.boolean().optional(),
  /** API 26: change the grant, a subset of what the installed version asks for. */
  permissions: z.array(PluginPermission).optional(),
  /** API 32: change the browser features granted, likewise. */
  browser: z.array(PluginBrowserCapability).optional(),
});

export const UpgradePlugin = z.object({
  version: z.string().max(64),
  /**
   * Which of the permissions the version newly asks for are granted (any subset, `[]` grants
   * none). Required when it asks for new ones (`plugin_permissions_changed` lists them).
   */
  acceptPermissions: z.array(PluginPermission).optional(),
  /** API 32: likewise for newly asked browser features (`addedBrowser`). */
  acceptBrowser: z.array(PluginBrowserCapability).optional(),
});
export type UpgradePlugin = z.infer<typeof UpgradePlugin>;

/** What people see of the org's active plugins: their tabs, cards and commands. */
export const PluginSurface = z.object({
  installationId: Id,
  pluginId: z.string(),
  name: LocalizedText,
  icon: z.string().nullable(),
  origin: z.string(),
  risk: RiskLevel,
  tabs: z.array(PluginTab),
  cards: z.array(PluginCard),
  commands: z.array(PluginCommand),
  /** API 26: what the installation was granted (the bridge context carries it too). */
  permissions: z.array(PluginPermission).optional(),
  /**
   * API 32: browser features delegated to its frames, for `origin` only (web: the iframe
   * `allow`; mobile: the WebView's media and location prompts). Missing means none.
   */
  browser: z.array(PluginBrowserCapability).optional(),
  /**
   * API 33: the person turned the plugin off for the mobile app. The mobile apps (by their
   * X-Crewhall-Client header) do not get such plugins at all; others see the flag.
   */
  hiddenOnMobile: z.boolean().optional(),
  /**
   * API 42: tabs the person pinned to the left rail (web, desktop), whatever their placement.
   * They open at `/plugins/<installationId>/<tabId>`; a chat tab also stays in the chat sidebar.
   */
  pinnedTabs: z.array(z.string()).optional(),
});
export type PluginSurface = z.infer<typeof PluginSurface>;

export const PluginSessionToken = z.object({ token: z.string(), expiresAt: Timestamp });

/** API 50: may this plugin work for me while nobody has it open? */
export const PluginOfflineGrant = z.object({
  /** The admin gave the installation `offline:access`. */
  available: z.boolean(),
  granted: z.boolean(),
  grantedAt: Timestamp.nullable(),
});
export type PluginOfflineGrant = z.infer<typeof PluginOfflineGrant>;

/**
 * API 31, a person's say over one plugin's notifications (Bildirim ayarları › Eklentiler):
 * `on` everywhere, `muted` in the bell only (no push or desktop), `off` not at all.
 */
export const PluginNotificationMode = z.enum(['on', 'muted', 'off']);
export type PluginNotificationMode = z.infer<typeof PluginNotificationMode>;

/**
 * API 33, where a plugin's notifications reach the person: the bell (and with it the
 * notification centre), the OS notification on the desktop (Notification.desktop), the phone's
 * push. Today the desktop notification comes from the bell's live event, so it needs the bell.
 */
export const PluginNotificationChannels = z.object({
  bell: z.boolean(),
  desktop: z.boolean(),
  push: z.boolean(),
});
export type PluginNotificationChannels = z.infer<typeof PluginNotificationChannels>;

/**
 * A person's settings for one plugin (Bildirim ayarları › Eklentiler). API 31 listed only the
 * plugins that may notify them; since API 33 every active plugin they see is listed, with
 * `canNotify` saying whether the channels apply.
 */
export const PluginNotificationPref = z.object({
  installationId: Id,
  pluginId: z.string(),
  name: LocalizedText,
  icon: z.string().nullable(),
  /**
   * API 31 summary of `channels` for older clients: `on` (push or desktop on), `muted` (bell
   * only), `off` (nothing).
   */
  mode: PluginNotificationMode,
  /** API 33. */
  channels: PluginNotificationChannels.optional(),
  /** API 33: its tabs, cards and commands in the mobile app (as the manifest allows). */
  showOnMobile: z.boolean().optional(),
  /** API 33: it has `notifications:write` and the person opened it. */
  canNotify: z.boolean().optional(),
  /** API 42: its tabs this person also wants in the left rail (tab ids; none by default). */
  pinnedTabs: z.array(z.string()).optional(),
});
export type PluginNotificationPref = z.infer<typeof PluginNotificationPref>;

/** `mode` (API 31) sets all channels at once; `channels` (API 33) one by one. */
export const UpdatePluginNotificationPref = z
  .object({
    mode: PluginNotificationMode.optional(),
    channels: PluginNotificationChannels.partial().optional(),
    showOnMobile: z.boolean().optional(),
    /** API 42: replaces the pinned tabs; ids of this plugin's tabs. */
    pinnedTabs: z.array(z.string().max(32)).max(8).optional(),
  })
  .refine(
    (v) =>
      v.mode !== undefined ||
      v.channels !== undefined ||
      v.showOnMobile !== undefined ||
      v.pinnedTabs !== undefined,
    { message: 'nothing to change' },
  );
export type UpdatePluginNotificationPref = z.infer<typeof UpdatePluginNotificationPref>;

export const RunPluginCommand = z.object({
  installationId: Id,
  command: z.string().max(32),
  args: z.string().max(4000).default(''),
});

export const PluginCommandResult = z.object({
  /** A note only the caller sees. */
  reply: z.string().nullable(),
  /** Id of the message the plugin posted for the caller (marked "<plugin> ile"). */
  messageId: Id.nullable(),
});
