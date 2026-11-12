import { and, eq, isNull } from 'drizzle-orm';
import type { Context } from 'hono';
import {
  notifications,
  orgMembers,
  pluginInstallations,
  pluginLinkedUsers,
  pluginNotificationPrefs,
  users,
  type DbOrTx,
} from '@crewhall/db';
import { localize, pluginUrl, type PluginManifest } from '@crewhall/plugin-sdk';
import {
  INSTALLATION_HEADER,
  PluginNotificationClearRequest,
  PluginNotificationRequest,
  SIGNATURE_HEADER,
  verifyApiRequest,
  type PluginNotificationClearResponse,
  type PluginNotificationResponse,
} from '@crewhall/plugin-sdk/server';
import type {
  PluginNotificationChannels,
  PluginNotificationMode,
  PluginNotificationPref,
  UpdatePluginNotificationPref,
} from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { AppEnv } from '../../http/types';
import { audit } from '../audit';
import { take } from '../mcp/rate-limit';
import { publishCount } from '../notifications/center';
import { notify } from '../notifications/notify';
import { pushTag } from '../notifications/push';
import {
  installationSecret,
  loadInstallation,
  pluginName,
  type InstallationRow,
} from './installations';

/**
 * Plugin notifications (docs/contracts/eklentiler.md › Bildirimler): the plugin server, as the
 * installation (no person), notifies someone who opened the plugin. The request is signed with
 * the installation secret; the installation needs `notifications:write`; the person decides
 * per plugin (on, muted, off) and through their usual notification preferences.
 */

export const NOTIFY_SCOPE = 'notifications:write';
/** Per installation, and per installation and person (token buckets, per minute). */
const PER_INSTALLATION_PER_MINUTE = 300;
const PER_PERSON_PER_MINUTE = 20;
/** Reading is faster than receiving: opening chats one after another. */
const PER_INSTALLATION_CLEARS_PER_MINUTE = 600;
const PER_PERSON_CLEARS_PER_MINUTE = 60;
const MAX_BODY_BYTES = 8 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAB_PATH = /^(\/chat)?\/plugins\/([^/?#]+)\/([^/?#]+)(\?[^#]*)?(#.*)?$/;

/** A session token was issued to the person: the installation may notify them from now on. */
export async function linkUser(db: DbOrTx, row: InstallationRow, userId: string) {
  await db
    .insert(pluginLinkedUsers)
    .values({ installationId: row.id, userId, orgId: row.orgId })
    .onConflictDoUpdate({
      target: [pluginLinkedUsers.installationId, pluginLinkedUsers.userId],
      set: { lastSeenAt: new Date() },
    });
}

/**
 * The notification's link must open one of this installation's own tabs, in its placement;
 * whatever follows (`?chat=42`, `#x`) is the deep link the tab gets. Default: its first tab.
 */
export function notificationUrl(row: InstallationRow, url: string | undefined): string {
  const tabs = row.manifest.entryPoints.tabs;
  if (url === undefined) {
    const first = tabs[0];
    if (!first) throw new AppError('plugin_url_invalid', { reason: 'no_tab' });
    return `${first.placement === 'chat' ? '/chat' : ''}/plugins/${row.id}/${first.id}`;
  }
  const m = TAB_PATH.exec(url);
  const tab = m && tabs.find((t) => t.id === m[3]);
  if (!m || m[2] !== row.id || !tab || (tab.placement === 'chat') !== (m[1] === '/chat')) {
    throw new AppError('plugin_url_invalid');
  }
  return url;
}

/** A chat tab this person pinned to the left rail is where they use it: the link goes there. */
export function personalUrl(url: string, pinnedTabs: readonly string[]): string {
  const m = TAB_PATH.exec(url);
  return m?.[1] === '/chat' && pinnedTabs.includes(m[3]!) ? url.slice('/chat'.length) : url;
}

export async function signedInstallation(deps: Deps, c: Context<AppEnv>, body: string) {
  const invalid = () => {
    c.header('WWW-Authenticate', 'Crewhall-Signature');
    return new AppError('unauthenticated', { reason: 'invalid_signature' });
  };
  const id = c.req.header(INSTALLATION_HEADER) ?? '';
  if (!UUID.test(id)) throw invalid();
  const [row] = await deps.db
    .select()
    .from(pluginInstallations)
    .where(eq(pluginInstallations.id, id));
  if (!row) throw invalid();
  const ok = await verifyApiRequest({
    secret: installationSecret(deps.env, row),
    body,
    signature: c.req.header(SIGNATURE_HEADER),
  });
  if (!ok) throw invalid();
  return row;
}

export async function limited(
  c: Context<AppEnv>,
  deps: Deps,
  subject: string,
  kind: string,
  n: number,
  org: string,
) {
  const r = await take(deps.db, subject, { kind, perMinute: n }, org);
  if (!r.allowed) {
    c.header('Retry-After', String(r.retryAfter));
    throw new AppError('rate_limited', { retryAfter: r.retryAfter, scope: kind });
  }
}

type Channels = PluginNotificationChannels;
const ALL_ON: Channels = { bell: true, desktop: true, push: true };

/** The API 31 summary of the channels, for older clients. */
export function modeOfChannels(c: Channels): PluginNotificationMode {
  if (!c.bell && !c.push) return 'off';
  return c.push || (c.bell && c.desktop) ? 'on' : 'muted';
}

/** An API 31 mode as channels: muted = bell only. */
export function channelsOfMode(mode: PluginNotificationMode): Channels {
  if (mode === 'off') return { bell: false, desktop: false, push: false };
  if (mode === 'muted') return { bell: true, desktop: false, push: false };
  return ALL_ON;
}

async function channelsOf(db: DbOrTx, installationId: string, userId: string): Promise<Channels> {
  const [pref] = await db
    .select({
      bell: pluginNotificationPrefs.bell,
      desktop: pluginNotificationPrefs.desktop,
      push: pluginNotificationPrefs.push,
    })
    .from(pluginNotificationPrefs)
    .where(
      and(
        eq(pluginNotificationPrefs.installationId, installationId),
        eq(pluginNotificationPrefs.userId, userId),
      ),
    );
  return pref ?? ALL_ON;
}

/** A signed request of an installation that may notify; its parsed JSON body. */
async function notifyingInstallation(deps: Deps, c: Context<AppEnv>) {
  const body = await c.req.text();
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
    throw new AppError('validation_failed', { reason: 'too_large' });
  }
  const row = await signedInstallation(deps, c, body);
  if (!row.enabled) throw new AppError('plugin_disabled');
  if (!row.permissions.includes(NOTIFY_SCOPE)) {
    throw new AppError('token_scope', { scope: NOTIFY_SCOPE });
  }
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new AppError('validation_failed', { reason: 'json' });
  }
  return { row, json };
}

/**
 * The source shown on a plugin's notifications (bell, desktop, push: "WhatsApp · Ayşe"), in the
 * recipient's language: the manifest's `notificationName`, else the title of its only tab, else
 * its full name. The full name (with any warning in it) stays where the plugin is installed or
 * described.
 */
export function notificationSource(manifest: PluginManifest, locale: string): string {
  if (manifest.notificationName) return localize(manifest.notificationName, locale);
  const tabs = manifest.entryPoints.tabs;
  const only = tabs.length === 1 ? tabs[0] : undefined;
  return only ? localize(only.title, locale) : pluginName(manifest, locale);
}

/** The collapse key of a plugin's notifications with this `threadKey`. */
const groupKeyOf = (installationId: string, threadKey: string) =>
  `plugin:${installationId}:${threadKey}`;

/** POST /api/plugins/v1/notifications (createPluginNotification). */
export async function createPluginNotification(
  deps: Deps,
  c: Context<AppEnv>,
): Promise<PluginNotificationResponse> {
  const { row, json } = await notifyingInstallation(deps, c);
  const parsed = PluginNotificationRequest.safeParse(json);
  if (!parsed.success) throw new AppError('validation_failed', { issues: parsed.error.issues });
  const input = parsed.data;
  if (!UUID.test(input.userId)) throw new AppError('plugin_user_not_linked');

  // Only people who opened the plugin, and only while they are still in the organization.
  const [linked] = await deps.db
    .select({ status: orgMembers.status })
    .from(pluginLinkedUsers)
    .innerJoin(
      orgMembers,
      and(
        eq(orgMembers.organizationId, pluginLinkedUsers.orgId),
        eq(orgMembers.userId, pluginLinkedUsers.userId),
      ),
    )
    .where(
      and(eq(pluginLinkedUsers.installationId, row.id), eq(pluginLinkedUsers.userId, input.userId)),
    );
  if (!linked || linked.status !== 'active') {
    throw new AppError('plugin_user_not_linked');
  }
  const url = notificationUrl(row, input.url);
  await limited(c, deps, row.id, 'plugin_notify', PER_INSTALLATION_PER_MINUTE, row.orgId);
  await limited(
    c,
    deps,
    `${input.userId}:${row.id}`,
    'plugin_notify_user',
    PER_PERSON_PER_MINUTE,
    row.orgId,
  );

  // The person's channels for this plugin; the "plugins" row of their notification settings
  // applies on top (both must allow a channel). A push may go without a bell row.
  const ch = await channelsOf(deps.db, row.id, input.userId);
  if (!ch.bell && !ch.push) return { id: null, collapsed: false, delivered: false };
  const [recipient] = await deps.db
    .select({ locale: users.locale })
    .from(users)
    .where(eq(users.id, input.userId));
  const name = notificationSource(row.manifest, recipient?.locale ?? 'tr');
  const [pref] = await deps.db
    .select({ pinnedTabs: pluginNotificationPrefs.pinnedTabs })
    .from(pluginNotificationPrefs)
    .where(
      and(
        eq(pluginNotificationPrefs.installationId, row.id),
        eq(pluginNotificationPrefs.userId, input.userId),
      ),
    );
  const [created] = await notify(deps, [
    {
      orgId: row.orgId,
      userId: input.userId,
      type: 'plugin.notification',
      category: 'alert',
      actorId: null,
      target: { type: 'plugin', id: row.id },
      data: {
        plugin: name,
        pluginId: row.pluginId,
        icon: row.manifest.icon ? pluginUrl(row.manifest, row.manifest.icon) : null,
        title: input.title,
        excerpt: input.body,
      },
      url: personalUrl(url, pref?.pinnedTabs ?? []),
      groupKey: input.threadKey ? groupKeyOf(row.id, input.threadKey) : null,
      silent: !ch.push,
      pushOnly: !ch.bell,
      // The person's desktop switch for this plugin (a push may be off while the toast is on).
      desktop: ch.desktop,
    },
  ]);
  if (!created) return { id: null, collapsed: false, delivered: false };
  const collapsed = created.count > 1;
  if (!collapsed) {
    await audit(deps.db, {
      orgId: row.orgId,
      actorId: null,
      action: 'plugin.notify',
      targetType: 'plugin_installation',
      targetId: row.id,
      meta: { pluginId: row.pluginId, userId: input.userId, threadKey: input.threadKey ?? null },
    });
  }
  return { id: created.id, collapsed, delivered: true };
}

/**
 * POST /api/plugins/v1/notifications/clear: the person read it inside the plugin. Only this
 * installation's own rows for this person and `threadKey` change; nothing else is reachable.
 * Clearing is frequent and harmless, so it is not audited.
 */
export async function clearPluginNotifications(
  deps: Deps,
  c: Context<AppEnv>,
): Promise<PluginNotificationClearResponse> {
  const { row, json } = await notifyingInstallation(deps, c);
  const parsed = PluginNotificationClearRequest.safeParse(json);
  if (!parsed.success) throw new AppError('validation_failed', { issues: parsed.error.issues });
  const input = parsed.data;
  if (!UUID.test(input.userId)) return { cleared: 0 };
  await limited(c, deps, row.id, 'plugin_clear', PER_INSTALLATION_CLEARS_PER_MINUTE, row.orgId);
  await limited(
    c,
    deps,
    `${input.userId}:${row.id}`,
    'plugin_clear_user',
    PER_PERSON_CLEARS_PER_MINUTE,
    row.orgId,
  );
  const now = new Date();
  const groupKey = groupKeyOf(row.id, input.threadKey);
  const open = and(
    eq(notifications.orgId, row.orgId),
    eq(notifications.userId, input.userId),
    eq(notifications.groupKey, groupKey),
    // A push-only row (bell off) is already dismissed but still counts for the phone.
    input.action === 'read' ? isNull(notifications.readAt) : isNull(notifications.dismissedAt),
  );
  const cleared = await deps.db
    .update(notifications)
    .set(
      input.action === 'read'
        ? { readAt: now, updatedAt: now }
        : { dismissedAt: now, updatedAt: now },
    )
    .where(open)
    .returning({ pushedAt: notifications.pushedAt });
  if (cleared.length) {
    await publishCount(deps.db, deps.bus, row.orgId, input.userId);
    if (cleared.some((r) => r.pushedAt)) {
      await deps.jobs.send('push.clear', {
        orgId: row.orgId,
        userId: input.userId,
        tag: pushTag(groupKey),
      });
    }
  }
  return { cleared: cleared.length };
}

// ---- the person's side (Bildirim ayarları › Eklentiler) ----

/**
 * Every active plugin the person sees, with their settings: channels (when the plugin may
 * notify them) and whether it shows in the mobile app.
 */
export async function listPluginNotificationPrefs(
  db: DbOrTx,
  orgId: string,
  userId: string,
): Promise<PluginNotificationPref[]> {
  const rows = await db
    .select({
      inst: pluginInstallations,
      pref: pluginNotificationPrefs,
      linked: pluginLinkedUsers.userId,
    })
    .from(pluginInstallations)
    .leftJoin(
      pluginNotificationPrefs,
      and(
        eq(pluginNotificationPrefs.installationId, pluginInstallations.id),
        eq(pluginNotificationPrefs.userId, userId),
      ),
    )
    .leftJoin(
      pluginLinkedUsers,
      and(
        eq(pluginLinkedUsers.installationId, pluginInstallations.id),
        eq(pluginLinkedUsers.userId, userId),
      ),
    )
    .where(and(eq(pluginInstallations.orgId, orgId), eq(pluginInstallations.enabled, true)));
  return rows
    .map(({ inst, pref, linked }) => {
      const channels = pref ? { bell: pref.bell, desktop: pref.desktop, push: pref.push } : ALL_ON;
      return {
        installationId: inst.id,
        pluginId: inst.pluginId,
        name: inst.manifest.name,
        icon: inst.manifest.icon ? pluginUrl(inst.manifest, inst.manifest.icon) : null,
        mode: modeOfChannels(channels),
        channels,
        showOnMobile: pref?.showMobile ?? true,
        canNotify: linked !== null && inst.permissions.includes(NOTIFY_SCOPE),
        pinnedTabs: pref?.pinnedTabs ?? [],
      };
    })
    .sort((a, b) => a.pluginId.localeCompare(b.pluginId));
}

export async function updatePluginNotificationPref(
  db: DbOrTx,
  orgId: string,
  userId: string,
  installationId: string,
  input: UpdatePluginNotificationPref,
): Promise<PluginNotificationPref> {
  const list = await listPluginNotificationPrefs(db, orgId, userId);
  const current = list.find((p) => p.installationId === installationId);
  if (!current) throw new AppError('plugin_not_found');
  const channels: Channels = {
    ...(input.mode !== undefined ? channelsOfMode(input.mode) : current.channels!),
    ...Object.fromEntries(Object.entries(input.channels ?? {}).filter(([, v]) => v !== undefined)),
  };
  const showMobile = input.showOnMobile ?? current.showOnMobile!;
  const pinnedTabs = input.pinnedTabs
    ? await knownTabs(db, orgId, installationId, input.pinnedTabs)
    : current.pinnedTabs!;
  const mode = modeOfChannels(channels);
  const values = { mode, ...channels, showMobile, pinnedTabs };
  await db
    .insert(pluginNotificationPrefs)
    .values({ installationId, userId, orgId, ...values })
    .onConflictDoUpdate({
      target: [pluginNotificationPrefs.installationId, pluginNotificationPrefs.userId],
      set: { ...values, updatedAt: new Date() },
    });
  return { ...current, mode, channels, showOnMobile: showMobile, pinnedTabs };
}

/** Pinned tabs must be this plugin's own; an update of the plugin may later drop some. */
async function knownTabs(db: DbOrTx, orgId: string, installationId: string, tabs: string[]) {
  const row = await loadInstallation(db, orgId, installationId);
  const known = row.manifest.entryPoints.tabs.map((t) => t.id);
  if (tabs.some((t) => !known.includes(t))) {
    throw new AppError('validation_failed', { reason: 'unknown_tab', known });
  }
  return known.filter((t) => tabs.includes(t));
}

/** The person's own view of the org's plugins: hidden on mobile, pinned to the rail. */
export async function personalSurfaces(db: DbOrTx, orgId: string, userId: string) {
  const rows = await db
    .select({
      id: pluginNotificationPrefs.installationId,
      showMobile: pluginNotificationPrefs.showMobile,
      pinnedTabs: pluginNotificationPrefs.pinnedTabs,
    })
    .from(pluginNotificationPrefs)
    .where(
      and(eq(pluginNotificationPrefs.orgId, orgId), eq(pluginNotificationPrefs.userId, userId)),
    );
  return new Map(rows.map((r) => [r.id, r]));
}
