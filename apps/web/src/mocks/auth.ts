import { AUTH_LOCK, formatBackupCode, normalizeBackupCode } from '@crewhall/shared';
import { delay, http, HttpResponse, type HttpHandler } from 'msw';
import { currentUser } from './core';
import { db, newId, save } from './db';
import {
  MOCK_EXPIRED_RESET_TOKEN,
  MOCK_RESET_TOKEN,
  MOCK_TOTP,
  type MockState,
  type MockUser,
} from './seed';

/**
 * better-auth endpoints the web client calls (/api/auth/*). Shapes follow better-auth 1.7;
 * lockout (423 + details.lockedUntil) and remaining attempts are the Crewhall additions
 * requested from the backend (see apps/web/README.md, "Contract needs").
 */

const MOCK_IP = '176.88.142.7';
let latency = 300;

export function setAuthLatency(ms: number): void {
  latency = ms;
}

type Json = Record<string, unknown>;

/** better-auth error body; lockout fields sit at the top level (AuthFailureBody). */
function authError(status: number, code: string, message: string, extra?: Json) {
  return HttpResponse.json({ code, message, ...(extra ?? {}) }, { status });
}

function userJson(u: MockUser) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    emailVerified: true,
    image: u.imageUrl,
    twoFactorEnabled: u.twoFactorEnabled,
    createdAt: '2024-03-12T09:00:00.000Z',
    updatedAt: new Date().toISOString(),
  };
}

function startSession(s: MockState, u: MockUser) {
  const now = new Date().toISOString();
  const id = newId();
  s.sessions.push({
    id,
    userId: u.id,
    userAgent: typeof navigator === 'undefined' ? null : navigator.userAgent.slice(0, 120),
    ip: '85.105.12.44',
    createdAt: now,
    lastActiveAt: now,
  });
  s.auth.sessionId = id;
  s.auth.pending2faUserId = null;
  s.auth.failed[u.email] = 0;
  s.auth.lastEmail = u.email;
  const m = s.members.find((x) => x.userId === u.id);
  if (m) m.lastSeenAt = now;
  return { token: id, user: userJson(u) };
}

/**
 * Counts a failed attempt per e-mail (password, TOTP and backup code share it, 1.2):
 * 401 with remainingAttempts once 3 or fewer are left, 423 on the 5th failure.
 * Consecutive locks (within 24 h of the last one ending) last 15, 30, then 60 minutes.
 */
function failAttempt(s: MockState, email: string, code: string, message: string) {
  const now = Date.now();
  const n = (s.auth.failed[email] ?? 0) + 1;
  s.auth.failed[email] = n;
  s.auth.lastFailed = {
    ...(s.auth.lastFailed ?? {}),
    [email]: { at: new Date(now).toISOString(), ip: MOCK_IP },
  };
  if (n >= AUTH_LOCK.maxFailures) {
    const previous = s.auth.lockedUntil[email];
    const consecutive = previous !== undefined && now - new Date(previous).getTime() < 86_400_000;
    const count = consecutive ? (s.auth.lockCount?.[email] ?? 0) + 1 : 0;
    const minutes = AUTH_LOCK.lockMinutes[Math.min(count, AUTH_LOCK.lockMinutes.length - 1)] ?? 60;
    s.auth.lockCount = { ...(s.auth.lockCount ?? {}), [email]: count };
    s.auth.lockedUntil[email] = new Date(now + minutes * 60_000).toISOString();
    s.auth.failed[email] = 0;
    return lockedResponse(s, email);
  }
  const remaining = AUTH_LOCK.maxFailures - n;
  return authError(
    401,
    code,
    message,
    remaining <= AUTH_LOCK.showRemainingAt ? { remainingAttempts: remaining } : undefined,
  );
}

function lockedResponse(s: MockState, email: string) {
  const last = s.auth.lastFailed?.[email];
  return authError(423, 'ACCOUNT_LOCKED', 'Account locked', {
    lockedUntil: s.auth.lockedUntil[email],
    ...(last ? { lastFailedAt: last.at, lastFailedIp: last.ip } : {}),
  });
}

function locked(s: MockState, email: string) {
  const until = s.auth.lockedUntil[email];
  if (until && new Date(until).getTime() > Date.now()) return lockedResponse(s, email);
  return null;
}

async function body(request: Request): Promise<Json> {
  return ((await request.json().catch(() => ({}))) ?? {}) as Json;
}

const p = (path: string) => `*/api/auth${path}`;

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 8 characters, upper case and digits (design 01 · 1.4). */
function newBackupCode(): string {
  const raw = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(raw, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

function route(
  method: 'get' | 'post',
  path: string,
  fn: (ctx: { s: MockState; b: Json; request: Request }) => Response | Promise<Response>,
): HttpHandler {
  return http[method](p(path), async ({ request }) => {
    if (latency) await delay(latency);
    const s = db();
    const b = method === 'post' ? await body(request) : {};
    const res = await fn({ s, b, request });
    save();
    return res;
  });
}

export const authHandlers: HttpHandler[] = [
  route('get', '/get-session', ({ s }) => {
    const u = currentUser(s);
    const session = s.sessions.find((x) => x.id === s.auth.sessionId);
    if (!u || !session) return HttpResponse.json(null);
    return HttpResponse.json({
      session: {
        id: session.id,
        userId: u.id,
        token: session.id,
        expiresAt: new Date(Date.now() + 12 * 3600_000).toISOString(),
        createdAt: session.createdAt,
        updatedAt: session.lastActiveAt,
      },
      user: userJson(u),
    });
  }),

  route('post', '/sign-in/email', ({ s, b }) => {
    const email = String(b.email ?? '').toLowerCase();
    const lock = locked(s, email);
    if (lock) return lock;
    const u = s.users.find((x) => x.email === email);
    if (!u || u.password !== b.password) {
      return failAttempt(s, email, 'INVALID_EMAIL_OR_PASSWORD', 'Invalid email or password');
    }
    const m = s.members.find((x) => x.userId === u.id);
    if (m?.status === 'suspended') return authError(403, 'USER_SUSPENDED', 'Suspended');
    s.auth.lastEmail = u.email;
    if (u.twoFactorEnabled) {
      s.auth.pending2faUserId = u.id;
      return HttpResponse.json({ twoFactorRedirect: true, twoFactorMethods: ['totp'] });
    }
    return HttpResponse.json({ redirect: false, ...startSession(s, u) });
  }),

  route('post', '/sign-up/email', ({ s, b }) => {
    const email = String(b.email ?? '').toLowerCase();
    if (s.users.some((x) => x.email === email)) {
      return authError(422, 'USER_ALREADY_EXISTS', 'User already exists');
    }
    const invited = s.invitations.some(
      (i) => i.email === email && new Date(i.expiresAt).getTime() > Date.now(),
    );
    if (!invited) {
      return authError(403, 'SIGNUP_REQUIRES_INVITATION', 'Sign-up requires an invitation');
    }
    if (String(b.password ?? '').length < 12) {
      return authError(400, 'PASSWORD_TOO_SHORT', 'Password too short');
    }
    const u: MockUser = {
      id: newId(),
      name: String(b.name ?? ''),
      email,
      password: String(b.password),
      imageUrl: null,
      locale: 'tr',
      twoFactorEnabled: false,
      totpPending: false,
      backupCodes: [],
      passkeys: [],
    };
    s.users.push(u);
    return HttpResponse.json(startSession(s, u));
  }),

  route('post', '/sign-out', ({ s }) => {
    s.sessions = s.sessions.filter((x) => x.id !== s.auth.sessionId);
    s.auth.sessionId = null;
    s.auth.pending2faUserId = null;
    return HttpResponse.json({ success: true });
  }),

  route('post', '/two-factor/verify-totp', ({ s, b }) => {
    const signedIn = currentUser(s);
    // Enrolment: a signed-in user confirms the first code.
    if (signedIn && signedIn.totpPending) {
      if (b.code !== MOCK_TOTP) return authError(401, 'INVALID_CODE', 'Invalid code');
      signedIn.twoFactorEnabled = true;
      signedIn.totpPending = false;
      return HttpResponse.json({ token: s.auth.sessionId, user: userJson(signedIn) });
    }
    const u = s.users.find((x) => x.id === s.auth.pending2faUserId);
    if (!u) return authError(401, 'INVALID_TWO_FACTOR_COOKIE', 'Sign in again');
    const lock = locked(s, u.email);
    if (lock) return lock;
    if (b.code !== MOCK_TOTP) return failAttempt(s, u.email, 'INVALID_CODE', 'Invalid code');
    return HttpResponse.json(startSession(s, u));
  }),

  route('post', '/two-factor/verify-backup-code', ({ s, b }) => {
    const u = s.users.find((x) => x.id === s.auth.pending2faUserId);
    if (!u) return authError(401, 'INVALID_TWO_FACTOR_COOKIE', 'Sign in again');
    const lock = locked(s, u.email);
    if (lock) return lock;
    const code = normalizeBackupCode(String(b.code ?? ''));
    const idx = u.backupCodes.map(normalizeBackupCode).indexOf(code);
    if (idx < 0) return failAttempt(s, u.email, 'INVALID_CODE', 'Invalid backup code');
    u.backupCodes.splice(idx, 1);
    return HttpResponse.json(startSession(s, u));
  }),

  route('post', '/two-factor/enable', ({ s, b }) => {
    const u = currentUser(s);
    if (!u) return authError(401, 'UNAUTHORIZED', 'Unauthorized');
    if (b.password !== u.password) return authError(400, 'INVALID_PASSWORD', 'Invalid password');
    u.totpPending = true;
    u.backupCodes = Array.from({ length: 10 }, () => newBackupCode());
    const issuer = encodeURIComponent(s.org?.branding.orgName ?? 'Crewhall');
    return HttpResponse.json({
      totpURI: `otpauth://totp/${issuer}:${encodeURIComponent(u.email)}?secret=JBSWY3DPEHPK3PXP&issuer=${issuer}`,
      backupCodes: u.backupCodes.map(formatBackupCode),
    });
  }),

  route('post', '/two-factor/disable', ({ s, b }) => {
    const u = currentUser(s);
    if (!u) return authError(401, 'UNAUTHORIZED', 'Unauthorized');
    if (b.password !== u.password) return authError(400, 'INVALID_PASSWORD', 'Invalid password');
    u.twoFactorEnabled = false;
    return HttpResponse.json({ status: true });
  }),

  route('post', '/two-factor/generate-backup-codes', ({ s, b }) => {
    const u = currentUser(s);
    if (!u) return authError(401, 'UNAUTHORIZED', 'Unauthorized');
    if (b.password !== u.password) return authError(400, 'INVALID_PASSWORD', 'Invalid password');
    u.backupCodes = Array.from({ length: 10 }, () => newBackupCode());
    return HttpResponse.json({
      status: true,
      backupCodes: u.backupCodes.map(formatBackupCode),
    });
  }),

  route('post', '/request-password-reset', ({ s, b }) => {
    const email = String(b.email ?? '').toLowerCase();
    if (s.users.some((x) => x.email === email)) {
      console.info(`[mock] reset link: ${String(b.redirectTo)}?token=${MOCK_RESET_TOKEN}`);
    }
    // Same answer whether or not the account exists.
    return HttpResponse.json({ status: true });
  }),

  route('post', '/reset-password', ({ s, b }) => {
    if (b.token === MOCK_EXPIRED_RESET_TOKEN || b.token !== MOCK_RESET_TOKEN) {
      return authError(400, 'INVALID_TOKEN', 'Invalid token');
    }
    const u = s.users.find((x) => x.email === s.auth.lastEmail) ?? s.users[0];
    if (!u) return authError(400, 'INVALID_TOKEN', 'Invalid token');
    u.password = String(b.newPassword ?? '');
    s.sessions = s.sessions.filter((x) => x.userId !== u.id);
    s.auth.sessionId = null;
    // A password reset lifts the lock (faz-0-kapanis §1).
    delete s.auth.lockedUntil[u.email];
    s.auth.failed[u.email] = 0;
    return HttpResponse.json({ status: true });
  }),

  route('post', '/change-password', ({ s, b }) => {
    const u = currentUser(s);
    if (!u) return authError(401, 'UNAUTHORIZED', 'Unauthorized');
    if (b.currentPassword !== u.password) {
      return authError(400, 'INVALID_PASSWORD', 'Invalid password');
    }
    u.password = String(b.newPassword ?? '');
    if (b.revokeOtherSessions) {
      s.sessions = s.sessions.filter((x) => x.userId !== u.id || x.id === s.auth.sessionId);
    }
    return HttpResponse.json({ token: null, user: userJson(u) });
  }),

  route('get', '/passkey/list-user-passkeys', ({ s }) => {
    const u = currentUser(s);
    if (!u) return authError(401, 'UNAUTHORIZED', 'Unauthorized');
    return HttpResponse.json(u.passkeys.map((k) => ({ ...k, userId: u.id, backedUp: true })));
  }),

  // Mock ceremonies: the client skips WebAuthn in mock mode and posts a stub.
  route('post', '/passkey/verify-authentication', ({ s }) => {
    const u =
      s.users.find((x) => x.email === s.auth.lastEmail && x.passkeys.length > 0) ??
      s.users.find((x) => x.passkeys.length > 0);
    if (!u) return authError(400, 'AUTHENTICATION_FAILED', 'No passkey');
    return HttpResponse.json({ session: startSession(s, u) });
  }),

  route('post', '/passkey/verify-registration', ({ s }) => {
    const u = currentUser(s);
    if (!u) return authError(401, 'UNAUTHORIZED', 'Unauthorized');
    const pk = {
      id: newId(),
      name: 'Bu cihaz',
      deviceType: 'singleDevice',
      createdAt: new Date().toISOString(),
    };
    u.passkeys.push(pk);
    return HttpResponse.json(pk);
  }),

  route('post', '/passkey/delete-passkey', ({ s, b }) => {
    const u = currentUser(s);
    if (!u) return authError(401, 'UNAUTHORIZED', 'Unauthorized');
    u.passkeys = u.passkeys.filter((k) => k.id !== b.id);
    return HttpResponse.json({ status: true });
  }),
];
