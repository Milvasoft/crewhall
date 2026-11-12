import { and, eq, inArray } from 'drizzle-orm';
import { chatUserSettings, notificationPrefs, type DbOrTx } from '@crewhall/db';
import {
  NOTIFICATION_GROUPS,
  notificationGroupOf,
  type NotificationCategory,
  type NotificationChannel,
  type NotificationGroupKey,
  type NotificationPrefs,
  type OrgSettings,
} from '@crewhall/shared';
import { moduleEnabledIn } from '../identity/modules';

/**
 * Preference matrix (doc 17 §10). Rows of two kinds share notification_prefs:
 * - categories (older clients): a missing row means the default below;
 * - groups (`g:<key>`, NOTIFICATION_GROUPS): one per kind of notification. A group the person
 *   never set follows the category the notification was sent under, so nothing changes until
 *   they touch it.
 * E-mail means the digest; desktop (OS notifications) follows the bell unless set. Locked
 * channels can't be turned off.
 */
type Channel = 'inApp' | 'push' | 'email';
interface Pref {
  inApp: boolean;
  push: boolean;
  email: boolean;
}
interface FullPref extends Pref {
  desktop: boolean;
}
interface Saved extends Pref {
  desktop: boolean | null;
}

const GROUP_PREFIX = 'g:';
const ALL_CHANNELS: NotificationChannel[] = ['inApp', 'desktop', 'push', 'email'];

export const CATEGORY_DEFAULTS: Record<NotificationCategory, Pref & { locked: Channel[] }> = {
  mention: { inApp: true, push: true, email: true, locked: [] },
  direct_reply: { inApp: true, push: true, email: true, locked: [] },
  conversation_message: { inApp: true, push: true, email: false, locked: [] },
  alert: { inApp: true, push: true, email: false, locked: [] },
  share: { inApp: true, push: true, email: true, locked: [] },
  boards: { inApp: true, push: true, email: true, locked: [] },
  meetings: { inApp: true, push: true, email: false, locked: [] },
  links: { inApp: true, push: true, email: false, locked: [] },
  vault: { inApp: true, push: true, email: true, locked: [] },
  security: { inApp: true, push: false, email: true, locked: ['inApp', 'email'] },
  portal: { inApp: true, push: false, email: true, locked: ['inApp', 'email'] },
  announcements: { inApp: true, push: true, email: true, locked: ['inApp'] },
};

const CATEGORIES = Object.keys(CATEGORY_DEFAULTS) as NotificationCategory[];

export type SettingsRow = typeof chatUserSettings.$inferSelect;

/** Saved settings or the defaults (online, receipts on, daily digest, no quiet hours). */
export function settingsOrDefault(
  row: SettingsRow | undefined,
  orgId: string,
  userId: string,
): SettingsRow {
  if (row) return row;
  const now = new Date();
  return {
    orgId,
    userId,
    readReceipts: true,
    timezone: null,
    visibility: 'online',
    visibilityUntil: null,
    statusText: null,
    statusEmoji: null,
    statusExpiresAt: null,
    autoMeeting: true,
    digest: 'daily',
    quietFrom: null,
    quietTo: null,
    lastDigestAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

export async function loadSettings(db: DbOrTx, orgId: string, userIds: string[]) {
  const out = new Map<string, SettingsRow>();
  if (userIds.length === 0) return out;
  const rows = await db
    .select()
    .from(chatUserSettings)
    .where(and(eq(chatUserSettings.orgId, orgId), inArray(chatUserSettings.userId, userIds)));
  const byUser = new Map(rows.map((r) => [r.userId, r]));
  for (const id of userIds) out.set(id, settingsOrDefault(byUser.get(id), orgId, id));
  return out;
}

export async function ensureSettings(db: DbOrTx, orgId: string, userId: string) {
  await db.insert(chatUserSettings).values({ orgId, userId }).onConflictDoNothing();
}

/** Saved rows per person: categories by name, groups as `g:<key>`. */
export type SavedPrefs = Map<string, Saved>;

export async function loadPrefs(db: DbOrTx, orgId: string, userIds: string[]) {
  const out = new Map<string, SavedPrefs>();
  if (userIds.length === 0) return out;
  const rows = await db
    .select()
    .from(notificationPrefs)
    .where(and(eq(notificationPrefs.orgId, orgId), inArray(notificationPrefs.userId, userIds)));
  for (const id of userIds) out.set(id, new Map());
  for (const r of rows) {
    out.get(r.userId)!.set(r.category, {
      inApp: r.inApp,
      push: r.push,
      email: r.email,
      desktop: r.desktop,
    });
  }
  return out;
}

/** A category's prefs (older clients' rows), locked channels on. */
export function prefFor(saved: SavedPrefs | undefined, category: NotificationCategory): FullPref {
  const d = CATEGORY_DEFAULTS[category];
  const p = saved?.get(category);
  const inApp = d.locked.includes('inApp') || (p ?? d).inApp;
  return {
    inApp,
    push: d.locked.includes('push') || (p ?? d).push,
    email: d.locked.includes('email') || (p ?? d).email,
    desktop: p?.desktop ?? inApp,
  };
}

const groupDef = (key: NotificationGroupKey) => NOTIFICATION_GROUPS.find((g) => g.key === key)!;

/** Channels a group has, and those its person cannot turn off. */
function groupChannels(key: NotificationGroupKey) {
  const g = groupDef(key);
  const channels: NotificationChannel[] = [...('channels' in g ? g.channels : ALL_CHANNELS)];
  const locked: NotificationChannel[] = (
    'locked' in g ? [...g.locked] : CATEGORY_DEFAULTS[g.category].locked
  ).filter((c) => channels.includes(c));
  return { channels, locked };
}

/** A group's prefs: its own row, else its category's; channels it lacks off, locked ones on. */
export function groupPref(
  saved: SavedPrefs | undefined,
  key: NotificationGroupKey,
  category: NotificationCategory = groupDef(key).category,
): FullPref {
  const own = saved?.get(`${GROUP_PREFIX}${key}`);
  const base = prefFor(saved, category);
  const p: FullPref = own ? { ...own, desktop: own.desktop ?? own.inApp } : base;
  const { channels, locked } = groupChannels(key);
  const pick = (c: NotificationChannel) => locked.includes(c) || (channels.includes(c) && p[c]);
  return {
    inApp: pick('inApp'),
    desktop: pick('desktop'),
    push: pick('push'),
    email: pick('email'),
  };
}

/** What a notification of `type`, sent under `category`, may use. */
export function prefForType(
  saved: SavedPrefs | undefined,
  type: string,
  category: NotificationCategory,
): FullPref {
  const key = notificationGroupOf(type);
  return key ? groupPref(saved, key, category) : prefFor(saved, category);
}

export async function getNotificationPrefs(
  db: DbOrTx,
  orgId: string,
  userId: string,
  orgSettings?: Pick<OrgSettings, 'modules'> | null,
): Promise<NotificationPrefs> {
  const saved = (await loadPrefs(db, orgId, [userId])).get(userId);
  const settings = (await loadSettings(db, orgId, [userId])).get(userId)!;
  return {
    categories: CATEGORIES.map((category) => {
      const { inApp, push, email } = prefFor(saved, category);
      return { category, inApp, push, email, locked: CATEGORY_DEFAULTS[category].locked };
    }),
    // Rows of modules the org turned off are not shown.
    groups: NOTIFICATION_GROUPS.filter(
      (g) => !('module' in g) || moduleEnabledIn(orgSettings, g.module),
    ).map((g) => ({ group: g.key, ...groupPref(saved, g.key), ...groupChannels(g.key) })),
    digest: settings.digest,
    quietHours:
      settings.quietFrom && settings.quietTo
        ? { from: settings.quietFrom, to: settings.quietTo }
        : null,
  };
}

export async function updateNotificationPrefs(
  db: DbOrTx,
  orgId: string,
  userId: string,
  orgSettings: Pick<OrgSettings, 'modules'> | null | undefined,
  input: {
    categories?:
      | {
          category: NotificationCategory;
          inApp?: boolean | undefined;
          push?: boolean | undefined;
          email?: boolean | undefined;
        }[]
      | undefined;
    groups?:
      | {
          group: NotificationGroupKey;
          inApp?: boolean | undefined;
          desktop?: boolean | undefined;
          push?: boolean | undefined;
          email?: boolean | undefined;
        }[]
      | undefined;
    digest?: 'off' | 'hourly' | 'daily' | undefined;
    quietHours?: { from: string; to: string } | null | undefined;
  },
) {
  if (input.categories?.length) {
    const saved = (await loadPrefs(db, orgId, [userId])).get(userId);
    for (const c of input.categories) {
      const cur = prefFor(saved, c.category);
      const next = {
        inApp: c.inApp ?? cur.inApp,
        push: c.push ?? cur.push,
        email: c.email ?? cur.email,
      };
      await db
        .insert(notificationPrefs)
        .values({ orgId, userId, category: c.category, ...next })
        .onConflictDoUpdate({
          target: [notificationPrefs.orgId, notificationPrefs.userId, notificationPrefs.category],
          set: { ...next, updatedAt: new Date() },
        });
    }
  }
  if (input.groups?.length) {
    const saved = (await loadPrefs(db, orgId, [userId])).get(userId);
    for (const g of input.groups) {
      // From what the person sees now, so a row they never set keeps its other channels.
      const cur = groupPref(saved, g.group);
      const next = {
        inApp: g.inApp ?? cur.inApp,
        desktop: g.desktop ?? cur.desktop,
        push: g.push ?? cur.push,
        email: g.email ?? cur.email,
      };
      await db
        .insert(notificationPrefs)
        .values({ orgId, userId, category: `${GROUP_PREFIX}${g.group}`, ...next })
        .onConflictDoUpdate({
          target: [notificationPrefs.orgId, notificationPrefs.userId, notificationPrefs.category],
          set: { ...next, updatedAt: new Date() },
        });
    }
  }
  if (input.digest !== undefined || input.quietHours !== undefined) {
    await ensureSettings(db, orgId, userId);
    await db
      .update(chatUserSettings)
      .set({
        ...(input.digest !== undefined ? { digest: input.digest } : {}),
        ...(input.quietHours !== undefined
          ? { quietFrom: input.quietHours?.from ?? null, quietTo: input.quietHours?.to ?? null }
          : {}),
      })
      .where(and(eq(chatUserSettings.orgId, orgId), eq(chatUserSettings.userId, userId)));
  }
  return getNotificationPrefs(db, orgId, userId, orgSettings);
}

/** Minutes since midnight in the person's zone (UTC when unknown or invalid). */
export function localMinutes(date: Date, timezone: string | null) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone ?? 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
    const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
    return h * 60 + m;
  } catch {
    return date.getUTCHours() * 60 + date.getUTCMinutes();
  }
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** Inside the quiet hours (which may wrap midnight)? */
export function inQuietHours(settings: SettingsRow, now = new Date()) {
  if (!settings.quietFrom || !settings.quietTo) return false;
  const t = localMinutes(now, settings.timezone);
  const from = toMinutes(settings.quietFrom);
  const to = toMinutes(settings.quietTo);
  if (from === to) return false;
  return from < to ? t >= from && t < to : t >= from || t < to;
}

/** Chosen visibility, with an expired `until` read as online. */
export function liveVisibility(settings: SettingsRow, now = new Date()) {
  if (settings.visibilityUntil && settings.visibilityUntil.getTime() <= now.getTime()) {
    return 'online';
  }
  return settings.visibility;
}
