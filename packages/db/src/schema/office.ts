import { boolean, index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth';
import { organizations } from './org';
import { nodes } from './space';
import { timestamps, tz } from './types';

/**
 * Office module (WOPI host for a document server such as Collabora Online). Owned by the
 * office session; the document server itself is a separate service.
 */

/** Per-org settings (Yönetim › Entegrasyonlar › Office); a missing row means "off". */
export const officeSettings = pgTable('office_settings', {
  orgId: uuid('org_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(false),
  /** onlyoffice (Euro-Office, ONLYOFFICE Docs: Document Server API) or wopi (WOPI clients). */
  serverType: text('server_type', { enum: ['onlyoffice', 'wopi'] })
    .notNull()
    .default('onlyoffice'),
  /** Public address of the document server (browsers load the editor from it). */
  serverUrl: text('server_url'),
  /** Address Crewhall uses to read the server's discovery, when it differs (Docker network). */
  internalUrl: text('internal_url'),
  /** The onlyoffice server's JWT secret, sealed with a key derived from AUTH_SECRET. */
  jwtSecretEnc: text('jwt_secret_enc'),
  jwtSecretHint: text('jwt_secret_hint'),
  /** OfficeTestResult of the last discovery read. */
  lastTest: jsonb('last_test').$type<Record<string, unknown>>(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps(),
});

/**
 * WOPI locks (Lock, RefreshLock, Unlock): one opaque lock string per file, 30 minutes unless
 * refreshed. The document server holds it while people edit; saves must present it.
 */
export const wopiLocks = pgTable(
  'wopi_locks',
  {
    nodeId: uuid('node_id')
      .primaryKey()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    lock: text('lock').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: tz('expires_at').notNull(),
    ...timestamps(),
  },
  (t) => [index('wopi_locks_org_idx').on(t.orgId)],
);

/**
 * Editing sessions of the Document Server API: one document key per file while people edit it.
 * The key stays through force-saves (Ctrl S) and is dropped when the server reports the editing
 * finished, so the next opening starts from the newest Drive version.
 */
export const officeDocKeys = pgTable('office_doc_keys', {
  nodeId: uuid('node_id')
    .primaryKey()
    .references(() => nodes.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  docKey: text('doc_key').notNull(),
  /** The Drive version the session is based on; another version means a new session. */
  baseVersionId: uuid('base_version_id'),
  ...timestamps(),
});
