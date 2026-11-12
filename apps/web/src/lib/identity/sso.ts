import {
  ERROR_CODES,
  type ErrorCode,
  IDENTITY_RAW_PATHS,
  paths,
  withQuery,
} from '@crewhall/shared';
import { config } from '@/config';

/**
 * Browser side of SSO sign-in: a full-page navigation to the api, which redirects to the IdP
 * and back. `callbackURL` / `errorCallbackURL` are web paths; when the api lives on another
 * origin they are sent as absolute URLs so the api can send the browser back here.
 */

/** A web path as the api expects it: relative on the same origin, absolute otherwise. */
export function webTarget(path: string, apiOrigin = config.apiUrl, here = window.location.origin) {
  const sameOrigin = new URL(apiOrigin, here).origin === here;
  return sameOrigin ? path : `${here}${path}`;
}

/** `/login` with the redirect kept, so a failed SSO round trip lands on the same login. */
export function loginPath(redirect: string | undefined): string {
  return withQuery(paths.login(), { redirect });
}

export function ssoStartUrl(
  providerId: string,
  opts: { callbackPath: string; errorPath: string; loginHint?: string },
  apiOrigin = config.apiUrl,
  here = window.location.origin,
): string {
  const url = new URL(IDENTITY_RAW_PATHS.ssoStart(providerId), new URL(apiOrigin, here));
  url.searchParams.set('callbackURL', webTarget(opts.callbackPath, apiOrigin, here));
  url.searchParams.set('errorCallbackURL', webTarget(opts.errorPath, apiOrigin, here));
  if (opts.loginHint) url.searchParams.set('loginHint', opts.loginHint);
  return url.toString();
}

/**
 * Leaves for the IdP. The in-browser mock cannot answer a navigation (the service worker only
 * sees fetches), so in mock mode the start URL is fetched and the mock's answer followed.
 */
export async function startSso(url: string): Promise<void> {
  if (config.mock) {
    const res = await fetch(url, { credentials: 'include' });
    const body = (await res.json().catch(() => ({}))) as { location?: string };
    window.location.assign(body.location ?? '/login');
    return;
  }
  window.location.assign(url);
}

/** `?ssoError=<code>` from the api: a known error code, otherwise the generic SSO failure. */
export function ssoErrorCode(raw: string | undefined): ErrorCode | null {
  if (!raw) return null;
  return (ERROR_CODES as readonly string[]).includes(raw) ? (raw as ErrorCode) : 'sso_login_failed';
}
