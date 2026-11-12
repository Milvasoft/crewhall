import { readFileSync } from 'node:fs';
import { connect, constants, type ClientHttp2Session } from 'node:http2';
import { importPKCS8, SignJWT } from 'jose';
import type { VoipPush } from '@crewhall/shared';
import type { Env } from '../../env';

/**
 * Apple Push Notification service, straight over HTTP/2 (Expo does not send VoIP pushes). Token
 * auth: an ES256 JWT signed with the .p8 key, renewed every 50 minutes (Apple wants 20-60). One
 * HTTP/2 session per origin stays open between sends, as Apple asks. The key is never logged.
 */

/** Development builds get sandbox tokens, TestFlight and App Store builds production ones. */
export type ApnsEnvironment = 'production' | 'sandbox';

export interface ApnsConfig {
  origins: Record<ApnsEnvironment, string>;
  /** For devices that did not say which build they are (APNS_ENV). */
  defaultEnvironment: ApnsEnvironment;
  keyP8: string;
  keyId: string;
  teamId: string;
  bundleId: string;
}

const ORIGINS = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
} as const;
const JWT_TTL_MS = 50 * 60_000;
const SEND_TIMEOUT_MS = 10_000;

let keyCache: { source: string; key: string } | null = null;
const jwtCache = new Map<string, { jwt: string; at: number }>();
const sessions = new Map<string, ClientHttp2Session>();

/** Tests: forget the key, JWTs and open sessions. */
export function resetApns() {
  keyCache = null;
  jwtCache.clear();
  for (const s of sessions.values()) s.close();
  sessions.clear();
}

/** The server's APNs setup, or null when any part is missing (VoIP pushes are off). */
export function apnsConfig(env: Env): ApnsConfig | null {
  const source = env.APNS_KEY_P8 ?? env.APNS_KEY_PATH;
  if (!source || !env.APNS_KEY_ID || !env.APNS_TEAM_ID || !env.APNS_BUNDLE_ID) return null;
  let key = keyCache?.source === source ? keyCache.key : null;
  if (!key) {
    try {
      key = env.APNS_KEY_P8
        ? env.APNS_KEY_P8.replace(/\\n/g, '\n')
        : readFileSync(env.APNS_KEY_PATH!, 'utf8');
    } catch {
      throw new Error('APNS_KEY_PATH cannot be read');
    }
    keyCache = { source, key };
  }
  return {
    origins: {
      production: env.APNS_URL ?? ORIGINS.production,
      sandbox: env.APNS_SANDBOX_URL ?? ORIGINS.sandbox,
    },
    defaultEnvironment: env.APNS_ENV,
    keyP8: key,
    keyId: env.APNS_KEY_ID,
    teamId: env.APNS_TEAM_ID,
    bundleId: env.APNS_BUNDLE_ID,
  };
}

async function providerToken(cfg: ApnsConfig, now = Date.now()) {
  const cacheKey = `${cfg.teamId}:${cfg.keyId}`;
  const hit = jwtCache.get(cacheKey);
  if (hit && now - hit.at < JWT_TTL_MS) return hit.jwt;
  const key = await importPKCS8(cfg.keyP8, 'ES256');
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: cfg.keyId })
    .setIssuer(cfg.teamId)
    .setIssuedAt(Math.floor(now / 1000))
    .sign(key);
  jwtCache.set(cacheKey, { jwt, at: now });
  return jwt;
}

function session(origin: string): ClientHttp2Session {
  const open = sessions.get(origin);
  if (open && !open.closed && !open.destroyed) return open;
  const s = connect(origin);
  // A broken session is dropped; the next send opens a new one.
  const drop = () => {
    if (sessions.get(origin) === s) sessions.delete(origin);
  };
  s.on('error', drop);
  s.on('close', drop);
  s.on('goaway', drop);
  s.unref();
  sessions.set(origin, s);
  return s;
}

/** 429 and 5xx: the send may be retried. */
export class ApnsTransientError extends Error {
  override name = 'ApnsTransientError';
}

/** disable: the token is gone for good (410 Unregistered, BadDeviceToken, wrong topic). */
export type ApnsResult = { ok: true } | { ok: false; disable: boolean; reason: string };

const DEAD_TOKEN = new Set(['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered']);

/**
 * A VoIP push to a device whose build may be unknown: its own environment, or APNS_ENV. Apple
 * answers BadDeviceToken for a token sent to the other environment, so with an unknown build that
 * answer is tried once on the other host before the token counts as dead. `environment` is where
 * it was sent last (the one that worked, when it did).
 */
export async function sendVoipTo(
  cfg: ApnsConfig,
  device: { token: string; apnsEnvironment: ApnsEnvironment | null },
  payload: VoipPush,
  expiresAt: Date,
): Promise<{ result: ApnsResult; environment: ApnsEnvironment }> {
  const first = device.apnsEnvironment ?? cfg.defaultEnvironment;
  const result = await sendVoip(cfg, device.token, payload, expiresAt, first);
  if (result.ok || device.apnsEnvironment || result.reason !== 'BadDeviceToken') {
    return { result, environment: first };
  }
  const other: ApnsEnvironment = first === 'production' ? 'sandbox' : 'production';
  return {
    result: await sendVoip(cfg, device.token, payload, expiresAt, other),
    environment: other,
  };
}

/** One VoIP push; `expiresAt` stops APNs from delivering a ring that is over. */
export async function sendVoip(
  cfg: ApnsConfig,
  deviceToken: string,
  payload: VoipPush,
  expiresAt: Date,
  environment: ApnsEnvironment = cfg.defaultEnvironment,
): Promise<ApnsResult> {
  const origin = cfg.origins[environment];
  const jwt = await providerToken(cfg);
  const body = JSON.stringify(payload);
  const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    let req;
    try {
      req = session(origin).request({
        [constants.HTTP2_HEADER_METHOD]: 'POST',
        [constants.HTTP2_HEADER_PATH]: `/3/device/${deviceToken}`,
        authorization: `bearer ${jwt}`,
        'apns-push-type': 'voip',
        'apns-topic': `${cfg.bundleId}.voip`,
        'apns-priority': '10',
        'apns-expiration': String(Math.floor(expiresAt.getTime() / 1000)),
        // A later push of the same call (the end) replaces a ring still waiting in APNs.
        'apns-collapse-id': payload.callId,
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
      });
    } catch (err) {
      reject(new ApnsTransientError(err instanceof Error ? err.message : 'apns connect failed'));
      return;
    }
    let status = 0;
    let text = '';
    req.setTimeout(SEND_TIMEOUT_MS, () => req.close(constants.NGHTTP2_CANCEL));
    req.on('response', (h) => {
      status = Number(h[constants.HTTP2_HEADER_STATUS]);
    });
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      text += chunk;
    });
    req.on('end', () => resolve({ status, body: text }));
    req.on('close', () => {
      if (!status) reject(new ApnsTransientError('apns request closed without an answer'));
    });
    req.on('error', (err) => reject(new ApnsTransientError(err.message)));
    req.end(body);
  });
  if (res.status === 200) return { ok: true };
  let reason = `http_${res.status}`;
  try {
    const parsed = JSON.parse(res.body) as { reason?: unknown };
    if (typeof parsed.reason === 'string') reason = parsed.reason;
  } catch {
    /* no JSON body */
  }
  if (res.status === 429 || res.status >= 500) throw new ApnsTransientError(reason);
  return { ok: false, disable: res.status === 410 || DEAD_TOKEN.has(reason), reason };
}
