import { boolean, jsonb, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type {
  PluginBrowserCapability,
  PluginManifest,
  PluginPackage,
} from '@crewhall/plugin-sdk';
import { users } from './auth';
import { organizations } from './org';
import { id, timestamps, tz } from './types';

/**
 * Plugins (docs/contracts/eklentiler.md): signed manifests installed from the marketplace.
 * Crewhall stores the package as verified and the permissions the admin approved; the
 * installation secret (HMAC for requests to the plugin server) is AES-GCM encrypted.
 */
export const pluginInstallations = pgTable(
  'plugin_installations',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    pluginId: text('plugin_id').notNull(),
    version: text('version').notNull(),
    manifest: jsonb('manifest').$type<PluginManifest>().notNull(),
    /** The signed package exactly as verified (manifest, review, signature). */
    package: jsonb('package').$type<PluginPackage>().notNull(),
    permissions: jsonb('permissions').$type<string[]>().notNull(),
    /** Browser features granted to its frames (a subset of `manifest.browser`). */
    browser: jsonb('browser').$type<PluginBrowserCapability[]>().notNull().default([]),
    /**
     * Self-hosted plugins: the org's own origin. `manifest` then carries this origin (the signed
     * one stays in `package`), so every URL Crewhall builds for the plugin points here.
     */
    selfOrigin: text('self_origin'),
    enabled: boolean('enabled').notNull().default(true),
    secretEnc: text('secret_enc').notNull(),
    installedBy: uuid('installed_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [uniqueIndex('plugin_installations_plugin_uq').on(t.orgId, t.pluginId)],
);

/** The org's EdDSA key for plugin session tokens (JWKS at /api/plugins/v1/jwks). */
export const pluginSigningKeys = pgTable('plugin_signing_keys', {
  orgId: uuid('org_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  kid: text('kid').notNull(),
  publicJwk: jsonb('public_jwk').$type<Record<string, string>>().notNull(),
  privateKeyEnc: text('private_key_enc').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
});

/**
 * People who opened the plugin: a session token was issued to them for this installation.
 * Installation-level requests (notifications) may only target them; gone with the
 * installation or the person.
 */
export const pluginLinkedUsers = pgTable(
  'plugin_linked_users',
  {
    installationId: uuid('installation_id')
      .notNull()
      .references(() => pluginInstallations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    linkedAt: tz('linked_at').notNull().defaultNow(),
    lastSeenAt: tz('last_seen_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.installationId, t.userId] })],
);

/**
 * A person's settings for one plugin; a missing row means everything on. `bell`, `desktop`,
 * `push` are the notification channels (API 33); `mode` is their API 31 summary, kept in step.
 */
export const pluginNotificationPrefs = pgTable(
  'plugin_notification_prefs',
  {
    installationId: uuid('installation_id')
      .notNull()
      .references(() => pluginInstallations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    mode: text('mode').$type<'on' | 'muted' | 'off'>().notNull(),
    bell: boolean('bell').notNull().default(true),
    desktop: boolean('desktop').notNull().default(true),
    push: boolean('push').notNull().default(true),
    /** Its tabs, cards and commands in the mobile app. */
    showMobile: boolean('show_mobile').notNull().default(true),
    /** Tab ids this person also wants in the left rail. */
    pinnedTabs: jsonb('pinned_tabs').$type<string[]>().notNull().default([]),
    updatedAt: tz('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.installationId, t.userId] })],
);

/**
 * People who let this installation act for them while nobody has the plugin open (API 50): said
 * yes in Crewhall's own dialog, take it back any time. Gone with the installation or the person.
 */
export const pluginOfflineGrants = pgTable(
  'plugin_offline_grants',
  {
    installationId: uuid('installation_id')
      .notNull()
      .references(() => pluginInstallations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    grantedAt: tz('granted_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.installationId, t.userId] })],
);
