import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { PortalSiteSettingsData } from '@crewhall/db';
import type { Env } from '../../env';
import { AppError } from '../../http/errors';
import { loadSite, requireEdit, type PortalActor } from './access';
import type { DbOrTx } from '@crewhall/db';

/** Preview links live one hour (design 11.13). */
export const PREVIEW_TTL_MS = 60 * 60 * 1000;

const key = (env: Pick<Env, 'AUTH_SECRET'>) =>
  createHash('sha256').update(`${env.AUTH_SECRET}:portal-preview`).digest();

interface PreviewClaims {
  s: string;
  u: string;
  e: number;
}

export function signPreview(env: Pick<Env, 'AUTH_SECRET'>, claims: PreviewClaims) {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = createHmac('sha256', key(env)).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/** The site id the token was issued for, or null when invalid or expired. */
export function verifyPreview(env: Pick<Env, 'AUTH_SECRET'>, token: string | undefined | null) {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', key(env)).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString()) as PreviewClaims;
    if (typeof claims.s !== 'string' || typeof claims.e !== 'number' || claims.e < Date.now())
      return null;
    return claims.s;
  } catch {
    return null;
  }
}

/** "Önizle": a signed one-hour link to the site's preview endpoint. */
export async function createPreview(
  db: DbOrTx,
  env: Pick<Env, 'AUTH_SECRET'>,
  a: PortalActor,
  siteId: string,
  path: string,
) {
  requireEdit(a);
  const site = await loadSite(db, a, siteId);
  const settings = site.settings as PortalSiteSettingsData;
  const base =
    settings.previewUrl ?? (settings.url ? `${settings.url.replace(/\/$/, '')}/api/preview` : null);
  if (!base) throw new AppError('invalid_target', { reason: 'preview_url_missing' });
  const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS);
  const token = signPreview(env, { s: site.id, u: a.userId, e: expiresAt.getTime() });
  const url = new URL(base);
  url.searchParams.set('token', token);
  url.searchParams.set('path', path);
  return { url: url.toString(), expiresAt: expiresAt.toISOString() };
}
