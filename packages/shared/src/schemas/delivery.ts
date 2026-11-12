import { z } from 'zod';
import { Timestamp } from './common';

/**
 * Yönetim › Bildirim gönderimi: how the org sends e-mail and push. Each channel either uses the
 * server's settings ('env': SMTP_URL, FIREBASE_*, EXPO_*), the org's own provider, or Notifike.
 * Secrets (SMTP password, Firebase service account, Expo token, Notifike key) are write-only:
 * reads only say whether one is stored.
 */

export const EmailDeliveryMode = z.enum(['env', 'smtp', 'notifike']);
export type EmailDeliveryMode = z.infer<typeof EmailDeliveryMode>;
export const PushDeliveryMode = z.enum(['env', 'direct', 'notifike']);
export type PushDeliveryMode = z.infer<typeof PushDeliveryMode>;
/** tls: TLS from the start (usually 465); starttls: upgrade (587); none: plain. */
export const SmtpSecurity = z.enum(['tls', 'starttls', 'none']);
export type SmtpSecurity = z.infer<typeof SmtpSecurity>;
export const DeliveryChannel = z.enum(['email', 'push']);
export type DeliveryChannel = z.infer<typeof DeliveryChannel>;

export const DELIVERY_LIMITS = {
  hostChars: 255,
  usernameChars: 320,
  passwordChars: 500,
  fromChars: 320,
  apiKeyChars: 500,
  tokenChars: 500,
  serviceAccountChars: 20_000,
} as const;

/** A stored secret: never the value, only whether it is there (and its last four characters). */
export const StoredSecret = z.object({
  set: z.boolean(),
  hint: z.string().nullable(),
  updatedAt: Timestamp.nullable(),
});
export type StoredSecret = z.infer<typeof StoredSecret>;

export const DeliveryTestResult = z.object({
  channel: DeliveryChannel,
  ok: z.boolean(),
  at: Timestamp,
  /** The path used: the server's settings, the org's own provider or Notifike. */
  via: z.enum(['env', 'smtp', 'direct', 'notifike']),
  /** Addresses or devices it went to. */
  recipients: z.number().int().min(0),
  /** A `delivery_*` error code on failure (`errors.<code>`). */
  code: z.string().nullable(),
  /** The provider's own message on failure; never contains a secret. */
  message: z.string().nullable(),
});
export type DeliveryTestResult = z.infer<typeof DeliveryTestResult>;

export const DeliverySettings = z.object({
  email: z.object({
    mode: EmailDeliveryMode,
    smtp: z.object({
      host: z.string().nullable(),
      port: z.number().int().nullable(),
      security: SmtpSecurity,
      username: z.string().nullable(),
      password: StoredSecret,
      from: z.string().nullable(),
    }),
    /** The selected mode has everything it needs. */
    configured: z.boolean(),
    lastTest: DeliveryTestResult.nullable(),
  }),
  push: z.object({
    mode: PushDeliveryMode,
    direct: z.object({
      /** Project of the stored Firebase service account. */
      fcmProjectId: z.string().nullable(),
      fcmServiceAccount: StoredSecret,
      /** Optional: only needed when the Expo project requires access tokens. */
      expoAccessToken: StoredSecret,
    }),
    configured: z.boolean(),
    lastTest: DeliveryTestResult.nullable(),
  }),
  notifike: z.object({
    /** e.g. `https://api.notifike.example.com` (without `/api/v1.0`). */
    baseUrl: z.string().nullable(),
    apiKey: StoredSecret,
    /** Notifike refused the key since it was saved (401/403): shown as a warning. */
    authFailedAt: Timestamp.nullable(),
  }),
  /** What the server's own settings ('env') provide, for the "Sunucu varsayılanı" option. */
  server: z.object({ email: z.boolean(), fcm: z.boolean() }),
  updatedAt: Timestamp.nullable(),
});
export type DeliverySettings = z.infer<typeof DeliverySettings>;

const BaseUrl = z
  .url({ protocol: /^https?$/ })
  .max(500)
  .transform((u) => u.replace(/\/+$/, ''));

/**
 * Partial update. Secrets: a new value replaces the stored one, null removes it, omitted keeps
 * it. Switching a channel to a mode that lacks a required field is refused (validation_failed).
 */
export const UpdateDeliverySettings = z.object({
  email: z
    .object({
      mode: EmailDeliveryMode.optional(),
      smtp: z
        .object({
          host: z.string().trim().min(1).max(DELIVERY_LIMITS.hostChars).nullable().optional(),
          port: z.number().int().min(1).max(65_535).nullable().optional(),
          security: SmtpSecurity.optional(),
          username: z
            .string()
            .trim()
            .min(1)
            .max(DELIVERY_LIMITS.usernameChars)
            .nullable()
            .optional(),
          password: z.string().min(1).max(DELIVERY_LIMITS.passwordChars).nullable().optional(),
          from: z.string().trim().min(3).max(DELIVERY_LIMITS.fromChars).nullable().optional(),
        })
        .optional(),
    })
    .optional(),
  push: z
    .object({
      mode: PushDeliveryMode.optional(),
      /** The Firebase service account JSON file's content. */
      fcmServiceAccount: z
        .string()
        .trim()
        .min(2)
        .max(DELIVERY_LIMITS.serviceAccountChars)
        .nullable()
        .optional(),
      expoAccessToken: z
        .string()
        .trim()
        .min(1)
        .max(DELIVERY_LIMITS.tokenChars)
        .nullable()
        .optional(),
    })
    .optional(),
  notifike: z
    .object({
      baseUrl: BaseUrl.nullable().optional(),
      apiKey: z.string().trim().min(1).max(DELIVERY_LIMITS.apiKeyChars).nullable().optional(),
    })
    .optional(),
});
export type UpdateDeliverySettings = z.infer<typeof UpdateDeliverySettings>;

/**
 * Sends one test message with the stored settings: e-mail to `to` (default the caller's own
 * address), push to the caller's own registered devices.
 */
export const TestDelivery = z.object({
  channel: DeliveryChannel,
  to: z.email().max(DELIVERY_LIMITS.fromChars).optional(),
});
export type TestDelivery = z.infer<typeof TestDelivery>;
