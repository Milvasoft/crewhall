import { and, eq, isNull } from 'drizzle-orm';
import { deliverySettings, type DbOrTx } from '@crewhall/db';
import type {
  DeliverySettings,
  DeliveryTestResult,
  StoredSecret,
  UpdateDeliverySettings,
} from '@crewhall/shared';
import type { Deps } from '../../deps';
import type { Env } from '../../env';
import { AppError } from '../../http/errors';
import type { RequestInfo } from '../../http/types';
import { audit } from '../audit';
import { decryptApiKey, encryptApiKey, keyHint } from '../ai/crypto';
import {
  envFcm,
  parseServiceAccount,
  type FcmTarget,
  type ServiceAccount,
} from '../notifications/fcm';
import type { Logger } from '../../logger';
import type { NotifikeConfig, NotifikeError } from './notifike';

/**
 * Per-org e-mail and push delivery (Yönetim › Bildirim gönderimi). No row, or mode 'env', is the
 * server's own SMTP_URL / FIREBASE_* / EXPO_* setup, so installs that never open the page keep
 * working as before. Secrets are encrypted like the AI key (org id as associated data) and leave
 * this module only as "set" plus a hint.
 */

export type DeliveryRow = typeof deliverySettings.$inferSelect;

export async function loadDelivery(db: DbOrTx, orgId: string): Promise<DeliveryRow | null> {
  const [row] = await db.select().from(deliverySettings).where(eq(deliverySettings.orgId, orgId));
  return row ?? null;
}

const open = (env: Env, orgId: string, value: string | null) =>
  value ? decryptApiKey(env.AUTH_SECRET, orgId, value) : null;

export function notifikeConfig(env: Env, row: DeliveryRow | null): NotifikeConfig | null {
  if (!row?.notifikeBaseUrl) return null;
  const apiKey = open(env, row.orgId, row.notifikeApiKeyEnc);
  return apiKey ? { baseUrl: row.notifikeBaseUrl, apiKey } : null;
}

export interface SmtpConfig {
  host: string;
  port: number;
  security: 'tls' | 'starttls' | 'none';
  username: string | null;
  password: string | null;
  from: string;
}

export function smtpConfig(env: Env, row: DeliveryRow | null): SmtpConfig | null {
  if (!row?.smtpHost || !row.smtpPort || !row.smtpFrom) return null;
  return {
    host: row.smtpHost,
    port: row.smtpPort,
    security: row.smtpSecurity,
    username: row.smtpUsername,
    password: open(env, row.orgId, row.smtpPasswordEnc),
    from: row.smtpFrom,
  };
}

/** The server's FCM, or null when FIREBASE_* is missing or unreadable. */
export function serverFcm(env: Env): FcmTarget {
  try {
    return envFcm(env);
  } catch {
    return { apiUrl: env.FCM_API_URL, account: null };
  }
}

/** Where push goes for this org: FCM target, Expo token and (mode 'notifike') Notifike. */
export interface PushRoute {
  mode: DeliveryRow['pushMode'];
  fcm: FcmTarget;
  expoToken: string | null;
  notifike: NotifikeConfig | null;
}

export function pushRoute(env: Env, row: DeliveryRow | null): PushRoute {
  const mode = row?.pushMode ?? 'env';
  if (mode === 'direct' && row) {
    const raw = open(env, row.orgId, row.fcmServiceAccountEnc);
    let account: ServiceAccount | null;
    try {
      account = raw ? parseServiceAccount(raw) : null;
    } catch {
      account = null;
    }
    return {
      mode,
      fcm: { apiUrl: env.FCM_API_URL, account },
      expoToken: open(env, row.orgId, row.expoAccessTokenEnc) ?? env.EXPO_ACCESS_TOKEN ?? null,
      notifike: null,
    };
  }
  // Notifike reaches FCM tokens only; Expo tokens still go to Expo with the server's token.
  return {
    mode,
    fcm: serverFcm(env),
    expoToken: env.EXPO_ACCESS_TOKEN ?? null,
    notifike: mode === 'notifike' ? notifikeConfig(env, row) : null,
  };
}

function secret(
  value: string | null,
  updatedAt: Date | null,
  hint: string | null = null,
): StoredSecret {
  return { set: !!value, hint: value ? hint : null, updatedAt: value ? toIso(updatedAt) : null };
}

const toIso = (d: Date | null) => d?.toISOString() ?? null;
const testOf = (v: Record<string, unknown> | null) => (v ? (v as DeliveryTestResult) : null);

function emailReady(row: DeliveryRow | null, serverEmail: boolean) {
  const mode = row?.emailMode ?? 'env';
  if (mode === 'smtp') return !!(row?.smtpHost && row.smtpPort && row.smtpFrom);
  if (mode === 'notifike') return !!(row?.notifikeBaseUrl && row.notifikeApiKeyEnc);
  return serverEmail;
}

function pushReady(row: DeliveryRow | null) {
  const mode = row?.pushMode ?? 'env';
  if (mode === 'direct') return !!row?.fcmServiceAccountEnc;
  if (mode === 'notifike') return !!(row?.notifikeBaseUrl && row.notifikeApiKeyEnc);
  // Expo needs no server setup; FCM devices need FIREBASE_* (shown under `server`).
  return true;
}

export function toDeliverySettings(
  env: Env,
  row: DeliveryRow | null,
  serverEmail: boolean,
): DeliverySettings {
  return {
    email: {
      mode: row?.emailMode ?? 'env',
      smtp: {
        host: row?.smtpHost ?? null,
        port: row?.smtpPort ?? null,
        security: row?.smtpSecurity ?? 'starttls',
        username: row?.smtpUsername ?? null,
        password: secret(row?.smtpPasswordEnc ?? null, row?.smtpPasswordUpdatedAt ?? null),
        from: row?.smtpFrom ?? null,
      },
      configured: emailReady(row, serverEmail),
      lastTest: testOf(row?.lastEmailTest ?? null),
    },
    push: {
      mode: row?.pushMode ?? 'env',
      direct: {
        fcmProjectId: row?.fcmServiceAccountEnc ? (row.fcmProjectId ?? null) : null,
        fcmServiceAccount: secret(row?.fcmServiceAccountEnc ?? null, row?.fcmUpdatedAt ?? null),
        expoAccessToken: secret(row?.expoAccessTokenEnc ?? null, row?.expoUpdatedAt ?? null),
      },
      configured: pushReady(row),
      lastTest: testOf(row?.lastPushTest ?? null),
    },
    notifike: {
      baseUrl: row?.notifikeBaseUrl ?? null,
      apiKey: secret(
        row?.notifikeApiKeyEnc ?? null,
        row?.notifikeApiKeyUpdatedAt ?? null,
        row?.notifikeApiKeyHint ?? null,
      ),
      authFailedAt: toIso(row?.notifikeAuthFailedAt ?? null),
    },
    server: { email: serverEmail, fcm: !!serverFcm(env).account },
    updatedAt: toIso(row?.updatedAt ?? null),
  };
}

export async function getDeliverySettings(
  deps: Pick<Deps, 'db' | 'env' | 'mailer'>,
  orgId: string,
) {
  return toDeliverySettings(deps.env, await loadDelivery(deps.db, orgId), deps.mailer.enabled);
}

type Patch = Partial<typeof deliverySettings.$inferInsert>;

function invalid(path: string[], code: string, message: string): never {
  throw new AppError('validation_failed', { in: 'body', issues: [{ path, code, message }] });
}

export async function updateDeliverySettings(
  deps: Pick<Deps, 'db' | 'env' | 'mailer'>,
  a: { orgId: string; userId: string },
  input: UpdateDeliverySettings,
  req?: Pick<RequestInfo, 'ip' | 'userAgent'>,
) {
  const { db, env } = deps;
  const now = new Date();
  const seal = (plain: string) => encryptApiKey(env.AUTH_SECRET, a.orgId, plain);
  const patch: Patch = {};
  const changed: string[] = [];
  const set = <K extends keyof Patch>(key: K, value: Patch[K], label: string) => {
    patch[key] = value;
    changed.push(label);
  };

  const email = input.email;
  if (email?.mode !== undefined) set('emailMode', email.mode, 'email.mode');
  const smtp = email?.smtp;
  if (smtp?.host !== undefined) set('smtpHost', smtp.host, 'email.smtp.host');
  if (smtp?.port !== undefined) set('smtpPort', smtp.port, 'email.smtp.port');
  if (smtp?.security !== undefined) set('smtpSecurity', smtp.security, 'email.smtp.security');
  if (smtp?.username !== undefined) set('smtpUsername', smtp.username, 'email.smtp.username');
  if (smtp?.from !== undefined) set('smtpFrom', smtp.from, 'email.smtp.from');
  if (smtp?.password !== undefined) {
    set('smtpPasswordEnc', smtp.password ? seal(smtp.password) : null, 'email.smtp.password');
    patch.smtpPasswordUpdatedAt = smtp.password ? now : null;
  }

  const push = input.push;
  if (push?.mode !== undefined) set('pushMode', push.mode, 'push.mode');
  if (push?.fcmServiceAccount !== undefined) {
    let projectId: string | null = null;
    if (push.fcmServiceAccount) {
      try {
        projectId = parseServiceAccount(push.fcmServiceAccount).project_id;
      } catch (err) {
        invalid(['push', 'fcmServiceAccount'], 'invalid_service_account', (err as Error).message);
      }
    }
    set(
      'fcmServiceAccountEnc',
      push.fcmServiceAccount ? seal(push.fcmServiceAccount) : null,
      'push.fcmServiceAccount',
    );
    patch.fcmProjectId = projectId;
    patch.fcmUpdatedAt = push.fcmServiceAccount ? now : null;
  }
  if (push?.expoAccessToken !== undefined) {
    set(
      'expoAccessTokenEnc',
      push.expoAccessToken ? seal(push.expoAccessToken) : null,
      'push.expoAccessToken',
    );
    patch.expoUpdatedAt = push.expoAccessToken ? now : null;
  }

  const notifike = input.notifike;
  if (notifike?.baseUrl !== undefined) set('notifikeBaseUrl', notifike.baseUrl, 'notifike.baseUrl');
  if (notifike?.apiKey !== undefined) {
    set('notifikeApiKeyEnc', notifike.apiKey ? seal(notifike.apiKey) : null, 'notifike.apiKey');
    patch.notifikeApiKeyHint = notifike.apiKey ? keyHint(notifike.apiKey) : null;
    patch.notifikeApiKeyUpdatedAt = notifike.apiKey ? now : null;
  }
  // A new address or key gets a fresh start; the next refusal sets the warning again.
  if (notifike?.baseUrl !== undefined || notifike?.apiKey !== undefined) {
    patch.notifikeAuthFailedAt = null;
  }

  const current = await loadDelivery(db, a.orgId);
  const next = { ...current, ...patch } as Partial<DeliveryRow>;
  const emailMode = next.emailMode ?? 'env';
  const pushMode = next.pushMode ?? 'env';
  if (emailMode === 'smtp') {
    if (!next.smtpHost) invalid(['email', 'smtp', 'host'], 'required', 'SMTP host is required');
    if (!next.smtpPort) invalid(['email', 'smtp', 'port'], 'required', 'SMTP port is required');
    if (!next.smtpFrom) invalid(['email', 'smtp', 'from'], 'required', 'sender is required');
  }
  if (pushMode === 'direct' && !next.fcmServiceAccountEnc) {
    invalid(['push', 'fcmServiceAccount'], 'required', 'a Firebase service account is required');
  }
  if (emailMode === 'notifike' || pushMode === 'notifike') {
    if (!next.notifikeBaseUrl) invalid(['notifike', 'baseUrl'], 'required', 'URL is required');
    if (!next.notifikeApiKeyEnc) invalid(['notifike', 'apiKey'], 'required', 'key is required');
  }

  if (changed.length) {
    await db
      .insert(deliverySettings)
      .values({ orgId: a.orgId, ...patch, updatedBy: a.userId })
      .onConflictDoUpdate({
        target: deliverySettings.orgId,
        set: { ...patch, updatedBy: a.userId, updatedAt: now },
      });
    await audit(
      db,
      {
        orgId: a.orgId,
        actorId: a.userId,
        action: 'org.delivery.update',
        targetType: 'org',
        targetId: a.orgId,
        // Field names only; secrets never reach the log.
        meta: { changed, emailMode, pushMode },
      },
      req,
    );
  }
  return getDeliverySettings(deps, a.orgId);
}

/**
 * Notifike refused the key (401/403): remembered until the key or address changes, shown on the
 * settings page as a warning. The first refusal is logged and audited.
 */
export async function noteNotifikeRefusal(
  deps: { db: DbOrTx; logger: Logger },
  orgId: string,
  err: NotifikeError,
) {
  if (!err.unauthorized) return;
  const first = await deps.db
    .update(deliverySettings)
    .set({ notifikeAuthFailedAt: new Date() })
    .where(and(eq(deliverySettings.orgId, orgId), isNull(deliverySettings.notifikeAuthFailedAt)))
    .returning({ orgId: deliverySettings.orgId });
  if (!first.length) return;
  deps.logger.error({ orgId, status: err.status, key: err.key }, 'notifike refused the api key');
  await audit(deps.db, {
    orgId,
    actorId: null,
    action: 'org.delivery.auth_failed',
    targetType: 'org',
    targetId: orgId,
    meta: { status: err.status, key: err.key },
  });
}

export async function storeTestResult(db: DbOrTx, orgId: string, result: DeliveryTestResult) {
  const value = result as unknown as Record<string, unknown>;
  const column = result.channel === 'email' ? { lastEmailTest: value } : { lastPushTest: value };
  await db
    .insert(deliverySettings)
    .values({ orgId, ...column })
    .onConflictDoUpdate({ target: deliverySettings.orgId, set: column });
}
