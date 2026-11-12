import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { identitySessions, users } from '@crewhall/db';
import { makeSignature } from 'better-auth/crypto';
import type { Context } from 'hono';
import { setCookie } from 'hono/cookie';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { AppEnv, RequestInfo } from '../../http/types';
import { identityAudit } from './audit';
import { paths } from '@crewhall/shared';

/** better-auth's two-factor plugin cookie and lifetime (two-factor/constant.mjs). */
const TWO_FACTOR_COOKIE = 'two_factor';
const TWO_FACTOR_MAX_AGE = 600;

type CookieAttrs = {
  maxAge?: number | undefined;
  path?: string | undefined;
  domain?: string | undefined;
  secure?: boolean | undefined;
  httpOnly?: boolean | undefined;
  sameSite?: string | undefined;
};

function cookieOptions(attrs: CookieAttrs) {
  const sameSite = attrs.sameSite?.toLowerCase();
  return {
    path: attrs.path ?? '/',
    ...(attrs.domain ? { domain: attrs.domain } : {}),
    secure: attrs.secure ?? false,
    httpOnly: attrs.httpOnly ?? true,
    sameSite: (sameSite === 'none' ? 'None' : sameSite === 'strict' ? 'Strict' : 'Lax') as
      'None' | 'Strict' | 'Lax',
    ...(attrs.maxAge !== undefined ? { maxAge: attrs.maxAge } : {}),
  };
}

async function setSigned(
  c: Context<AppEnv>,
  name: string,
  value: string,
  secret: string,
  attrs: CookieAttrs,
) {
  const signature = await makeSignature(value, secret);
  setCookie(c, name, `${value}.${signature}`, cookieOptions(attrs));
}

export interface SessionStart {
  userId: string;
  orgId: string;
  providerId: string;
  /** The IdP's MFA is trusted for this sign-in: no local TOTP step, 2FA policy satisfied. */
  mfaTrusted: boolean;
  idToken?: string | null;
  nameId?: string | null;
  sessionIndex?: string | null;
  /** Where the browser goes when the sign-in is complete. */
  callbackUrl: string;
  via: 'oidc' | 'saml';
}

/**
 * Finishes a browser SSO sign-in (OIDC or SAML callback): either a better-auth session
 * cookie, or, when the account has local TOTP and the IdP's MFA is not trusted, the same
 * pending second step the password sign-in uses (/login/2fa). Returns the redirect target.
 */
export async function finishBrowserSignIn(
  deps: Deps,
  c: Context<AppEnv>,
  input: SessionStart,
  req: RequestInfo,
): Promise<string> {
  const ctx = await deps.auth.$context;
  const [user] = await deps.db.select().from(users).where(eq(users.id, input.userId));
  if (!user) throw new AppError('sso_login_failed');

  if (user.twoFactorEnabled && !input.mfaTrusted) {
    const identifier = `2fa-${randomBytes(15).toString('base64url')}`;
    const expiresAt = new Date(Date.now() + TWO_FACTOR_MAX_AGE * 1000);
    await ctx.internalAdapter.createVerificationValue({ value: user.id, identifier, expiresAt });
    await ctx.internalAdapter.createVerificationValue({
      value: '0',
      identifier: `2fa-attempts-${identifier}`,
      expiresAt,
    });
    const cookie = ctx.createAuthCookie(TWO_FACTOR_COOKIE, { maxAge: TWO_FACTOR_MAX_AGE });
    await setSigned(c, cookie.name, identifier, ctx.secret, cookie.attributes as CookieAttrs);
    const target = new URL(paths.login2fa(), deps.env.HUB_URL);
    target.searchParams.set('redirect', relativeTarget(deps, input.callbackUrl));
    return target.href;
  }

  const session = await ctx.internalAdapter.createSession(user.id, false, {
    ipAddress: req.ip ?? '',
    userAgent: req.userAgent ?? '',
    activeOrganizationId: input.orgId,
  });
  if (!session) throw new AppError('internal');
  await deps.db.insert(identitySessions).values({
    sessionId: session.id,
    orgId: input.orgId,
    providerId: input.providerId,
    idToken: input.idToken ?? null,
    nameId: input.nameId ?? null,
    sessionIndex: input.sessionIndex ?? null,
    mfa: input.mfaTrusted,
  });
  const cookie = ctx.authCookies.sessionToken;
  await setSigned(c, cookie.name, session.token, ctx.secret, cookie.attributes as CookieAttrs);
  await identityAudit(
    deps.db,
    {
      orgId: input.orgId,
      actorId: user.id,
      action: 'identity.sso.login',
      targetType: 'session',
      targetId: session.id,
      meta: { provider: input.providerId, via: input.via, mfa: input.mfaTrusted },
    },
    req,
  );
  return input.callbackUrl;
}

/** The web path (with query) of an absolute HUB_URL target, for `?redirect=`. */
function relativeTarget(deps: Deps, url: string) {
  try {
    const u = new URL(url, deps.env.HUB_URL);
    return `${u.pathname}${u.search}`;
  } catch {
    return '/';
  }
}
