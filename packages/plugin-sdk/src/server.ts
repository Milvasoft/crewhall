import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import { PluginBrowserCapability, PluginPermission } from './manifest';

/**
 * Helpers for a plugin's own server (docs/contracts/eklentiler.md › Kimlik, Olaylar):
 * - requests from Crewhall (lifecycle, events, commands, tools) carry an HMAC signature made
 *   with the installation secret;
 * - the iframe hands the server a short-lived session token (EdDSA JWT) that says who the
 *   person is and what the plugin may do for them; the same token calls Crewhall's REST API.
 * Crewhall uses the signing half of these helpers, so both sides share one implementation.
 */

export const SIGNATURE_HEADER = 'crewhall-signature';
export const INSTALLATION_HEADER = 'crewhall-installation';
export const SESSION_TOKEN_TYPE = 'crewhall-plugin+jwt';
export const JWKS_PATH = '/api/plugins/v1/jwks';
/** Seconds a signed request is accepted either side of now. */
export const SIGNATURE_TOLERANCE = 300;

const utf8 = (s: string) => new TextEncoder().encode(s);
const hex = (b: ArrayBuffer) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    utf8(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, utf8(data)));
}

/** Constant-time comparison of two hex strings. */
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Requests the other way, from the plugin server to Crewhall's plugin API, are signed with
 * the same installation secret over a different string, so neither direction's signature can
 * be replayed as the other's.
 */
const TO_CREWHALL = 'to-crewhall';

/** Plugin side: headers for a signed request to Crewhall's plugin API. */
export async function signApiRequest(
  secret: string,
  installationId: string,
  body: string,
  now = Date.now(),
): Promise<Record<string, string>> {
  const t = Math.floor(now / 1000);
  return {
    'Content-Type': 'application/json',
    [SIGNATURE_HEADER]: `t=${t},v1=${await hmac(secret, `${TO_CREWHALL}.${t}.${body}`)}`,
    [INSTALLATION_HEADER]: installationId,
  };
}

/** Crewhall side: is this request really from the plugin server holding `secret`? */
export async function verifyApiRequest(input: {
  secret: string;
  body: string;
  signature: string | null | undefined;
  now?: number;
}): Promise<boolean> {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(input.signature ?? '');
  if (!m) return false;
  const t = Number(m[1]);
  if (Math.abs((input.now ?? Date.now()) / 1000 - t) > SIGNATURE_TOLERANCE) return false;
  return sameHex(await hmac(input.secret, `${TO_CREWHALL}.${t}.${input.body}`), m[2]!);
}

/** Crewhall side: headers for a signed POST to the plugin server. */
export async function signRequest(
  secret: string,
  installationId: string,
  body: string,
  now = Date.now(),
): Promise<Record<string, string>> {
  const t = Math.floor(now / 1000);
  return {
    'Content-Type': 'application/json',
    [SIGNATURE_HEADER]: `t=${t},v1=${await hmac(secret, `${t}.${body}`)}`,
    [INSTALLATION_HEADER]: installationId,
  };
}

/** Plugin side: is this request really from the installation that owns `secret`? */
export async function verifyRequest(input: {
  secret: string;
  body: string;
  signature: string | null | undefined;
  now?: number;
}): Promise<boolean> {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(input.signature ?? '');
  if (!m) return false;
  const t = Number(m[1]);
  if (Math.abs((input.now ?? Date.now()) / 1000 - t) > SIGNATURE_TOLERANCE) return false;
  return sameHex(await hmac(input.secret, `${t}.${input.body}`), m[2]!);
}

// ---- lifecycle, events, commands, tools: the bodies Crewhall posts ----

export const LifecycleRequest = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('install'),
    installationId: z.string(),
    /** The installation's API base; also the session token issuer. */
    apiUrl: z.url(),
    org: z.object({ id: z.string(), name: z.string(), domain: z.string() }),
    pluginVersion: z.string(),
    permissions: z.array(PluginPermission),
    /** Browser features the admin granted (API 32; older Crewhalls leave it out). */
    browser: z.array(PluginBrowserCapability).default([]),
    /** Keep it: every later request from this installation is signed with it. */
    secret: z.string().min(32),
  }),
  z.object({
    type: z.literal('update'),
    installationId: z.string(),
    pluginVersion: z.string(),
    permissions: z.array(PluginPermission),
    browser: z.array(PluginBrowserCapability).default([]),
  }),
  z.object({ type: z.literal('uninstall'), installationId: z.string() }),
]);
export type LifecycleRequest = z.infer<typeof LifecycleRequest>;

export const EventRequest = z.object({
  id: z.string(),
  type: z.string(),
  installationId: z.string(),
  occurredAt: z.string(),
  data: z.record(z.string(), z.unknown()),
});
export type EventRequest = z.infer<typeof EventRequest>;

export const CommandRequest = z.object({
  installationId: z.string(),
  command: z.string(),
  /** Text after `/name `. */
  args: z.string(),
  conversationId: z.string(),
  user: z.object({ id: z.string(), name: z.string() }),
  /** The person's session token, for API calls back to Crewhall. */
  token: z.string(),
  locale: z.string(),
});
export type CommandRequest = z.infer<typeof CommandRequest>;

/** What a command answers: a note only the caller sees, and/or a message posted for them. */
export const CommandResponse = z
  .object({
    reply: z.string().max(4000).optional(),
    post: z.string().max(8000).optional(),
  })
  .refine((r) => r.reply !== undefined || r.post !== undefined, 'reply or post');
export type CommandResponse = z.infer<typeof CommandResponse>;

export const ToolRequest = z.object({
  installationId: z.string(),
  tool: z.string(),
  input: z.record(z.string(), z.unknown()),
  user: z.object({ id: z.string(), name: z.string() }),
  token: z.string(),
});
export type ToolRequest = z.infer<typeof ToolRequest>;

export const ToolResponse = z.object({
  /** Shown to the assistant; keep it small. */
  content: z.unknown(),
  summary: z.string().max(200).optional(),
});
export type ToolResponse = z.infer<typeof ToolResponse>;

// ---- session tokens ----

export const SessionClaims = z.object({
  iss: z.string(),
  /** The plugin id. */
  aud: z.union([z.string(), z.array(z.string())]),
  /** The person. */
  sub: z.string(),
  org: z.string(),
  inst: z.string(),
  name: z.string(),
  email: z.string(),
  /** Space separated: the installation's permissions the person also has. */
  scope: z.string(),
  exp: z.number(),
});
export type SessionClaims = z.infer<typeof SessionClaims> & { scopes: PluginPermission[] };

const jwksCache = new Map<string, JWTVerifyGetKey>();

/**
 * Verifies a session token from the iframe. `issuer` is the installation's `apiUrl` from the
 * install request; tokens from other installations, or for another plugin, are refused.
 */
export async function verifySessionToken(
  token: string,
  opts: { issuer: string; audience: string; jwks?: JWTVerifyGetKey },
): Promise<SessionClaims> {
  const url = new URL(JWKS_PATH, opts.issuer).toString();
  let jwks = opts.jwks ?? jwksCache.get(url);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(url));
    jwksCache.set(url, jwks);
  }
  const { payload } = await jwtVerify(token, jwks, {
    issuer: opts.issuer,
    audience: opts.audience,
    typ: SESSION_TOKEN_TYPE,
    algorithms: ['EdDSA'],
  });
  const claims = SessionClaims.parse(payload);
  const scopes = claims.scope
    .split(' ')
    .filter(Boolean)
    .filter((s): s is PluginPermission => PluginPermission.safeParse(s).success);
  return { ...claims, scopes };
}

// ---- Crewhall's plugin API (server to server) ----

/** Where a plugin server posts notifications (signed with the installation secret). */
export const NOTIFICATIONS_PATH = '/api/plugins/v1/notifications';

/**
 * A notification for one person (createPluginNotification). Needs `notifications:write`, and
 * the person must have opened the plugin: a session token was issued to them for this
 * installation. Plain text only; `url` is one of the plugin's own tabs (see `pluginTabUrl`).
 */
export const PluginNotificationRequest = z.object({
  userId: z.string().min(1).max(64),
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().max(500).default(''),
  /** `/plugins/<installation>/<tab>` or `/chat/plugins/<installation>/<tab>`, plus `?…`/`#…`. */
  url: z.string().max(700).optional(),
  /** Same key, same person: the newer notification replaces the older one. */
  threadKey: z.string().trim().min(1).max(100).optional(),
});
export type PluginNotificationRequest = z.input<typeof PluginNotificationRequest>;

export const PluginNotificationResponse = z.object({
  /** The notification; null when the person turned this plugin's notifications off. */
  id: z.string().nullable(),
  /** True when it replaced an earlier notification with the same `threadKey`. */
  collapsed: z.boolean(),
  delivered: z.boolean(),
});
export type PluginNotificationResponse = z.infer<typeof PluginNotificationResponse>;

/**
 * The Crewhall path that opens a plugin tab, with a deep link the tab gets in its own URL's
 * query and fragment: `pluginTabUrl({ installationId, tab: 'chats', placement: 'chat',
 * search: { chat: '42' } })` → `/chat/plugins/<id>/chats?chat=42`.
 */
export function pluginTabUrl(input: {
  installationId: string;
  tab: string;
  placement: 'rail' | 'chat';
  search?: Record<string, string>;
  hash?: string;
}): string {
  const base = `${input.placement === 'chat' ? '/chat' : ''}/plugins/${encodeURIComponent(
    input.installationId,
  )}/${encodeURIComponent(input.tab)}`;
  const query = input.search ? new URLSearchParams(input.search).toString() : '';
  return `${base}${query ? `?${query}` : ''}${input.hash ? `#${input.hash.replace(/^#/, '')}` : ''}`;
}

/** Where a plugin server clears what it notified (the person read it in the plugin). */
export const NOTIFICATIONS_CLEAR_PATH = '/api/plugins/v1/notifications/clear';

/**
 * Clears this plugin's unread notifications for one person by the `threadKey` they were sent
 * with (a chat id, say): `read` marks them read, `dismiss` removes them from the bell. A phone
 * that already shows the push loses it too where the app supports that.
 */
export const PluginNotificationClearRequest = z.object({
  userId: z.string().min(1).max(64),
  threadKey: z.string().trim().min(1).max(100),
  action: z.enum(['read', 'dismiss']).default('read'),
});
export type PluginNotificationClearRequest = z.input<typeof PluginNotificationClearRequest>;

/** How many were still open; 0 is not an error (already read, or never sent). */
export const PluginNotificationClearResponse = z.object({ cleared: z.number().int() });
export type PluginNotificationClearResponse = z.infer<typeof PluginNotificationClearResponse>;

/** Where a plugin server gets a token for background work (signed with the installation secret). */
export const OFFLINE_TOKEN_PATH = '/api/plugins/v1/offline-token';

/**
 * A 5-minute session token for a person who granted this installation background access in
 * Crewhall's dialog. Needs `offline:access`; anyone else answers `plugin_offline_not_granted`.
 */
export const PluginOfflineTokenRequest = z.object({ userId: z.string().min(1).max(64) });
export type PluginOfflineTokenRequest = z.input<typeof PluginOfflineTokenRequest>;

export const PluginOfflineTokenResponse = z.object({ token: z.string(), expiresAt: z.string() });
export type PluginOfflineTokenResponse = z.infer<typeof PluginOfflineTokenResponse>;

export class CrewhallApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(code);
  }
}

/**
 * A plugin server's client for Crewhall's plugin API, with the values from the install
 * request (`apiUrl`, `installationId`, `secret`). No person is involved: it acts as the
 * installation, within the permissions the admin granted.
 */
export function createServerClient(opts: {
  apiUrl: string;
  installationId: string;
  secret: string;
  fetch?: typeof fetch;
}) {
  const doFetch = opts.fetch ?? fetch;
  const post = async (path: string, payload: unknown): Promise<unknown> => {
    const body = JSON.stringify(payload);
    const res = await doFetch(new URL(path, opts.apiUrl), {
      method: 'POST',
      headers: await signApiRequest(opts.secret, opts.installationId, body),
      body,
    });
    const data = (await res.json().catch(() => ({}))) as {
      code?: string;
      details?: unknown;
    };
    if (!res.ok) throw new CrewhallApiError(res.status, data.code ?? 'error', data.details);
    return data;
  };
  return {
    /** Notifies a person who opened the plugin (bell, desktop, mobile push). */
    async notify(input: PluginNotificationRequest): Promise<PluginNotificationResponse> {
      return PluginNotificationResponse.parse(
        await post(NOTIFICATIONS_PATH, PluginNotificationRequest.parse(input)),
      );
    },
    /** A session token for someone who granted background access (`offline:access`). */
    async offlineToken(userId: string): Promise<PluginOfflineTokenResponse> {
      return PluginOfflineTokenResponse.parse(
        await post(OFFLINE_TOKEN_PATH, PluginOfflineTokenRequest.parse({ userId })),
      );
    },
    /** The person read it in the plugin: clears the notifications sent with this `threadKey`. */
    async clearNotifications(
      input: PluginNotificationClearRequest,
    ): Promise<PluginNotificationClearResponse> {
      return PluginNotificationClearResponse.parse(
        await post(NOTIFICATIONS_CLEAR_PATH, PluginNotificationClearRequest.parse(input)),
      );
    },
  };
}
