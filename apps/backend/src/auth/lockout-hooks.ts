import { users } from '@crewhall/db';
import { AUTH_LOCK, normalizeBackupCode, type AuthFailureBody } from '@crewhall/shared';
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from 'better-auth/api';
import { eq } from 'drizzle-orm';
import type { BaseDeps } from '../deps';
import { localizedMessage } from '../http/errors';
import { notifyLock } from '../services/lock-notify';
import {
  activeLockUntil,
  getLockout,
  recordFailure,
  recordSuccess,
  type LockoutRow,
} from '../services/lockout';

/**
 * Account lockout on top of better-auth (design 01 · 1.2, 1.16; docs/contracts/faz-0-kapanis.md):
 * wrong passwords, TOTP codes and backup codes share one per-e-mail counter, the fifth
 * failure locks the account, and the error bodies follow `AuthFailureBody`.
 * Passkey sign-in has no hook here, so it is never blocked.
 */

const SIGN_IN = '/sign-in/email';
const VERIFY_TOTP = '/two-factor/verify-totp';
const VERIFY_BACKUP = '/two-factor/verify-backup-code';
const TWO_FACTOR_PATHS = new Set([VERIFY_TOTP, VERIFY_BACKUP]);

/**
 * E-mail of a pending second step, keyed by its signed two_factor cookie value and
 * resolved before the endpoint consumes the verification row. Entries live 5 minutes.
 */
const pendingEmail = new Map<string, { email: string; at: number }>();
const PENDING_TTL_MS = 5 * 60_000;

function rememberPending(key: string, email: string) {
  const now = Date.now();
  for (const [k, v] of pendingEmail) if (now - v.at > PENDING_TTL_MS) pendingEmail.delete(k);
  pendingEmail.set(key, { email, at: now });
}

function clientIp(request: Request | undefined) {
  return (
    request?.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request?.headers.get('x-real-ip') ||
    null
  );
}

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

function failureError(code: string, message: string, remaining: number) {
  const body: AuthFailureBody = {
    code,
    message,
    ...(remaining <= AUTH_LOCK.showRemainingAt ? { remainingAttempts: remaining } : {}),
  };
  return new APIError('UNAUTHORIZED', body);
}

const errorCode = (e: APIError) =>
  typeof e.body === 'object' && e.body !== null && 'code' in e.body ? String(e.body.code) : '';

export function lockoutHooks(deps: Pick<BaseDeps, 'db' | 'env' | 'mailer' | 'logger'>) {
  const { db } = deps;

  const before = createAuthMiddleware(async (ctx) => {
    if (ctx.path === VERIFY_BACKUP && ctx.body && typeof ctx.body.code === 'string') {
      // Codes are shown as XXXX-XXXX and stored as 8 upper-case characters (design 1.4).
      const body = { ...ctx.body, code: normalizeBackupCode(ctx.body.code) };
      await guardTwoFactor(ctx);
      return { context: { body } };
    }
    if (ctx.path === VERIFY_TOTP) {
      await guardTwoFactor(ctx);
      return;
    }
    if (ctx.path === SIGN_IN && ctx.body && typeof ctx.body.email === 'string') {
      const row = await getLockout(db, ctx.body.email);
      const until = activeLockUntil(row);
      if (row && until) throw lockedError(row, until, ctx.request);
    }
  });

  /** Second step of a sign-in (not 2FA enrolment by a signed-in user): who is it, are they locked? */
  async function guardTwoFactor(ctx: Parameters<Parameters<typeof createAuthMiddleware>[0]>[0]) {
    if (await getSessionFromCtx(ctx)) return;
    const cookie = ctx.context.createAuthCookie('two_factor');
    const signed = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
    if (!signed) return;
    const verification = await ctx.context.internalAdapter.findVerificationValue(signed);
    if (!verification) return;
    const [user] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, verification.value));
    if (!user) return;
    rememberPending(signed, user.email);
    const row = await getLockout(db, user.email);
    const until = activeLockUntil(row);
    if (row && until) throw lockedError(row, until, ctx.request);
  }

  async function pendingFor(ctx: Parameters<Parameters<typeof createAuthMiddleware>[0]>[0]) {
    const cookie = ctx.context.createAuthCookie('two_factor');
    const signed = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
    if (!signed) return null;
    const entry = pendingEmail.get(signed);
    // A finished second step consumed the cookie; forget it.
    if (entry && !isAPIError(ctx.context.returned)) pendingEmail.delete(signed);
    return entry?.email ?? null;
  }

  const after = createAuthMiddleware(async (ctx) => {
    const isSignIn = ctx.path === SIGN_IN;
    if (!isSignIn && !TWO_FACTOR_PATHS.has(ctx.path)) return;
    const email = isSignIn
      ? typeof ctx.body?.email === 'string'
        ? ctx.body.email
        : null
      : await pendingFor(ctx);
    if (!email) return;

    const returned = ctx.context.returned;
    if (isAPIError(returned)) {
      const code = errorCode(returned);
      const counted = isSignIn
        ? code === 'INVALID_EMAIL_OR_PASSWORD'
        : code === 'INVALID_CODE' || code === 'INVALID_BACKUP_CODE';
      if (!counted) return;
      const ip = clientIp(ctx.request);
      const result = await recordFailure(db, email, ip);
      if (result.locked && result.row.lockedUntil) {
        await notifyLock(deps, result.row, {
          ip,
          userAgent: ctx.request?.headers.get('user-agent') ?? null,
        });
        throw lockedError(result.row, result.row.lockedUntil, ctx.request);
      }
      const message =
        typeof returned.body === 'object' && returned.body && 'message' in returned.body
          ? String(returned.body.message)
          : returned.message;
      throw failureError(
        isSignIn ? 'INVALID_EMAIL_OR_PASSWORD' : 'INVALID_CODE',
        message,
        result.remainingAttempts,
      );
    }

    // A correct password that still needs the second step is not a completed sign-in:
    // resetting here would give unlimited code guesses. The two-factor plugin turns the
    // response into `twoFactorRedirect` only after this hook, so look at the user.
    if (isSignIn && hasTwoFactor(returned)) return;
    await recordSuccess(db, email);
  });

  return { before, after };
}

function hasTwoFactor(returned: unknown): boolean {
  if (typeof returned !== 'object' || returned === null) return false;
  if ('twoFactorRedirect' in returned && returned.twoFactorRedirect === true) return true;
  const user = 'user' in returned ? returned.user : null;
  return (
    typeof user === 'object' &&
    user !== null &&
    'twoFactorEnabled' in user &&
    user.twoFactorEnabled === true
  );
}
