import { createHash, randomBytes } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import { decodeJwt } from 'jose';
import { z } from 'zod';
import { calendarOauthStates, type DbOrTx } from '@crewhall/db';
import type { Env } from '../../../env';
import { AppError } from '../../../http/errors';
import { calendarFetch } from './http';
import { oauthRedirectUri, requireClient, type Provider } from './integrations';
import { openSecret, sealSecret } from './secrets';

/**
 * OAuth2 authorization code + PKCE (S256) for Google Calendar and Microsoft Graph. Crewhall is a
 * confidential client registered by the org admin; the refresh token keeps sync running.
 */

interface Endpoints {
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  extra: Record<string, string>;
}

/**
 * `contacts`: also the address book. A refresh must ask for what was granted, not for more
 * (Entra refuses it as if the grant had been withdrawn), so accounts connected without it stay
 * on the calendar scope until the person connects again.
 */
export function endpoints(provider: Provider, tenant: string | null, contacts = false): Endpoints {
  if (provider === 'microsoft') {
    const t = encodeURIComponent(tenant || 'common');
    return {
      authorizeUrl: `https://login.microsoftonline.com/${t}/oauth2/v2.0/authorize`,
      tokenUrl: `https://login.microsoftonline.com/${t}/oauth2/v2.0/token`,
      scope: `openid email offline_access https://graph.microsoft.com/Calendars.ReadWrite${
        contacts ? ' https://graph.microsoft.com/Contacts.ReadWrite' : ''
      }`,
      extra: { prompt: 'select_account' },
    };
  }
  return {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: [
      'openid',
      'email',
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    ].join(' '),
    // Without these Google returns no refresh token on later sign-ins.
    extra: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
  };
}

const STATE_TTL_MS = 10 * 60 * 1000;
const hash = (v: string) => createHash('sha256').update(v).digest('hex');

/** Authorization URL for a browser redirect; the state row lives ten minutes. */
export async function startUrl(
  db: DbOrTx,
  env: Pick<Env, 'AUTH_SECRET' | 'API_URL'>,
  orgId: string,
  user: { id: string; email: string },
  provider: Provider,
): Promise<string> {
  const client = await requireClient(db, env, orgId, provider);
  const ep = endpoints(provider, client.tenant, client.contactsSync);
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  await db.delete(calendarOauthStates).where(lt(calendarOauthStates.expiresAt, new Date()));
  await db.insert(calendarOauthStates).values({
    stateHash: hash(state),
    orgId,
    userId: user.id,
    provider,
    codeVerifierEnc: sealSecret(env.AUTH_SECRET, verifier),
    expiresAt: new Date(Date.now() + STATE_TTL_MS),
  });
  const url = new URL(ep.authorizeUrl);
  const params: Record<string, string> = {
    client_id: client.id,
    response_type: 'code',
    redirect_uri: oauthRedirectUri(env),
    scope: ep.scope,
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    login_hint: user.email,
    ...ep.extra,
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

const TokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.coerce.number().int().positive().default(3600),
  id_token: z.string().optional(),
  scope: z.string().optional(),
});

export interface Tokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  email: string | null;
  /** Microsoft: the token also reads and writes the address book. */
  contactsGranted?: boolean;
}

/** invalid_grant: the refresh token was withdrawn (or the code was already used). */
export class OauthGrantError extends Error {}

async function tokenRequest(url: string, form: Record<string, string>): Promise<Tokens> {
  let res: Response;
  try {
    res = await calendarFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new AppError('calendar_external_failed', { reason: 'unreachable' });
  }
  const json: unknown = await res.json().catch(() => null);
  const parsed = TokenResponse.safeParse(json);
  if (!res.ok || !parsed.success) {
    const err = (json as { error?: unknown } | null)?.error;
    if (err === 'invalid_grant') throw new OauthGrantError('invalid_grant');
    throw new AppError('calendar_oauth_failed', {
      reason: typeof err === 'string' ? err : `http_${res.status}`,
    });
  }
  const t = parsed.data;
  let email: string | null = null;
  if (t.id_token) {
    // Straight from the token endpoint over TLS, so the signature check is not needed
    // (OpenID Connect Core 3.1.3.7); only the address is read.
    try {
      const claims = decodeJwt(t.id_token);
      const raw = claims.email ?? claims.preferred_username ?? claims.upn;
      email = typeof raw === 'string' && raw.includes('@') ? raw.toLowerCase() : null;
    } catch {
      email = null;
    }
  }
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? null,
    expiresAt: new Date(Date.now() + t.expires_in * 1000),
    email,
    // The answer names the scopes when they differ from the request; otherwise they are the same.
    contactsGranted: /contacts\.readwrite/i.test(t.scope ?? form.scope ?? ''),
  };
}

/** Exchanges the callback's code; the state must belong to this user and org. */
export async function finishOauth(
  db: DbOrTx,
  env: Pick<Env, 'AUTH_SECRET' | 'API_URL'>,
  orgId: string,
  userId: string,
  input: { code: string; state: string },
): Promise<{ provider: Provider; tokens: Tokens }> {
  const [row] = await db
    .delete(calendarOauthStates)
    .where(
      and(
        eq(calendarOauthStates.stateHash, hash(input.state)),
        eq(calendarOauthStates.orgId, orgId),
        eq(calendarOauthStates.userId, userId),
      ),
    )
    .returning();
  if (!row || row.expiresAt.getTime() < Date.now()) {
    throw new AppError('calendar_oauth_failed', { reason: 'state' });
  }
  const verifier = openSecret(env.AUTH_SECRET, row.codeVerifierEnc);
  if (!verifier) throw new AppError('calendar_oauth_failed', { reason: 'state' });
  const client = await requireClient(db, env, orgId, row.provider);
  try {
    const ep = endpoints(row.provider, client.tenant, client.contactsSync);
    const tokens = await tokenRequest(ep.tokenUrl, {
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: oauthRedirectUri(env),
      client_id: client.id,
      client_secret: client.secret,
      code_verifier: verifier,
      ...(row.provider === 'microsoft' ? { scope: ep.scope } : {}),
    });
    return { provider: row.provider, tokens };
  } catch (err) {
    if (err instanceof OauthGrantError)
      throw new AppError('calendar_oauth_failed', { reason: 'invalid_grant' });
    throw err;
  }
}

export async function refreshTokens(
  db: DbOrTx,
  env: Pick<Env, 'AUTH_SECRET'>,
  orgId: string,
  provider: Provider,
  refreshToken: string,
  contactsGranted = false,
): Promise<Tokens> {
  const client = await requireClient(db, env, orgId, provider);
  const ep = endpoints(provider, client.tenant, contactsGranted);
  return tokenRequest(ep.tokenUrl, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: client.id,
    client_secret: client.secret,
    ...(provider === 'microsoft' ? { scope: ep.scope } : {}),
  });
}
