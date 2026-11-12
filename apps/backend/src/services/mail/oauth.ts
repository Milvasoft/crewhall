import { createHash, randomBytes } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import { decodeJwt } from 'jose';
import { z } from 'zod';
import { mailOauthStates, type DbOrTx } from '@crewhall/db';
import type { MailAuthMode } from '@crewhall/shared';
import type { Env } from '../../env';
import { AppError } from '../../http/errors';
import { openSecret, sealSecret } from './crypto';
import { oauthRedirectUri, type MailSettingsRow } from './settings';

/**
 * OAuth2 for Microsoft 365 and Google Workspace mailboxes (authorization code + PKCE S256).
 * The access token signs in to IMAP and SMTP with XOAUTH2; the refresh token renews it.
 * Crewhall is a confidential client: the org admin registers the app and enters its secret.
 */

type OauthMode = Exclude<MailAuthMode, 'password'>;

interface Provider {
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  extra: Record<string, string>;
}

export function provider(mode: OauthMode, tenant: string | null): Provider {
  if (mode === 'oauth_microsoft') {
    const t = encodeURIComponent(tenant || 'organizations');
    return {
      authorizeUrl: `https://login.microsoftonline.com/${t}/oauth2/v2.0/authorize`,
      tokenUrl: `https://login.microsoftonline.com/${t}/oauth2/v2.0/token`,
      scope: [
        'openid',
        'email',
        'offline_access',
        'https://outlook.office.com/IMAP.AccessAsUser.All',
        'https://outlook.office.com/SMTP.Send',
      ].join(' '),
      extra: {},
    };
  }
  return {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid email https://mail.google.com/',
    // Without these Google returns no refresh token on later sign-ins.
    extra: { access_type: 'offline', prompt: 'consent' },
  };
}

/** Swappable for tests; the token endpoints are the only outbound HTTP calls. */
let fetcher: typeof fetch = (...args) => fetch(...args);
export function setOauthFetch(f: typeof fetch | null) {
  fetcher = f ?? ((...args) => fetch(...args));
}

const STATE_TTL_MS = 10 * 60 * 1000;
const hash = (v: string) => createHash('sha256').update(v).digest('hex');

function oauthMode(settings: MailSettingsRow): OauthMode {
  if (settings.authMode === 'password') throw new AppError('mail_auth_mode_mismatch');
  return settings.authMode;
}

function client(env: Pick<Env, 'AUTH_SECRET'>, settings: MailSettingsRow) {
  const secret = openSecret(env.AUTH_SECRET, settings.oauthClientSecretEnc);
  if (!settings.oauthClientId || !secret) throw new AppError('mail_not_configured');
  return { id: settings.oauthClientId, secret };
}

/** Authorization URL for a browser redirect; the state row lives ten minutes. */
export async function startUrl(
  db: DbOrTx,
  env: Pick<Env, 'AUTH_SECRET' | 'API_URL'>,
  settings: MailSettingsRow,
  user: { id: string; email: string },
  opts: { inboxId?: string; loginHint?: string } = {},
): Promise<string> {
  const mode = oauthMode(settings);
  const p = provider(mode, settings.oauthTenant);
  const { id } = client(env, settings);
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  await db.delete(mailOauthStates).where(lt(mailOauthStates.expiresAt, new Date()));
  await db.insert(mailOauthStates).values({
    stateHash: hash(state),
    orgId: settings.orgId,
    userId: user.id,
    codeVerifierEnc: sealSecret(env.AUTH_SECRET, verifier),
    inboxId: opts.inboxId ?? null,
    expiresAt: new Date(Date.now() + STATE_TTL_MS),
  });
  const url = new URL(p.authorizeUrl);
  const params: Record<string, string> = {
    client_id: id,
    response_type: 'code',
    redirect_uri: oauthRedirectUri(env),
    scope: p.scope,
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    login_hint: opts.loginHint ?? user.email,
    ...p.extra,
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

const TokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.coerce.number().int().positive().default(3600),
  id_token: z.string().optional(),
});

export interface OauthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  email: string | null;
}

async function tokenRequest(url: string, form: Record<string, string>): Promise<OauthTokens> {
  let res: Response;
  try {
    res = await fetcher(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new AppError('mail_server_unreachable');
  }
  const json: unknown = await res.json().catch(() => null);
  const parsed = TokenResponse.safeParse(json);
  if (!res.ok || !parsed.success) {
    const err = (json as { error?: unknown } | null)?.error;
    throw new AppError(err === 'invalid_grant' ? 'mail_auth_failed' : 'mail_oauth_failed', {
      reason: typeof err === 'string' ? err : `http_${res.status}`,
    });
  }
  const t = parsed.data;
  let email: string | null = null;
  if (t.id_token) {
    // Received straight from the token endpoint over TLS, so the signature check is not needed
    // (OpenID Connect Core 3.1.3.7); only the e-mail claim is read.
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
  };
}

/**
 * Exchanges the callback's code; checks the state belongs to this user and org. `inboxId`:
 * the sign-in was started for a shared inbox.
 */
export async function finishOauth(
  db: DbOrTx,
  env: Pick<Env, 'AUTH_SECRET' | 'API_URL'>,
  settings: MailSettingsRow,
  userId: string,
  input: { code: string; state: string },
): Promise<{ tokens: OauthTokens; inboxId: string | null }> {
  const mode = oauthMode(settings);
  const [row] = await db
    .delete(mailOauthStates)
    .where(
      and(
        eq(mailOauthStates.stateHash, hash(input.state)),
        eq(mailOauthStates.orgId, settings.orgId),
        eq(mailOauthStates.userId, userId),
      ),
    )
    .returning();
  if (!row || row.expiresAt.getTime() < Date.now()) {
    throw new AppError('mail_oauth_failed', { reason: 'state' });
  }
  const verifier = openSecret(env.AUTH_SECRET, row.codeVerifierEnc);
  if (!verifier) throw new AppError('mail_oauth_failed', { reason: 'state' });
  const c = client(env, settings);
  const tokens = await tokenRequest(provider(mode, settings.oauthTenant).tokenUrl, {
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: oauthRedirectUri(env),
    client_id: c.id,
    client_secret: c.secret,
    code_verifier: verifier,
  });
  return { tokens, inboxId: row.inboxId };
}

export async function refreshTokens(
  env: Pick<Env, 'AUTH_SECRET'>,
  settings: MailSettingsRow,
  refreshToken: string,
): Promise<OauthTokens> {
  const mode = oauthMode(settings);
  const c = client(env, settings);
  const p = provider(mode, settings.oauthTenant);
  return tokenRequest(p.tokenUrl, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: c.id,
    client_secret: c.secret,
    scope: p.scope,
  });
}
