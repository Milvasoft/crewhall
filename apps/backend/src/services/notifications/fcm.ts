import { readFileSync } from 'node:fs';
import { importPKCS8, SignJWT } from 'jose';
import { z } from 'zod';
import { MEET_CALL_PUSH, type PushData } from '@crewhall/shared';
import type { Env } from '../../env';

/**
 * Firebase Cloud Messaging, HTTP v1 (projects/{id}/messages:send), with an OAuth access token
 * minted from the service account (JWT bearer grant) and cached until shortly before it
 * expires. The service account comes from FIREBASE_SERVICE_ACCOUNT_JSON or _FILE, or from the
 * org's own delivery settings (services/delivery), and is never logged.
 */

const ServiceAccount = z.object({
  project_id: z.string().min(1),
  client_email: z.string().min(1),
  private_key: z.string().min(1),
  token_uri: z.url().default('https://oauth2.googleapis.com/token'),
});
export type ServiceAccount = z.infer<typeof ServiceAccount>;

/** Where to send: the FCM API and the service account that signs for it (null: not set up). */
export interface FcmTarget {
  apiUrl: string;
  account: ServiceAccount | null;
}

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
/** Renew this long before the token's expiry. */
const EARLY_MS = 60_000;

let accountCache: { source: string; account: ServiceAccount } | null = null;
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/** Tests: forget the parsed account and cached tokens. */
export function resetFcmCache() {
  accountCache = null;
  tokenCache.clear();
}

/** The configured service account, or null when FCM is not set up. */
export function fcmAccount(env: Env): ServiceAccount | null {
  const source = env.FIREBASE_SERVICE_ACCOUNT_JSON ?? env.FIREBASE_SERVICE_ACCOUNT_FILE;
  if (!source) return null;
  if (accountCache?.source === source) return accountCache.account;
  let raw: string;
  try {
    raw =
      env.FIREBASE_SERVICE_ACCOUNT_JSON ?? readFileSync(env.FIREBASE_SERVICE_ACCOUNT_FILE!, 'utf8');
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_FILE cannot be read');
  }
  const account = parseServiceAccount(raw);
  accountCache = { source, account };
  return account;
}

/** The server's own FCM: FCM_API_URL and FIREBASE_SERVICE_ACCOUNT_*. */
export function envFcm(env: Env): FcmTarget {
  return { apiUrl: env.FCM_API_URL, account: fcmAccount(env) };
}

/** A service account JSON file's content; errors name the missing fields, never values. */
export function parseServiceAccount(raw: string): ServiceAccount {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error('the Firebase service account is not valid JSON');
  }
  const parsed = ServiceAccount.safeParse(json);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`the Firebase service account lacks: ${fields}`);
  }
  return parsed.data;
}

async function accessToken(account: ServiceAccount): Promise<string> {
  const hit = tokenCache.get(account.client_email);
  if (hit && hit.expiresAt - EARLY_MS > Date.now()) return hit.token;
  const key = await importPKCS8(account.private_key, 'RS256');
  const assertion = await new SignJWT({ scope: SCOPE })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(account.client_email)
    .setSubject(account.client_email)
    .setAudience(account.token_uri)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);
  const res = await fetch(account.token_uri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new FcmTransientError(`token endpoint answered ${res.status}`);
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new FcmTransientError('token endpoint gave no access_token');
  const expiresAt = Date.now() + (body.expires_in ?? 3600) * 1000;
  tokenCache.set(account.client_email, { token: body.access_token, expiresAt });
  return body.access_token;
}

/** 429, 5xx, network: the job should run again (pg-boss retries). */
export class FcmTransientError extends Error {
  override name = 'FcmTransientError';
}

export interface FcmMessage {
  title: string;
  body: string;
  data: PushData;
  /** Critical alerts: alert channel, time-sensitive on iOS. */
  urgent: boolean;
}

/** Channel and sound per notification: calls ring with the call melody, urgent ones alert. */
export function pushSound(type: string, urgent: boolean): { channel: string; sound: string } {
  if (type === 'meet.call') {
    return { channel: MEET_CALL_PUSH.androidChannel, sound: MEET_CALL_PUSH.sound };
  }
  return { channel: urgent ? 'alerts' : 'default', sound: 'default' };
}

export type FcmResult =
  { ok: true } | { ok: false; disable: boolean; error: string; detail?: string };

interface FcmError {
  error?: {
    status?: string;
    message?: string;
    details?: {
      '@type'?: string;
      errorCode?: string;
      fieldViolations?: { field?: string; description?: string }[];
    }[];
  };
}

/** Token no longer valid for this app: stop sending to it. */
const DEAD = new Set(['UNREGISTERED', 'NOT_FOUND', 'SENDER_ID_MISMATCH']);

/**
 * FCM answers INVALID_ARGUMENT for a bad token and for a bad message alike. Only the first says
 * anything about the device: a message FCM refuses must not silence the phone for good.
 */
function badToken(error: NonNullable<FcmError['error']>) {
  return (
    error.details?.some((d) => d.fieldViolations?.some((v) => v.field === 'message.token')) ===
      true || /registration token/i.test(error.message ?? '')
  );
}

/**
 * One device. Returns `disable: true` for dead tokens; throws FcmTransientError when a
 * retry may succeed (429, 5xx, network, an access token that keeps failing).
 */
export async function sendFcm(
  target: FcmTarget,
  token: string,
  message: FcmMessage,
): Promise<FcmResult> {
  const tone = pushSound(message.data.type, message.urgent);
  return postFcm(target, {
    message: {
      token,
      notification: { title: message.title, body: message.body },
      // FCM data values must be strings.
      data: {
        url: message.data.url,
        notificationId: message.data.notificationId,
        type: message.data.type,
        ...(message.data.callId ? { callId: message.data.callId } : {}),
        ...(message.data.tag ? { tag: message.data.tag } : {}),
      },
      android: {
        priority: 'HIGH',
        notification: {
          channel_id: tone.channel,
          // Android names a res/raw sound without its extension.
          sound: tone.sound.replace(/\.wav$/, ''),
          // A newer one replaces it in the tray; `notification.clear` removes it by this tag.
          ...(message.data.tag ? { tag: message.data.tag } : {}),
        },
      },
      // APNs goes through FCM once the APNs key is uploaded to Firebase.
      apns: {
        headers: {
          'apns-priority': '10',
          ...(message.data.tag ? { 'apns-collapse-id': message.data.tag } : {}),
        },
        payload: {
          aps: {
            sound: tone.sound,
            ...(message.urgent ? { 'interruption-level': 'time-sensitive' } : {}),
          },
        },
      },
    },
  });
}

/**
 * Android app versions that ring an incoming call from a data-only message: the app shows its
 * own full-screen call (lock screen, accept and decline) instead of a system notification.
 */
export const DATA_CALL_MIN_VERSION = '0.2.0';

/** `version` (semver, `1.2.3` or `1.2.3-x`) is at least `min`; a missing version is not. */
export function versionAtLeast(version: string | null | undefined, min: string): boolean {
  if (!version) return false;
  const parse = (v: string) =>
    v
      .split('-')[0]!
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const a = parse(version);
  const b = parse(min);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

/**
 * A data-only message (no notification block): the app's own messaging service handles it,
 * even when the app is closed. Values must be strings; `ttlSeconds` drops it once stale.
 */
export async function sendFcmData(
  target: FcmTarget,
  token: string,
  data: Record<string, string>,
  ttlSeconds: number,
): Promise<FcmResult> {
  return postFcm(target, {
    message: {
      token,
      data,
      android: { priority: 'HIGH', ttl: `${ttlSeconds}s` },
      // iOS wakes the app only for a background push (and may hold it back).
      apns: {
        headers: { 'apns-push-type': 'background', 'apns-priority': '5' },
        payload: { aps: { 'content-available': 1 } },
      },
    },
  });
}

async function postFcm(target: FcmTarget, payload: unknown): Promise<FcmResult> {
  const account = target.account;
  if (!account) return { ok: false, disable: false, error: 'fcm_not_configured' };
  const url = `${target.apiUrl.replace(/\/$/, '')}/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`;
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await accessToken(account)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      if (err instanceof FcmTransientError) throw err;
      throw new FcmTransientError('FCM unreachable');
    }
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => ({}))) as FcmError;
    const status = body.error?.status ?? '';
    const code = body.error?.details?.find((d) => d.errorCode)?.errorCode ?? '';
    if (res.status === 401 && attempt === 0) {
      // Revoked or expired early: mint a new token once.
      tokenCache.delete(account.client_email);
      continue;
    }
    if (res.status === 429 || res.status >= 500 || res.status === 401) {
      throw new FcmTransientError(`FCM answered ${res.status} ${code || status}`);
    }
    return {
      ok: false,
      disable:
        DEAD.has(code) ||
        DEAD.has(status) ||
        (status === 'INVALID_ARGUMENT' && !!body.error && badToken(body.error)),
      error: code || status || `http_${res.status}`,
      ...(body.error?.message ? { detail: body.error.message } : {}),
    };
  }
  throw new FcmTransientError('FCM kept rejecting the access token');
}
