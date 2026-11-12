import { ApiError, createApiClient, type ApiClient } from '@crewhall/api-client';
import { clearConnection, getConnection, type Connection } from './storage';
import { locale } from './i18n';

export class NotConnectedError extends Error {
  constructor() {
    super('not connected');
    this.name = 'NotConnectedError';
  }
}

export function clientFor(c: Pick<Connection, 'origin' | 'token'>): ApiClient {
  return createApiClient({ baseUrl: c.origin, getToken: () => c.token, locale });
}

/** The client of the connected server. An ended session disconnects the extension. */
export async function api(): Promise<ApiClient> {
  const c = await getConnection();
  if (!c) throw new NotConnectedError();
  const client = clientFor(c);
  return {
    call: (async (...args: Parameters<ApiClient['call']>) => {
      try {
        return await client.call(...args);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'unauthenticated') await clearConnection();
        throw e;
      }
    }) as ApiClient['call'],
  };
}

/** "https://Hub.Example.com/login" or "hub.example.com" → "https://hub.example.com". */
export function normalizeOrigin(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password || !u.hostname) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** base64url without padding, as PKCE wants it. */
export function base64Url(bytes: Uint8Array): string {
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

/**
 * Signs in through the web app's confirmation page (better-auth, 2FA and passkeys stay there) and
 * returns a new session for this browser. The server only redirects to listed extension ids.
 */
export async function signIn(origin: string): Promise<Connection> {
  const { verifier, challenge } = await pkcePair();
  const redirect = chrome.identity.getRedirectURL('auth');
  const url = new URL('/mobile-login', origin);
  url.searchParams.set('challenge', challenge);
  url.searchParams.set('redirect', redirect);
  const back = await chrome.identity.launchWebAuthFlow({ url: url.href, interactive: true });
  const code = back ? new URL(back).searchParams.get('code') : null;
  if (!code) throw new Error('sign-in cancelled');
  const anonymous = createApiClient({ baseUrl: origin, locale });
  const session = await anonymous.call('exchangeMobileHandoff', {
    body: { code, codeVerifier: verifier },
  });
  const me = await clientFor({ origin, token: session.token }).call('me');
  const org =
    me.memberships.find((m) => m.orgId === me.activeOrgId)?.orgName ??
    me.memberships[0]?.orgName ??
    '';
  return {
    origin,
    token: session.token,
    userId: me.user.id,
    userName: me.user.name,
    email: me.user.email,
    orgName: org,
  };
}
