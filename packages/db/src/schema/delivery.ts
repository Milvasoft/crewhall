import { integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth';
import { organizations } from './org';
import { timestamps, tz } from './types';

/**
 * How an org sends e-mail and push (Yönetim › Bildirim gönderimi). A missing row means 'env' for
 * both: the server's SMTP_URL, FIREBASE_* and EXPO_* settings. Secrets are AES-256-GCM with a key
 * derived from AUTH_SECRET and the org id as associated data (services/ai/crypto); they are never
 * returned, only whether they are set.
 */
export const deliverySettings = pgTable('delivery_settings', {
  orgId: uuid('org_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  emailMode: text('email_mode', { enum: ['env', 'smtp', 'notifike'] })
    .notNull()
    .default('env'),
  smtpHost: text('smtp_host'),
  smtpPort: integer('smtp_port'),
  /** tls: TLS from the start (465); starttls: upgrade (587); none: plain (internal relays). */
  smtpSecurity: text('smtp_security', { enum: ['tls', 'starttls', 'none'] })
    .notNull()
    .default('starttls'),
  smtpUsername: text('smtp_username'),
  smtpPasswordEnc: text('smtp_password_enc'),
  smtpPasswordUpdatedAt: tz('smtp_password_updated_at'),
  /** Sender address (`ops@example.com` or `Name <ops@example.com>`). */
  smtpFrom: text('smtp_from'),
  pushMode: text('push_mode', { enum: ['env', 'direct', 'notifike'] })
    .notNull()
    .default('env'),
  /** Firebase service account JSON; its project id is kept apart for the settings screen. */
  fcmServiceAccountEnc: text('fcm_service_account_enc'),
  fcmProjectId: text('fcm_project_id'),
  fcmUpdatedAt: tz('fcm_updated_at'),
  expoAccessTokenEnc: text('expo_access_token_enc'),
  expoUpdatedAt: tz('expo_updated_at'),
  notifikeBaseUrl: text('notifike_base_url'),
  notifikeApiKeyEnc: text('notifike_api_key_enc'),
  notifikeApiKeyHint: text('notifike_api_key_hint'),
  notifikeApiKeyUpdatedAt: tz('notifike_api_key_updated_at'),
  /** Notifike refused the key (401/403) since it was last saved; shown as a warning. */
  notifikeAuthFailedAt: tz('notifike_auth_failed_at'),
  /** DeliveryTestResult of the last "Test gönder" per channel. */
  lastEmailTest: jsonb('last_email_test').$type<Record<string, unknown>>(),
  lastPushTest: jsonb('last_push_test').$type<Record<string, unknown>>(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps(),
});
