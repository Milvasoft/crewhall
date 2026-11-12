import { randomBytes } from 'node:crypto';
import { AUTH_LOCK, type AuthFailureBody } from '@crewhall/shared';
import type { BetterAuthPlugin } from 'better-auth';
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getSessionFromCtx,
} from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { z } from 'zod';
import type { BaseDeps } from '../../deps';
import { AppError, localizedMessage } from '../../http/errors';
import { notifyLock } from '../lock-notify';
import {
  activeLockUntil,
  getLockout,
  recordFailure,
  recordSuccess,
  type LockoutRow,
} from '../lockout';
import { identityAudit } from './audit';
import { checkDirectoryPassword, lookupDirectoryUser, provisionDirectoryUser } from './directory';
import type { UserCreator } from './provision';
import {
  installationOrgIds,
  isBreached,
  orgsForEmail,
  orgsForUser,
  passwordSignInBlock,
  strictestPolicy,
} from './signin';

/**
 * better-auth side of the identity module, registered in auth/auth.ts:
 * - POST /api/auth/sign-in/ldap: directory sign-in that answers exactly like /sign-in/email
 *   (cookie, bearer `set-auth-token`, TOTP second step, lockout bodies), so web and mobile
 *   reuse their password flows;
 * - before hooks: SSO-enforced domains and "local password off" refuse /sign-in/email (owners
 *   keep it as the break-glass login), passkey sign-in off, "remember device" off, the org
 *   password policy (length, breach list) on every password that is set;
 * - session lifetimes from the org policy (absolute: 12 h, or 30 days with "keep me signed in").
 */

const ip = (request: Request | undefined) =>
  request?.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
  request?.headers.get('x-real-ip') ||
  null;

function lockedError(row: LockoutRow, until: Date, request: Request | undefined) {
  const body: AuthFailureBody = {
    code: 'ACCOUNT_LOCKED',
    message: localizedMessage('account_locked', request?.headers.get('accept-language')),
    lockedUntil: until.toISOString(),
    ...(row.lastFailedAt ? { lastFailedAt: row.lastFailedAt.toISOString() } : {}),
    ...(row.lastFailedIp ? { lastFailedIp: row.lastFailedIp } : {}),
  };
  return new APIError('LOCKED', body);
}

function invalidError(remaining: number, request: Request | undefined) {
  const body: AuthFailureBody = {
    code: 'INVALID_EMAIL_OR_PASSWORD',
    message: localizedMessage(
      'directory_invalid_credentials',
      request?.headers.get('accept-language'),
    ),
    ...(remaining <= AUTH_LOCK.showRemainingAt ? { remainingAttempts: remaining } : {}),
  };
  return new APIError('UNAUTHORIZED', body);
}

/** AppError from the identity services → a better-auth error with the same code (upper case). */
function asApiError(err: unknown, request: Request | undefined) {
  if (err instanceof AppError) {
    const status =
      err.status === 403
        ? 'FORBIDDEN'
        : err.status === 502
          ? 'BAD_GATEWAY'
          : err.status === 401
            ? 'UNAUTHORIZED'
            : 'BAD_REQUEST';
    return new APIError(status, {
      code: err.code.toUpperCase(),
      message: localizedMessage(err.code, request?.headers.get('accept-language')),
    });
  }
  return err;
}

const LdapSignInBody = z.object({
  username: z.string().trim().min(1).max(320),
  password: z.string().max(1024),
  rememberMe: z.boolean().optional(),
  callbackURL: z.string().optional(),
});

const PASSWORD_PATHS: Record<string, 'password' | 'newPassword'> = {
  '/sign-up/email': 'password',
  '/change-password': 'newPassword',
  '/reset-password': 'newPassword',
  '/set-password': 'newPassword',
};

const PASSKEY_SIGN_IN = new Set([
  '/passkey/generate-authenticate-options',
  '/passkey/verify-authentication',
]);

export function identityAuthPlugin(base: BaseDeps) {
  const deps = base;

  return {
    id: 'crewhall-identity',
    endpoints: {
      signInLdap: createAuthEndpoint(
        '/sign-in/ldap',
        { method: 'POST', body: LdapSignInBody },
        async (ctx) => {
          const { username, password, rememberMe } = ctx.body;
          const request = ctx.request;
          const req = {
            ip: ip(request),
            userAgent: request?.headers.get('user-agent') ?? null,
            locale: null,
          };
          const create: UserCreator = (data, source) =>
            ctx.context.internalAdapter.createUser(data, source);

          let lookup;
          try {
            lookup = await lookupDirectoryUser(deps, username);
          } catch (err) {
            throw asApiError(err, request);
          }
          // One counter per person: their e-mail when the directory knows it, else the typed name.
          const key =
            lookup.status === 'found' && lookup.user.email
              ? lookup.user.email
              : `ldap:${username.trim().toLowerCase()}`;
          const lock = await getLockout(deps.db, key);
          const until = activeLockUntil(lock);
          if (lock && until) throw lockedError(lock, until, request);

          const ok =
            lookup.status === 'found' &&
            !lookup.user.disabled &&
            (await checkDirectoryPassword(deps, lookup.provider, lookup.user.dn, password).catch(
              (err) => {
                throw asApiError(err, request);
              },
            ));
          if (!ok || lookup.status !== 'found') {
            const result = await recordFailure(deps.db, key, req.ip);
            if (result.locked && result.row.lockedUntil) {
              await notifyLock(deps, result.row, { ip: req.ip, userAgent: req.userAgent });
              throw lockedError(result.row, result.row.lockedUntil, request);
            }
            throw invalidError(result.remainingAttempts, request);
          }

          let provisioned;
          try {
            provisioned = await provisionDirectoryUser(
              deps,
              create,
              lookup.provider,
              lookup.user,
              req,
            );
          } catch (err) {
            throw asApiError(err, request);
          }
          await recordSuccess(deps.db, key);
          const user = await ctx.context.internalAdapter.findUserById(provisioned.userId);
          if (!user) throw new APIError('INTERNAL_SERVER_ERROR');

          if ((user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled) {
            // Same pending second step as the two-factor plugin's /sign-in/email hook.
            const maxAge = 600;
            const identifier = `2fa-${randomBytes(15).toString('base64url')}`;
            const expiresAt = new Date(Date.now() + maxAge * 1000);
            await ctx.context.internalAdapter.createVerificationValue({
              value: user.id,
              identifier,
              expiresAt,
            });
            await ctx.context.internalAdapter.createVerificationValue({
              value: '0',
              identifier: `2fa-attempts-${identifier}`,
              expiresAt,
            });
            const cookie = ctx.context.createAuthCookie('two_factor', { maxAge });
            await ctx.setSignedCookie(
              cookie.name,
              identifier,
              ctx.context.secret,
              cookie.attributes,
            );
            if (rememberMe === false) {
              await ctx.setSignedCookie(
                ctx.context.authCookies.dontRememberToken.name,
                'true',
                ctx.context.secret,
                ctx.context.authCookies.dontRememberToken.attributes,
              );
            }
            return ctx.json({ twoFactorRedirect: true, twoFactorMethods: ['totp'] });
          }

          const session = await ctx.context.internalAdapter.createSession(
            user.id,
            rememberMe === false,
            {
              activeOrganizationId: provisioned.orgId,
            },
          );
          if (!session) throw new APIError('INTERNAL_SERVER_ERROR');
          await setSessionCookie(ctx, { session, user }, rememberMe === false);
          await identityAudit(
            deps.db,
            {
              orgId: provisioned.orgId,
              actorId: user.id,
              action: 'identity.ldap.login',
              targetType: 'session',
              targetId: session.id,
              meta: {
                provider: lookup.provider.id,
                created: provisioned.created,
                linked: provisioned.linked,
              },
            },
            req,
          );
          return ctx.json({
            redirect: false,
            token: session.token,
            user: {
              id: user.id,
              email: user.email,
              name: user.name,
              image: user.image ?? null,
              emailVerified: user.emailVerified,
              createdAt: user.createdAt,
              updatedAt: user.updatedAt,
            },
          });
        },
      ),
    },
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === '/sign-in/email',
          handler: createAuthMiddleware(async (ctx) => {
            const email =
              typeof ctx.body?.email === 'string' ? ctx.body.email.trim().toLowerCase() : null;
            if (!email) return;
            const block = await passwordSignInBlock(deps.db, email);
            if (!block) return;
            const lang = ctx.request?.headers.get('accept-language');
            throw new APIError('FORBIDDEN', {
              ...block,
              message: localizedMessage(
                block.code === 'SSO_REQUIRED' ? 'sso_required' : 'password_login_disabled',
                lang,
              ),
            });
          }),
        },
        {
          matcher: (ctx) => PASSKEY_SIGN_IN.has(ctx.path ?? ''),
          handler: createAuthMiddleware(async (_ctx) => {
            // Passkey sign-in: judged against the installation's org policy (the user is unknown yet).
            const policy = await strictestPolicy(deps.db, await installationOrgIds(deps.db));
            if (policy && !policy.twoFactor.passkeyEnabled) {
              throw new APIError('FORBIDDEN', {
                code: 'PASSKEY_DISABLED',
                message: 'Passkey sign-in is disabled',
              });
            }
          }),
        },
        {
          matcher: (ctx) =>
            ctx.path === '/two-factor/verify-totp' || ctx.path === '/two-factor/verify-backup-code',
          handler: createAuthMiddleware(async (ctx) => {
            if (!ctx.body?.trustDevice) return;
            const policy = await strictestPolicy(deps.db, await installationOrgIds(deps.db));
            if (policy && !policy.twoFactor.rememberDevice) {
              return { context: { body: { ...ctx.body, trustDevice: false } } };
            }
          }),
        },
        {
          matcher: (ctx) => Boolean(ctx.path && ctx.path in PASSWORD_PATHS),
          handler: createAuthMiddleware(async (ctx) => {
            const field = PASSWORD_PATHS[ctx.path ?? '']!;
            const password =
              typeof ctx.body?.[field] === 'string' ? (ctx.body[field] as string) : null;
            if (password === null) return;
            let orgIds: string[];
            if (ctx.path === '/sign-up/email' && typeof ctx.body?.email === 'string') {
              orgIds = (await orgsForEmail(deps.db, ctx.body.email.trim().toLowerCase())).map(
                (o) => o.orgId,
              );
            } else {
              const session = await getSessionFromCtx(ctx).catch(() => null);
              orgIds = session
                ? (await orgsForUser(deps.db, session.user.id)).map((o) => o.orgId)
                : await installationOrgIds(deps.db);
            }
            const policy = await strictestPolicy(deps.db, orgIds);
            if (!policy) return;
            const lang = ctx.request?.headers.get('accept-language');
            if (password.length < policy.password.minLength) {
              throw new APIError('BAD_REQUEST', {
                code: 'PASSWORD_TOO_SHORT',
                message: localizedMessage('password_too_short', lang),
                minLength: policy.password.minLength,
              });
            }
            if (policy.password.breachCheck && (await isBreached(password, deps.logger))) {
              throw new APIError('BAD_REQUEST', {
                code: 'PASSWORD_BREACHED',
                message: localizedMessage('password_breached', lang),
              });
            }
          }),
        },
      ],
    },
    init() {
      return {
        options: {
          databaseHooks: {
            session: {
              create: {
                async before(session: { userId: string; expiresAt: Date; createdAt?: Date }) {
                  const orgIds = (await orgsForUser(deps.db, session.userId)).map((o) => o.orgId);
                  const policy = await strictestPolicy(deps.db, orgIds);
                  if (!policy) return;
                  const now = Date.now();
                  const requested = new Date(session.expiresAt).getTime() - now;
                  // better-auth gives 1 day without "keep me signed in" and expiresIn (30 days) with it.
                  const remembered =
                    requested > 25 * 60 * 60 * 1000 && policy.session.rememberDays > 0;
                  const cap = remembered
                    ? policy.session.rememberDays * 24 * 60 * 60 * 1000
                    : policy.session.hours * 60 * 60 * 1000;
                  if (requested <= cap) return;
                  return { data: { ...session, expiresAt: new Date(now + cap) } };
                },
              },
            },
          },
        },
      };
    },
  } satisfies BetterAuthPlugin;
}
