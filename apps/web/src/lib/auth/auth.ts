import { paths } from '@crewhall/shared';
import { config } from '@/config';
import { authClient } from './client';

/**
 * Thin wrapper over the better-auth client: one result shape for every screen,
 * so the UI maps failures to copy without knowing better-auth error codes.
 */

/** What the 1.16 lock screen shows (AuthFailureBody on 423). */
export interface LockInfo {
  lockedUntil?: string;
  lastFailedAt?: string;
  lastFailedIp?: string;
}

export type AuthFailure =
  | { kind: 'invalid'; remainingAttempts?: number }
  | ({ kind: 'locked' } & LockInfo)
  | { kind: 'rate_limited'; retryAfterSec?: number }
  | { kind: 'cancelled' }
  | { kind: 'expired' }
  | { kind: 'network' }
  /** 403 from the org sign-in policy (identity module): SSO-only domain, password or LDAP off. */
  | { kind: 'policy'; code: SignInPolicyCode; providerId?: string }
  | { kind: 'other'; message?: string };

export type SignInPolicyCode = 'sso_required' | 'password_login_disabled' | 'ldap_disabled';

const POLICY_CODES: Record<string, SignInPolicyCode> = {
  SSO_REQUIRED: 'sso_required',
  PASSWORD_LOGIN_DISABLED: 'password_login_disabled',
  LDAP_DISABLED: 'ldap_disabled',
};

export type AuthResult<T = undefined> = { ok: true; data: T } | ({ ok: false } & AuthFailure);

/** better-auth error as the client returns it: the response body (AuthFailureBody) plus status. */
interface BetterAuthError {
  status?: number;
  code?: string;
  message?: string;
  remainingAttempts?: number;
  lockedUntil?: string | Date;
  lastFailedAt?: string | Date;
  lastFailedIp?: string;
  providerId?: string;
  details?: { retryAfter?: number };
}

// The client's JSON parser turns ISO strings into Date objects.
const iso = (v: string | Date | undefined): string | undefined =>
  v === undefined ? undefined : v instanceof Date ? v.toISOString() : v;

function fail(error: BetterAuthError | null | undefined): { ok: false } & AuthFailure {
  if (!error) return { ok: false, kind: 'network' };
  const code = error.code ?? '';
  if (error.status === 423 || code === 'ACCOUNT_LOCKED') {
    return {
      ok: false,
      kind: 'locked',
      lockedUntil: iso(error.lockedUntil),
      lastFailedAt: iso(error.lastFailedAt),
      lastFailedIp: error.lastFailedIp,
    };
  }
  const policy = POLICY_CODES[code];
  if (policy) return { ok: false, kind: 'policy', code: policy, providerId: error.providerId };
  if (error.status === 429) {
    return { ok: false, kind: 'rate_limited', retryAfterSec: error.details?.retryAfter };
  }
  if (
    code === 'AUTH_CANCELLED' ||
    code.startsWith('ERROR_CEREMONY') ||
    code === 'ERROR_INVALID_DOMAIN'
  ) {
    return { ok: false, kind: 'cancelled' };
  }
  if (code === 'INVALID_TOKEN' || code === 'TOKEN_EXPIRED' || error.status === 410) {
    return { ok: false, kind: 'expired' };
  }
  if (
    error.status === 401 ||
    code === 'INVALID_EMAIL_OR_PASSWORD' ||
    code === 'INVALID_CODE' ||
    code === 'INVALID_TWO_FACTOR_AUTHENTICATION' ||
    code === 'INVALID_BACKUP_CODE' ||
    code === 'INVALID_PASSWORD'
  ) {
    return { ok: false, kind: 'invalid', remainingAttempts: error.remainingAttempts };
  }
  return { ok: false, kind: 'other', message: error.message };
}

async function run<T>(
  call: () => Promise<{ data: T | null; error: BetterAuthError | null }>,
): Promise<AuthResult<T>> {
  try {
    const res = await call();
    if (res.error) return fail(res.error);
    return { ok: true, data: res.data as T };
  } catch {
    return fail(null);
  }
}

// ---- Password kept in memory for the forced 2FA enrolment right after sign-in ----
// better-auth requires the password to enable TOTP; asking again a few seconds after the
// user typed it would be noise. Never persisted; cleared after use or after 5 minutes.
let pending: { password: string; at: number } | null = null;

export function rememberPassword(password: string): void {
  pending = { password, at: Date.now() };
}

export function takePassword(): string | null {
  if (!pending || Date.now() - pending.at > 5 * 60_000) {
    pending = null;
    return null;
  }
  return pending.password;
}

export function forgetPassword(): void {
  pending = null;
}

// ---- Sign in ----

export type SignInOutcome = { twoFactor: true } | { twoFactor: false };

export async function signInEmail(input: {
  email: string;
  password: string;
  rememberMe: boolean;
}): Promise<AuthResult<SignInOutcome>> {
  const res = await run(() => authClient.signIn.email(input));
  if (!res.ok) return res;
  rememberPassword(input.password);
  const data = res.data as { twoFactorRedirect?: boolean } | null;
  return { ok: true, data: { twoFactor: Boolean(data?.twoFactorRedirect) } };
}

/**
 * Directory (Active Directory / LDAP) sign-in: `username` is the directory name or the e-mail.
 * Answers like `/sign-in/email` (2FA redirect, remaining attempts, lock).
 */
export async function signInLdap(input: {
  username: string;
  password: string;
  rememberMe: boolean;
}): Promise<AuthResult<SignInOutcome>> {
  const res = await run(
    () =>
      authClient.$fetch('/sign-in/ldap', { method: 'POST', body: input, throw: false }) as Promise<{
        data: unknown;
        error: BetterAuthError | null;
      }>,
  );
  if (!res.ok) return res;
  const data = res.data as { twoFactorRedirect?: boolean } | null;
  return { ok: true, data: { twoFactor: Boolean(data?.twoFactorRedirect) } };
}

export async function verifyTotp(code: string, trustDevice: boolean): Promise<AuthResult> {
  const res = await run(() => authClient.twoFactor.verifyTotp({ code, trustDevice }));
  return res.ok ? { ok: true, data: undefined } : res;
}

export async function verifyBackupCode(code: string): Promise<AuthResult> {
  // The server compares with normalizeBackupCode (case and dash do not matter, 1.4).
  const res = await run(() =>
    authClient.twoFactor.verifyBackupCode({ code: code.trim(), trustDevice: false }),
  );
  return res.ok ? { ok: true, data: undefined } : res;
}

/** In mock mode there is no authenticator; the MSW handler accepts a stub assertion. */
async function mockCeremony(path: string): Promise<AuthResult> {
  await new Promise((r) => setTimeout(r, 900));
  return run(
    () =>
      authClient.$fetch(path, {
        method: 'POST',
        body: { response: { mock: true } },
        throw: false,
      }) as Promise<{
        data: unknown;
        error: BetterAuthError | null;
      }>,
  ).then((r) => (r.ok ? { ok: true as const, data: undefined } : r));
}

export async function signInPasskey(): Promise<AuthResult> {
  if (config.mock) return mockCeremony('/passkey/verify-authentication');
  const res = await run(() => authClient.signIn.passkey());
  return res.ok ? { ok: true, data: undefined } : res;
}

/**
 * Adds a sign-in passkey. `platform`: this device's own authenticator (Windows Hello, Touch ID,
 * the phone's lock), not a security key or another phone; step-up then always asks for user
 * verification (backend services/identity/stepup).
 */
export async function addPasskey(
  name: string,
  { platform = false }: { platform?: boolean } = {},
): Promise<AuthResult> {
  if (config.mock) return mockCeremony('/passkey/verify-registration');
  const res = await run(() =>
    authClient.passkey.addPasskey({
      name,
      ...(platform ? { authenticatorAttachment: 'platform' as const } : {}),
    }),
  );
  return res.ok ? { ok: true, data: undefined } : res;
}

export async function signOut(): Promise<void> {
  forgetPassword();
  await authClient.signOut().catch(() => undefined);
}

// ---- Password reset ----

export async function requestPasswordReset(email: string): Promise<AuthResult> {
  const redirectTo = `${window.location.origin}${paths.resetPassword()}`;
  const res = await run(() => authClient.requestPasswordReset({ email, redirectTo }));
  return res.ok ? { ok: true, data: undefined } : res;
}

export async function resetPassword(token: string, newPassword: string): Promise<AuthResult> {
  const res = await run(() => authClient.resetPassword({ token, newPassword }));
  return res.ok ? { ok: true, data: undefined } : res;
}

export async function changePassword(input: {
  currentPassword: string;
  newPassword: string;
  revokeOtherSessions: boolean;
}): Promise<AuthResult> {
  const res = await run(() => authClient.changePassword(input));
  return res.ok ? { ok: true, data: undefined } : res;
}

export async function signUpEmail(input: {
  name: string;
  email: string;
  password: string;
}): Promise<AuthResult> {
  const res = await run(() => authClient.signUp.email(input));
  if (res.ok) rememberPassword(input.password);
  return res.ok ? { ok: true, data: undefined } : res;
}

// ---- 2FA enrolment and management ----

export async function enableTwoFactor(
  password: string,
): Promise<AuthResult<{ totpURI: string; backupCodes: string[] }>> {
  return run(
    () =>
      authClient.twoFactor.enable({ password }) as Promise<{
        data: { totpURI: string; backupCodes: string[] } | null;
        error: BetterAuthError | null;
      }>,
  );
}

export async function disableTwoFactor(password: string): Promise<AuthResult> {
  const res = await run(() => authClient.twoFactor.disable({ password }));
  return res.ok ? { ok: true, data: undefined } : res;
}

export async function regenerateBackupCodes(
  password: string,
): Promise<AuthResult<{ backupCodes: string[] }>> {
  return run(
    () =>
      authClient.twoFactor.generateBackupCodes({ password }) as Promise<{
        data: { backupCodes: string[] } | null;
        error: BetterAuthError | null;
      }>,
  );
}

export interface PasskeyInfo {
  id: string;
  name?: string | null;
  deviceType?: string;
  createdAt: string | Date;
}

export async function listPasskeys(): Promise<PasskeyInfo[]> {
  const res = await run(
    () =>
      authClient.$fetch('/passkey/list-user-passkeys', { method: 'GET', throw: false }) as Promise<{
        data: PasskeyInfo[] | null;
        error: BetterAuthError | null;
      }>,
  );
  return res.ok ? (res.data ?? []) : [];
}

export async function deletePasskey(id: string): Promise<AuthResult> {
  const res = await run(() => authClient.passkey.deletePasskey({ id }));
  return res.ok ? { ok: true, data: undefined } : res;
}

/** Parse the base32 secret from an otpauth:// URI for manual entry ("JBSW Y3DP ..."). */
export function totpSecretFromUri(uri: string): string {
  try {
    const secret = new URL(uri).searchParams.get('secret') ?? '';
    return secret.replace(/(.{4})/g, '$1 ').trim();
  } catch {
    return '';
  }
}
