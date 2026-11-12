import { type PluginBrowserCapability, type PluginPermission } from '@crewhall/plugin-sdk';
import {
  type EndpointName,
  type PluginCatalogItem,
  type PluginInstallation,
  type PluginNotificationChannels,
  type PluginNotificationMode,
  type PluginNotificationPref,
} from '@crewhall/shared';
import { actorOf, MockApiError, requireUser, summary, type Resolvers } from './core';
import { db, newId } from './db';
import { type MockState } from './seed';

/**
 * Plugins part of the contract mock (docs/contracts/eklentiler.md): a small marketplace catalog
 * (one reviewed plugin, one unofficial) and the installations of the org.
 */

const HELLO_ORIGIN = 'https://hello.example.com';
const WA_ORIGIN = 'https://wa.example.com';

interface CatalogSeed extends Omit<PluginCatalogItem, 'installedVersion' | 'installationId'> {
  tabs: PluginInstallation['entryPoints']['tabs'];
  cards: PluginInstallation['entryPoints']['cards'];
  commands: PluginInstallation['entryPoints']['commands'];
}

const CATALOG: CatalogSeed[] = [
  {
    id: 'com.example.hello',
    version: '1.0.0',
    name: { tr: 'Merhaba', en: 'Hello' },
    description: {
      tr: 'Sekme, kart ve /hello komutu gösteren örnek eklenti',
      en: 'Sample plugin with a tab, a card and /hello',
    },
    publisher: { name: 'Crewhall' },
    homepage: null,
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23F38424'/%3E%3Ccircle cx='16' cy='16' r='7' fill='%23141516'/%3E%3C/svg%3E",
    origin: HELLO_ORIGIN,
    risk: 'official',
    riskNote: null,
    permissions: ['hub:read', 'chat:send', 'drive:write'],
    browser: [],
    entryPoints: { tabs: 1, cards: 1, commands: 1, tools: 1, events: 1 },
    restricted: false,
    hosting: 'hosted',
    visibility: 'public',
    updatedAt: '2026-10-28T10:00:00.000Z',
    tabs: [
      {
        id: 'main',
        title: { tr: 'Merhaba', en: 'Hello' },
        url: '/tab',
        placement: 'rail',
        mobile: true,
      },
    ],
    cards: [{ id: 'today', title: 'Bugün', url: '/card', size: 'm', mobile: true }],
    commands: [{ name: 'hello', description: 'Selam ver', url: '/commands/hello' }],
  },
  {
    id: 'com.example.whatsapp',
    version: '0.3.0',
    name: 'WhatsApp',
    description: {
      tr: 'WhatsApp sohbetleri Crewhall içinde',
      en: 'WhatsApp chats inside Crewhall',
    },
    publisher: { name: 'Milvasoft' },
    homepage: null,
    icon: null,
    origin: WA_ORIGIN,
    risk: 'unofficial',
    riskNote: {
      tr: "WhatsApp'ın resmî API'si değildir; WhatsApp şartlarına aykırı olabilir ve hesap kapatılabilir.",
      en: "Not WhatsApp's official API; it may break WhatsApp's terms and the account may be banned.",
    },
    permissions: ['hub:read', 'chat:send'],
    browser: [],
    entryPoints: { tabs: 1, cards: 0, commands: 0, tools: 0, events: 0 },
    restricted: false,
    hosting: 'hosted',
    visibility: 'public',
    updatedAt: '2026-10-27T10:00:00.000Z',
    tabs: [
      { id: 'chats', title: 'WhatsApp', url: '/', placement: 'chat', icon: 'chat', mobile: true },
    ],
    cards: [],
    commands: [],
  },
  {
    // Unlisted and self-hosted: found only by id or link, runs on the org's own server.
    id: 'com.example.wabridge',
    version: '1.0.0',
    name: 'WhatsApp köprüsü',
    description: {
      tr: 'Kurumun kendi sunucusundaki WhatsApp köprüsü',
      en: "WhatsApp bridge on the organization's own server",
    },
    publisher: { name: 'Milvasoft' },
    homepage: null,
    icon: null,
    origin: 'https://wa-bridge.example.com',
    risk: 'unofficial',
    riskNote: {
      tr: "WhatsApp'ın resmî API'si değildir; hesap kapatılabilir.",
      en: "Not WhatsApp's official API; the account may be banned.",
    },
    permissions: ['hub:read', 'chat:send', 'notifications:write'],
    browser: ['microphone', 'geolocation'],
    entryPoints: { tabs: 1, cards: 0, commands: 0, tools: 0, events: 0 },
    restricted: false,
    hosting: 'self',
    visibility: 'unlisted',
    updatedAt: '2026-10-30T10:00:00.000Z',
    tabs: [
      { id: 'chats', title: 'WhatsApp', url: '/', placement: 'chat', icon: 'chat', mobile: true },
    ],
    cards: [],
    commands: [],
  },
];

/** What a pasted id or install link names (the mock marketplace is market.crewhall.dev). */
function refOf(ref: string): string {
  const m = /^https:\/\/market\.crewhall\.dev\/(?:p|plugins|v1\/plugins)\/([^/]+)\/?$/.exec(ref);
  const id = (m ? decodeURIComponent(m[1]!) : ref).toLowerCase();
  if (!/^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/.test(id)) {
    throw new MockApiError('plugin_link_invalid');
  }
  return id;
}

const catalogItem = (
  s: MockState,
  { tabs: _t, cards: _c, commands: _m, ...entry }: CatalogSeed,
): PluginCatalogItem => {
  const i = pluginsState(s).installations.find((x) => x.pluginId === entry.id);
  return { ...entry, installedVersion: i ? entry.version : null, installationId: i?.id ?? null };
};

interface MockInstallation {
  id: string;
  pluginId: string;
  /** Installed version and what it asks for; older than the catalog means an update. */
  version: string;
  requested: PluginPermission[];
  /** What the admin granted. */
  permissions: PluginPermission[];
  /** Browser features granted to its frames. */
  browser?: PluginBrowserCapability[];
  enabled: boolean;
  installedBy: string;
  installedAt: string;
  /** Self-hosted: the org's own origin. */
  selfOrigin: string | null;
}

interface PluginsMockState {
  installations: MockInstallation[];
  commands: { installationId: string; command: string; args: string; conversationId: string }[];
  /** `<installationId>:<userId>`: people who opened the plugin, and their notification mode. */
  /** Plain JSON: the mock db is kept in localStorage in the browser. */
  linked: string[];
  prefs: Record<
    string,
    { channels: PluginNotificationChannels; showOnMobile: boolean; pinnedTabs?: string[] }
  >;
}

export function pluginsState(s: MockState = db()): PluginsMockState {
  const holder = s as MockState & { plugins?: PluginsMockState };
  holder.plugins ??= { installations: [], commands: [], linked: [], prefs: {} };
  // State saved before these fields existed.
  holder.plugins.linked ??= [];
  holder.plugins.prefs ??= {};
  return holder.plugins;
}

/** Self-hosted plugins need the org's https origin; hosted ones take none. */
function selfOriginOf(c: CatalogSeed, raw: string | undefined): string | null {
  if (c.hosting !== 'self') {
    if (raw) throw new MockApiError('plugin_self_origin_invalid');
    return null;
  }
  if (!raw) throw new MockApiError('plugin_self_origin_required');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MockApiError('plugin_self_origin_invalid');
  }
  if (url.protocol !== 'https:' || (url.pathname !== '/' && url.pathname !== '')) {
    throw new MockApiError('plugin_self_origin_invalid');
  }
  return url.origin;
}

const ALL_ON: PluginNotificationChannels = { bell: true, desktop: true, push: true };

/** The API 31 summary of the channels (same rule as the server). */
function modeOf(c: PluginNotificationChannels): PluginNotificationMode {
  if (!c.bell && !c.push) return 'off';
  return c.push || (c.bell && c.desktop) ? 'on' : 'muted';
}

/** Every active plugin the person sees, with their settings. */
function personPrefs(s: MockState, userId: string): PluginNotificationPref[] {
  const state = pluginsState(s);
  return state.installations
    .filter((i) => i.enabled)
    .map((i) => {
      const c = seedOf(i.pluginId);
      const p = state.prefs[`${i.id}:${userId}`];
      const channels = p?.channels ?? ALL_ON;
      return {
        installationId: i.id,
        pluginId: c.id,
        name: c.name,
        icon: c.icon,
        mode: modeOf(channels),
        channels,
        showOnMobile: p?.showOnMobile ?? true,
        pinnedTabs: p?.pinnedTabs ?? [],
        canNotify:
          state.linked.includes(`${i.id}:${userId}`) &&
          i.permissions.includes('notifications:write'),
      };
    });
}

const seedOf = (pluginId: string) => {
  const c = CATALOG.find((x) => x.id === pluginId);
  if (!c) throw new MockApiError('plugin_not_found');
  return c;
};

function requireAdmin(s: MockState) {
  const u = requireUser(s);
  const role = actorOf(s, u).orgRole;
  if (role !== 'owner' && role !== 'admin') throw new MockApiError('forbidden');
  return u;
}

/** The granted subset, in the order asked; anything not asked for is refused. */
function grantOf<P extends string>(requested: P[], granted: P[]) {
  if (granted.some((p) => !requested.includes(p))) {
    throw new MockApiError('plugin_permissions_mismatch');
  }
  return requested.filter((p) => granted.includes(p));
}

function view(s: MockState, i: MockInstallation): PluginInstallation {
  const c = seedOf(i.pluginId);
  const by = s.users.find((u) => u.id === i.installedBy);
  return {
    id: i.id,
    pluginId: c.id,
    version: i.version,
    name: c.name,
    description: c.description,
    publisher: c.publisher,
    icon: c.icon,
    origin: i.selfOrigin ?? c.origin,
    hosting: c.hosting,
    selfOrigin: i.selfOrigin,
    risk: c.risk,
    riskNote: c.riskNote,
    permissions: i.permissions,
    requestedPermissions: i.requested,
    browser: i.browser ?? [],
    requestedBrowser: c.browser,
    status: i.enabled ? 'active' : 'disabled',
    entryPoints: { tabs: c.tabs, cards: c.cards, commands: c.commands, tools: [], events: [] },
    update:
      i.version === c.version
        ? null
        : {
            version: c.version,
            addedPermissions: c.permissions.filter((p) => !i.requested.includes(p)),
          },
    installedBy: by ? summary(by) : null,
    installedAt: i.installedAt,
    updatedAt: i.installedAt,
  };
}

function installation(s: MockState, id: string) {
  const i = pluginsState(s).installations.find((x) => x.id === id);
  if (!i) throw new MockApiError('plugin_not_found');
  return i;
}

type PluginsName = Extract<
  EndpointName,
  | 'listPluginCatalog'
  | 'lookupPlugin'
  | 'listPluginInstallations'
  | 'installPlugin'
  | 'updatePluginInstallation'
  | 'upgradePlugin'
  | 'uninstallPlugin'
  | 'listPluginSurfaces'
  | 'createPluginSessionToken'
  | 'runPluginCommand'
  | 'listPluginNotificationPrefs'
  | 'updatePluginNotificationPref'
>;

export const pluginsResolvers: Resolvers<PluginsName> = {
  listPluginCatalog: ({ s, query }) => {
    requireAdmin(s);
    const q = query.q?.toLocaleLowerCase('tr');
    return {
      items: CATALOG.filter(
        (c) =>
          c.visibility === 'public' &&
          (!q || JSON.stringify([c.id, c.name, c.description]).toLocaleLowerCase('tr').includes(q)),
      ).map((c) => catalogItem(s, c)),
    };
  },
  lookupPlugin: ({ s, query }) => {
    requireAdmin(s);
    return catalogItem(s, seedOf(refOf(query.ref)));
  },
  listPluginInstallations: ({ s }) => {
    requireAdmin(s);
    return { items: pluginsState(s).installations.map((i) => view(s, i)) };
  },
  installPlugin: ({ s, body }) => {
    const u = requireAdmin(s);
    const c = seedOf(body.pluginId);
    const state = pluginsState(s);
    if (state.installations.some((i) => i.pluginId === c.id)) {
      throw new MockApiError('plugin_already_installed');
    }
    const i: MockInstallation = {
      id: newId(),
      pluginId: c.id,
      version: c.version,
      requested: c.permissions,
      permissions: grantOf(c.permissions, body.permissions),
      browser: grantOf(c.browser, body.browser ?? []),
      selfOrigin: selfOriginOf(c, body.selfOrigin),
      enabled: true,
      installedBy: u.id,
      installedAt: new Date().toISOString(),
    };
    state.installations.push(i);
    return view(s, i);
  },
  updatePluginInstallation: ({ s, params, body }) => {
    requireAdmin(s);
    const i = installation(s, params.installationId!);
    if (body.enabled !== undefined) i.enabled = body.enabled;
    if (body.permissions) i.permissions = grantOf(i.requested, body.permissions);
    if (body.browser) i.browser = grantOf(seedOf(i.pluginId).browser, body.browser);
    return view(s, i);
  },
  upgradePlugin: ({ s, params, body }) => {
    requireAdmin(s);
    const i = installation(s, params.installationId!);
    const c = seedOf(i.pluginId);
    const added = c.permissions.filter((p) => !i.requested.includes(p));
    if (added.length && body.acceptPermissions === undefined) {
      throw new MockApiError('plugin_permissions_changed');
    }
    const accepted = added.filter((p) => body.acceptPermissions?.includes(p));
    i.permissions = c.permissions.filter(
      (p) => accepted.includes(p) || (!added.includes(p) && i.permissions.includes(p)),
    );
    i.requested = c.permissions;
    i.version = c.version;
    return view(s, i);
  },
  uninstallPlugin: ({ s, params }) => {
    requireAdmin(s);
    installation(s, params.installationId!);
    const state = pluginsState(s);
    state.installations = state.installations.filter((i) => i.id !== params.installationId!);
    return {};
  },
  listPluginSurfaces: ({ s }) => {
    const u = requireUser(s);
    if (actorOf(s, u).orgRole === 'guest') return { items: [] };
    return {
      items: pluginsState(s)
        .installations.filter((i) => i.enabled)
        .map((i) => {
          const c = seedOf(i.pluginId);
          return {
            installationId: i.id,
            pluginId: c.id,
            name: c.name,
            icon: c.icon,
            origin: i.selfOrigin ?? c.origin,
            risk: c.risk,
            tabs: c.tabs,
            cards: c.cards,
            commands: c.commands,
            permissions: i.permissions,
            browser: i.browser ?? [],
            hiddenOnMobile: pluginsState(s).prefs[`${i.id}:${u.id}`]?.showOnMobile === false,
            pinnedTabs: pluginsState(s).prefs[`${i.id}:${u.id}`]?.pinnedTabs ?? [],
          };
        }),
    };
  },
  createPluginSessionToken: ({ s, params }) => {
    const u = requireUser(s);
    const i = installation(s, params.installationId!);
    if (!i.enabled) throw new MockApiError('plugin_disabled');
    const linked = pluginsState(s).linked;
    if (!linked.includes(`${i.id}:${u.id}`)) linked.push(`${i.id}:${u.id}`);
    return { token: `mock.${i.id}.token`, expiresAt: new Date(Date.now() + 300_000).toISOString() };
  },
  listPluginNotificationPrefs: ({ s }) => {
    const u = requireUser(s);
    return { items: personPrefs(s, u.id) };
  },
  updatePluginNotificationPref: ({ s, params, body }) => {
    const u = requireUser(s);
    const p = personPrefs(s, u.id).find((x) => x.installationId === params.installationId);
    if (!p) throw new MockApiError('plugin_not_found');
    const fromMode: Record<PluginNotificationMode, PluginNotificationChannels> = {
      on: ALL_ON,
      muted: { bell: true, desktop: false, push: false },
      off: { bell: false, desktop: false, push: false },
    };
    const channels = {
      ...(body.mode ? fromMode[body.mode] : p.channels!),
      ...Object.fromEntries(Object.entries(body.channels ?? {}).filter(([, v]) => v !== undefined)),
    };
    const showOnMobile = body.showOnMobile ?? p.showOnMobile!;
    const known = seedOf(p.pluginId).tabs.map((x) => x.id);
    if (body.pinnedTabs?.some((x) => !known.includes(x))) {
      throw new MockApiError('validation_failed');
    }
    const pinnedTabs = body.pinnedTabs ?? p.pinnedTabs ?? [];
    pluginsState(s).prefs[`${p.installationId}:${u.id}`] = { channels, showOnMobile, pinnedTabs };
    return { ...p, mode: modeOf(channels), channels, showOnMobile, pinnedTabs };
  },
  runPluginCommand: ({ s, params, body }) => {
    const u = requireUser(s);
    const i = installation(s, body.installationId);
    if (!i.enabled) throw new MockApiError('plugin_disabled');
    pluginsState(s).commands.push({
      ...body,
      args: body.args ?? '',
      conversationId: params.conversationId!,
    });
    return { reply: `Merhaba ${u.name}, ${body.args ?? ''}`.trim(), messageId: null };
  },
};
