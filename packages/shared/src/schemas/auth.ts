import { z } from 'zod';
import { Timestamp } from './common';

/**
 * Account lockout (design 01 · 1.2, 1.16). Wrong passwords, TOTP codes and backup codes
 * share one per-account counter; passkey sign-in is never blocked by the lock.
 */
export const AUTH_LOCK = {
  maxFailures: 5,
  /** `remainingAttempts` is only returned once this many or fewer are left. */
  showRemainingAt: 3,
  /** Consecutive locks double: 15 → 30 → 60 minutes (capped). */
  lockMinutes: [15, 30, 60],
} as const;

/**
 * Error body of the better-auth endpoints we extend (`/api/auth/sign-in/email`,
 * `/api/auth/two-factor/verify-totp`, `/api/auth/two-factor/verify-backup-code`).
 * - 401 `INVALID_EMAIL_OR_PASSWORD` / `INVALID_CODE` (+ `remainingAttempts` when ≤ 3 left)
 * - 423 `ACCOUNT_LOCKED` (+ `lockedUntil`, `lastFailedAt`, `lastFailedIp`)
 * The wording never reveals whether the account exists: unknown e-mails get the same body.
 */
export const AuthFailureBody = z.object({
  code: z.string(),
  message: z.string(),
  remainingAttempts: z.number().int().min(0).optional(),
  lockedUntil: Timestamp.optional(),
  lastFailedAt: Timestamp.optional(),
  lastFailedIp: z.string().optional(),
});
export type AuthFailureBody = z.infer<typeof AuthFailureBody>;

/**
 * Backup codes are 8 characters, case-insensitive, dash optional (design 01 · 1.4).
 * Displayed as `XXXX-XXXX`; compare after normalising both sides.
 */
export function normalizeBackupCode(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

export function formatBackupCode(code: string): string {
  const c = normalizeBackupCode(code);
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

/* ------------------------------------------------------------------ */
/* Mobile connect QR (design 12.3): web shows it, the app scans it.    */
/* It carries the server address and a 5-minute single-use token that */
/* only pre-fills the e-mail; the password (and 2FA) is still asked.  */
/* ------------------------------------------------------------------ */

export const MOBILE_CONNECT_TTL_SECONDS = 300;

export const MobileConnectTicket = z.object({
  /** `crewhall://connect?server=<origin>&token=<token>`: render this string as the QR. */
  url: z.string(),
  expiresAt: Timestamp,
});
export type MobileConnectTicket = z.infer<typeof MobileConnectTicket>;

export const MobileConnectPreview = z.object({
  email: z.email(),
  name: z.string(),
  orgName: z.string(),
});
export type MobileConnectPreview = z.infer<typeof MobileConnectPreview>;

export interface ConnectLink {
  server: string;
  token: string | null;
}

// No URL / URLSearchParams globals here: this package also runs where they are missing
// or incomplete (plain TS libs, React Native), so links are handled as strings.

const ORIGIN_RE = /^(https?):\/\/([^/?#\s@\\]+)(?:[/?#].*)?$/i;

/** `https://host[:port]` of an http(s) address, lower-cased; null when it is not one. */
export function httpOrigin(address: string): string | null {
  const m = ORIGIN_RE.exec(address.trim());
  return m ? `${m[1]!.toLowerCase()}://${m[2]!.toLowerCase()}` : null;
}

function parseQuery(query: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const i = pair.indexOf('=');
    const key = i < 0 ? pair : pair.slice(0, i);
    const value = i < 0 ? '' : pair.slice(i + 1);
    try {
      const decode = (part: string) => decodeURIComponent(part.replace(/\+/g, ' '));
      out.set(decode(key), decode(value));
    } catch {
      // ignore malformed escapes
    }
  }
  return out;
}

/** Build the QR payload. `server` is the public web origin (HUB_URL). */
export function buildConnectUrl(server: string, token: string): string {
  const origin = httpOrigin(server);
  if (!origin) throw new Error(`Not an http(s) address: ${server}`);
  return `crewhall://connect?server=${encodeURIComponent(origin)}&token=${encodeURIComponent(token)}`;
}

/**
 * Parse a scanned QR. Accepts the `crewhall://connect?...` link and, for convenience,
 * a bare http(s) server address (token null). Returns null for anything else.
 */
export function parseConnectUrl(raw: string): ConnectLink | null {
  const text = raw.trim();
  const prefix = 'crewhall://connect?';
  if (text.toLowerCase().startsWith(prefix)) {
    const params = parseQuery(text.slice(prefix.length).split('#')[0]!);
    const server = httpOrigin(params.get('server') ?? '');
    if (!server) return null;
    return { server, token: params.get('token') || null };
  }
  const server = httpOrigin(text);
  return server ? { server, token: null } : null;
}

/* ------------------------------------------------------------------ */
/* Mobile browser sign-in (passkey decision, docs/contracts/          */
/* faz-0-kapanis.md). The app opens `<server>/mobile-login` in the    */
/* system browser auth session with a PKCE challenge; the web signs   */
/* in (password+2FA or passkey), asks for a one-time code and         */
/* redirects to `redirectUri?code=`; the app exchanges code+verifier  */
/* for a bearer session token.                                        */
/* ------------------------------------------------------------------ */

export const MOBILE_HANDOFF_TTL_SECONDS = 60;

/** Schemes the handoff may redirect to (production app, Expo Go in development). */
export const MOBILE_REDIRECT_SCHEMES = ['crewhall:', 'exp:'] as const;

/**
 * Expo Go opens any project at the host an `exp://` link names, so anyone who can get a person to
 * follow a link could receive their code. A production server never redirects there.
 */
const DEVELOPMENT_ONLY_REDIRECT_SCHEMES: readonly string[] = ['exp:'];

/** What decides where a code may go; the shared package cannot see the deployment by itself. */
export interface RedirectPolicy {
  production: boolean;
}

/**
 * Browser extensions allowed to sign in through the handoff. A redirect to
 * `https://<id>.chromiumapp.org/` only ever reaches the extension with that id, so listing the
 * ids keeps any other installed extension from asking for a session. A fork adds its own id here.
 */
export const BROWSER_EXTENSION_IDS = [
  'bcnejndkjdeadlbmjmmgpdnpfdmngnaj', // Chrome Web Store
  'giohfeehjcadcpdlojgobdhhklkmnkci', // local builds (the key in src/manifest.ts)
] as const;

export const MobileHandoffRequest = z.object({
  /** base64url(SHA-256(codeVerifier)), method S256 only. */
  codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  redirectUri: z.string().max(512),
});
export type MobileHandoffRequest = z.infer<typeof MobileHandoffRequest>;

export const MobileHandoffCode = z.object({
  code: z.string(),
  expiresAt: Timestamp,
});
export type MobileHandoffCode = z.infer<typeof MobileHandoffCode>;

export const MobileHandoffExchange = z.object({
  code: z.string(),
  /** 43-128 chars, RFC 7636 alphabet. */
  codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
});
export type MobileHandoffExchange = z.infer<typeof MobileHandoffExchange>;

export const MobileHandoffSession = z.object({
  /** Bearer session token, same as better-auth's `set-auth-token` for the bearer plugin. */
  token: z.string(),
  expiresAt: Timestamp,
});
export type MobileHandoffSession = z.infer<typeof MobileHandoffSession>;

/* ------------------------------------------------------------------ */
/* Connecting a Google or Microsoft mail or calendar account from the */
/* app. The provider flow runs in the system browser, which has no    */
/* web session: the app asks for a one-time link, the browser opens   */
/* it (OAUTH_HANDOFF_RAW_PATHS.open), the api starts the provider     */
/* flow for that person, and the callback returns to                  */
/* `<redirectUri>?url=<app path>` (the mail or calendar page, with      */
/* `connected` or `error` like the web).                              */
/* ------------------------------------------------------------------ */

export const OAUTH_HANDOFF_TTL_SECONDS = 120;

export const OAUTH_HANDOFF_RAW_PATHS = {
  /** GET, system browser: `?code=`; once, within OAUTH_HANDOFF_TTL_SECONDS; 410 after. */
  open: '/api/oauth/handoff',
} as const;

export const OAuthHandoffPurpose = z.enum(['mail', 'calendar']);
export type OAuthHandoffPurpose = z.infer<typeof OAuthHandoffPurpose>;

export const CreateOAuthHandoff = z
  .object({
    purpose: OAuthHandoffPurpose,
    /** Calendar: which account to connect. Mail uses the org's provider (Yönetim › Posta). */
    provider: z.enum(['google', 'microsoft']).optional(),
    /**
     * Where the browser returns, e.g. `crewhall://open` (MOBILE_REDIRECT_SCHEMES only). The server
     * applies its RedirectPolicy on top of this check.
     */
    redirectUri: z.string().max(512),
  })
  .refine((v) => v.purpose !== 'calendar' || v.provider !== undefined, {
    message: 'calendar needs a provider',
    path: ['provider'],
  })
  .refine((v) => isAllowedMobileRedirect(v.redirectUri), {
    message: 'redirectUri scheme not allowed',
    path: ['redirectUri'],
  });
export type CreateOAuthHandoff = z.infer<typeof CreateOAuthHandoff>;

export const OAuthHandoff = z.object({
  /** Open in the system browser (not a web view): the provider's sign-in runs there. */
  url: z.string(),
  expiresAt: Timestamp,
});
export type OAuthHandoff = z.infer<typeof OAuthHandoff>;

/** The id of a listed browser extension when `uri` is its sign-in redirect, else null. */
export function browserExtensionOf(uri: string): string | null {
  const id = /^https:\/\/([a-p]{32})\.chromiumapp\.org\/[^\s?#]*$/.exec(uri.trim())?.[1];
  return id && (BROWSER_EXTENSION_IDS as readonly string[]).includes(id) ? id : null;
}

/** True when `uri` may receive a sign-in handoff code (the apps and the browser extension). */
export function isAllowedHandoffRedirect(uri: string, policy: RedirectPolicy): boolean {
  return isAllowedMobileRedirect(uri, policy) || browserExtensionOf(uri) !== null;
}

/**
 * True when `uri` uses one of the app's schemes. Without a policy this only checks the shape, for
 * an app asking about its own address; whoever hands out a code passes the policy.
 */
export function isAllowedMobileRedirect(uri: string, policy?: RedirectPolicy): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*:)\/\/\S*$/i.exec(uri.trim())?.[1]?.toLowerCase();
  if (!scheme || !(MOBILE_REDIRECT_SCHEMES as readonly string[]).includes(scheme)) return false;
  return !policy?.production || !DEVELOPMENT_ONLY_REDIRECT_SCHEMES.includes(scheme);
}
