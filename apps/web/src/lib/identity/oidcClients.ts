import {
  OIDC_SCOPES,
  type CreateOidcClientInput,
  type OidcClient,
  type OidcClientType,
  type OidcScope,
  type UpdateOidcClient,
} from '@crewhall/shared';

/** "SSO uygulamaları" form model (9.12, 9.13) and its mapping to the contract. */
export interface ClientForm {
  name: string;
  type: OidcClientType;
  homepageUrl: string;
  logoUrl: string;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  scopes: OidcScope[];
  /** 'all' or a space id. */
  access: string;
  guestsAllowed: boolean;
  skipConsent: boolean;
  secretMonths: number;
}

export const SECRET_MONTHS = [6, 12, 24] as const;

/** Secrets about to expire get a warning badge this many days ahead (9.12). */
export const SECRET_WARN_DAYS = 30;

export function emptyClientForm(): ClientForm {
  return {
    name: '',
    type: 'web',
    homepageUrl: '',
    logoUrl: '',
    redirectUris: [],
    postLogoutRedirectUris: [],
    scopes: ['openid', 'profile', 'email'],
    access: 'all',
    guestsAllowed: false,
    skipConsent: true,
    secretMonths: 12,
  };
}

export function clientToForm(c: OidcClient): ClientForm {
  return {
    name: c.name,
    type: c.type,
    homepageUrl: c.homepageUrl ?? '',
    logoUrl: c.logoUrl ?? '',
    redirectUris: [...c.redirectUris],
    postLogoutRedirectUris: [...c.postLogoutRedirectUris],
    scopes: withOpenid(c.scopes),
    access: c.access.kind === 'all' ? 'all' : c.access.spaceId,
    guestsAllowed: c.guestsAllowed,
    skipConsent: c.skipConsent,
    secretMonths: 12,
  };
}

/** `openid` is always on; scopes keep the canonical order. */
export function withOpenid(scopes: readonly OidcScope[]): OidcScope[] {
  return OIDC_SCOPES.filter((s) => s === 'openid' || scopes.includes(s));
}

const optionalUrl = (v: string) => (v.trim() ? v.trim() : null);
const access = (v: string) =>
  v === 'all' ? ({ kind: 'all' } as const) : ({ kind: 'space', spaceId: v } as const);

export function formToCreate(f: ClientForm): CreateOidcClientInput {
  return {
    name: f.name.trim(),
    type: f.type,
    homepageUrl: optionalUrl(f.homepageUrl),
    logoUrl: optionalUrl(f.logoUrl),
    redirectUris: f.redirectUris,
    postLogoutRedirectUris: f.postLogoutRedirectUris,
    scopes: withOpenid(f.scopes),
    skipConsent: f.skipConsent,
    access: access(f.access),
    guestsAllowed: f.guestsAllowed,
    ...(f.type === 'web' ? { secretMonths: f.secretMonths } : {}),
  };
}

export function formToUpdate(f: ClientForm): UpdateOidcClient {
  return {
    name: f.name.trim(),
    homepageUrl: optionalUrl(f.homepageUrl),
    logoUrl: optionalUrl(f.logoUrl),
    redirectUris: f.redirectUris,
    postLogoutRedirectUris: f.postLogoutRedirectUris,
    scopes: withOpenid(f.scopes),
    skipConsent: f.skipConsent,
    access: access(f.access),
    guestsAllowed: f.guestsAllowed,
  };
}

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

/**
 * Redirect URI rules (9.13): exact match, no wildcards, https (http only for localhost);
 * native apps may also use a private scheme such as `com.example.app:/callback`.
 * Returns why the URI is refused, or null.
 */
export function redirectUriProblem(
  uri: string,
  type: OidcClientType,
): 'empty' | 'wildcard' | 'invalid' | 'http' | 'fragment' | null {
  const v = uri.trim();
  if (!v) return 'empty';
  if (v.includes('*')) return 'wildcard';
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return 'invalid';
  }
  if (u.hash) return 'fragment';
  if (u.protocol === 'https:') return u.hostname ? null : 'invalid';
  if (u.protocol === 'http:') return LOOPBACK.includes(u.hostname) ? null : 'http';
  // Private-use scheme (RFC 8252 §7.1): reverse-domain with a dot.
  if (type === 'native' && /^[a-z][a-z0-9+.-]*\.[a-z0-9+.-]+:$/i.test(u.protocol)) return null;
  return 'invalid';
}

/** Hostname shown under the app name (homepage, else the first redirect URI). */
export function clientHost(c: Pick<OidcClient, 'homepageUrl' | 'redirectUris'>): string {
  for (const v of [c.homepageUrl, ...c.redirectUris]) {
    if (!v) continue;
    try {
      const host = new URL(v).host;
      if (host) return host;
    } catch {
      // not a URL
    }
  }
  return '';
}

/** Whole days until `iso` (negative when past). */
export function daysUntil(iso: string, now = Date.now()): number {
  return Math.ceil((new Date(iso).getTime() - now) / 86_400_000);
}

export type SecretState =
  { kind: 'none' } | { kind: 'ok' } | { kind: 'expiring'; days: number } | { kind: 'expired' };

export function secretState(c: Pick<OidcClient, 'secretExpiresAt'>, now = Date.now()): SecretState {
  if (!c.secretExpiresAt) return { kind: 'none' };
  const days = daysUntil(c.secretExpiresAt, now);
  if (days <= 0) return { kind: 'expired' };
  if (days < SECRET_WARN_DAYS) return { kind: 'expiring', days };
  return { kind: 'ok' };
}
