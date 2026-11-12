import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { auditLogs, authLockouts, mobileConnectTokens, mobileHandoffs } from '@crewhall/db';
import { formatBackupCode, parseConnectUrl, type AuthFailureBody } from '@crewhall/shared';
import { totpCode } from '../src/scripts/totp';
import {
  Client,
  createTestApp,
  join,
  linkFromMail,
  PASSWORD,
  SETUP_BODY,
  setupWithOwner,
  type TestApp,
} from './helpers';

const IP = '203.0.113.7';

async function wrongPassword(c: Client, email: string) {
  return c.auth<AuthFailureBody>('/sign-in/email', { email, password: 'definitely-wrong-123' });
}

/** Moves the current lock into the past, as if the person waited it out. */
async function expireLock(app: TestApp, email: string) {
  await app.deps.db
    .update(authLockouts)
    .set({ lockedUntil: new Date(Date.now() - 60_000) })
    .where(sql`${authLockouts.email} = ${email}`);
}

const minutesUntil = (iso: string | undefined) =>
  Math.round((new Date(iso!).getTime() - Date.now()) / 60_000);

describe('account lockout (design 1.2, 1.16)', () => {
  let app: TestApp;
  let owner: Client;
  let ownerTotp: string;
  let mertId: string;

  beforeAll(async () => {
    app = await createTestApp();
    const setup = await setupWithOwner(app);
    owner = setup.owner;
    ownerTotp = setup.totpUri;
    mertId = (await join(app, owner, 'mert@milvasoft.com', 'member')).me.user.id;
  });
  afterAll(() => app.close());

  it('counts wrong passwords, shows remaining attempts from 3, locks on the 5th', async () => {
    const c = new Client(app);
    c.ip = IP;
    const bodies: (AuthFailureBody & { status: number })[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await wrongPassword(c, 'mert@milvasoft.com');
      bodies.push({ ...res.body, status: res.status });
    }
    expect(bodies.map((b) => b.status)).toEqual([401, 401, 401, 401, 423]);
    expect(bodies.map((b) => b.remainingAttempts)).toEqual([undefined, 3, 2, 1, undefined]);
    expect(bodies[0]?.code).toBe('INVALID_EMAIL_OR_PASSWORD');
    const locked = bodies[4]!;
    expect(locked).toMatchObject({ code: 'ACCOUNT_LOCKED', lastFailedIp: IP });
    expect(minutesUntil(locked.lockedUntil)).toBe(15);
    expect(locked.lastFailedAt).toBeTruthy();

    // The right password is refused while locked.
    const right = await c.auth<AuthFailureBody>('/sign-in/email', {
      email: 'mert@milvasoft.com',
      password: PASSWORD,
    });
    expect(right.status).toBe(423);
    expect(right.body.code).toBe('ACCOUNT_LOCKED');
  });

  it('mails the person and the org admins, and writes the audit log', async () => {
    const own = app.mailer.outbox.filter((m) => m.to === 'mert@milvasoft.com').at(-1);
    expect(own?.subject).toBe('Milvasoft hesabın geçici olarak kilitlendi');
    expect(own?.text).toContain(IP);
    expect(own?.text).toContain('/forgot-password?email=mert%40milvasoft.com');
    const admin = app.mailer.outbox.filter((m) => m.to === SETUP_BODY.owner.email).at(-1);
    expect(admin?.subject).toBe('mert@milvasoft.com hesabı kilitlendi');
    expect(admin?.text).toContain(`/admin/members/${mertId}`);

    const [log] = await app.deps.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'auth.account.locked'), eq(auditLogs.targetId, mertId)));
    expect(log?.meta).toMatchObject({ email: 'mert@milvasoft.com', ip: IP });
  });

  it('shows the lock to admins only, and an admin can lift it', async () => {
    const list = await owner.api.call('listMembers', { query: { q: 'mert' } });
    expect(list.items[0]?.lockedUntil).toBeTruthy();

    const selin = await join(app, owner, 'selin@milvasoft.com', 'member');
    const asMember = await selin.person.api.call('listMembers', { query: { q: 'mert' } });
    expect(asMember.items[0]).not.toHaveProperty('lockedUntil');
    await expect(
      selin.person.api.call('unlockMember', { params: { userId: mertId } }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    const unlocked = await owner.api.call('unlockMember', { params: { userId: mertId } });
    expect(unlocked.lockedUntil).toBeNull();
    const [log] = await app.deps.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'auth.account.unlocked'), eq(auditLogs.targetId, mertId)));
    expect(log).toBeTruthy();
    expect((await new Client(app).signIn('mert@milvasoft.com')).status).toBe(200);
  });

  it('doubles consecutive locks: 15 → 30 → 60, capped at 60', async () => {
    const c = new Client(app);
    const email = 'zeynep@milvasoft.com';
    await join(app, owner, email, 'member');
    const lockOnce = async () => {
      let last: AuthFailureBody | undefined;
      for (let i = 0; i < 5; i++) last = (await wrongPassword(c, email)).body;
      return minutesUntil(last?.lockedUntil);
    };
    expect(await lockOnce()).toBe(15);
    await expireLock(app, email);
    expect(await lockOnce()).toBe(30);
    await expireLock(app, email);
    expect(await lockOnce()).toBe(60);
    await expireLock(app, email);
    expect(await lockOnce()).toBe(60);
  });

  it('a successful sign-in resets the counter', async () => {
    const c = new Client(app);
    const email = 'can@milvasoft.com';
    await join(app, owner, email, 'member');
    for (let i = 0; i < 4; i++) await wrongPassword(c, email);
    expect((await c.signIn(email)).status).toBe(200);
    const res = await wrongPassword(new Client(app), email);
    expect(res.status).toBe(401);
    expect(res.body.remainingAttempts).toBeUndefined();
  });

  it('answers unknown e-mail addresses exactly like real ones', async () => {
    const c = new Client(app);
    const statuses: number[] = [];
    let last: AuthFailureBody | undefined;
    for (let i = 0; i < 5; i++) {
      const res = await wrongPassword(c, 'nobody@milvasoft.com');
      statuses.push(res.status);
      last = res.body;
    }
    expect(statuses).toEqual([401, 401, 401, 401, 423]);
    expect(last?.code).toBe('ACCOUNT_LOCKED');
    expect(app.mailer.outbox.some((m) => m.to === 'nobody@milvasoft.com')).toBe(false);
  });

  it('wrong TOTP codes share the counter with passwords', async () => {
    const email = SETUP_BODY.owner.email;
    const c = new Client(app);
    await wrongPassword(c, email);
    await wrongPassword(c, email);
    const step = await c.auth<{ twoFactorRedirect?: boolean }>('/sign-in/email', {
      email,
      password: PASSWORD,
    });
    expect(step.body.twoFactorRedirect).toBe(true);
    const first = await c.auth<AuthFailureBody>('/two-factor/verify-totp', { code: '000000' });
    expect(first.status).toBe(401);
    expect(first.body).toMatchObject({ code: 'INVALID_CODE', remainingAttempts: 2 });
    await c.auth('/two-factor/verify-totp', { code: '000001' });
    const locked = await c.auth<AuthFailureBody>('/two-factor/verify-totp', { code: '000002' });
    expect(locked.status).toBe(423);
    // Even the right code is refused now.
    const right = await c.auth<AuthFailureBody>('/two-factor/verify-totp', {
      code: await totpCode(ownerTotp),
    });
    expect(right.status).toBe(423);
  });

  it('passkey sign-in is not blocked by the lock', async () => {
    const res = await new Client(app).raw('GET', '/api/auth/passkey/generate-authenticate-options');
    expect(res.status).toBe(200);
  });

  it('resetting the password lifts the lock', async () => {
    const email = SETUP_BODY.owner.email;
    const c = new Client(app);
    await c.auth('/request-password-reset', { email });
    const link = linkFromMail(app, email, 'http://localhost:5173/reset-password?t=');
    const token = decodeURIComponent(new URL(link).searchParams.get('t') ?? '');
    const newPassword = 'after-the-lock-password-1';
    expect((await c.auth('/reset-password', { newPassword, token })).status).toBe(200);
    const res = await new Client(app).signIn(email, newPassword, ownerTotp);
    expect(res.status).toBe(200);
  });
});

describe('backup codes (design 1.4)', () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());

  it('are 8 upper-case characters and match in any case, with or without the dash', async () => {
    const owner = new Client(app);
    await owner.api.call('setup', { body: SETUP_BODY });
    await owner.signIn(SETUP_BODY.owner.email);
    const { backupCodes } = await owner.enrolTotp();
    expect(backupCodes).toHaveLength(10);
    for (const code of backupCodes) expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);

    const c = new Client(app);
    await c.auth('/sign-in/email', { email: SETUP_BODY.owner.email, password: PASSWORD });
    const typed = formatBackupCode(backupCodes[0]!).toLowerCase();
    expect(typed).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}$/);
    const res = await c.auth('/two-factor/verify-backup-code', { code: typed });
    expect(res.status).toBe(200);
    expect((await c.api.call('me')).user.email).toBe(SETUP_BODY.owner.email);

    // Used codes do not work twice, and a wrong code counts like a wrong TOTP.
    const again = new Client(app);
    await again.auth('/sign-in/email', { email: SETUP_BODY.owner.email, password: PASSWORD });
    const reused = await again.auth<AuthFailureBody>('/two-factor/verify-backup-code', {
      code: backupCodes[0]!,
    });
    expect(reused.status).toBe(401);
    expect(reused.body.code).toBe('INVALID_CODE');
  });
});

describe('mobile connect QR (design 12.3)', () => {
  let app: TestApp;
  let owner: Client;
  beforeAll(async () => {
    app = await createTestApp();
    ({ owner } = await setupWithOwner(app));
  });
  afterAll(() => app.close());

  it('issues a 5-minute single-use token that pre-fills the e-mail', async () => {
    const ticket = await owner.api.call('createMobileConnect');
    const link = parseConnectUrl(ticket.url);
    expect(link?.server).toBe('http://localhost:5173');
    expect(Math.round((new Date(ticket.expiresAt).getTime() - Date.now()) / 1000)).toBeGreaterThan(
      290,
    );

    const phone = new Client(app);
    const preview = await phone.api.call('getMobileConnect', { params: { token: link!.token! } });
    expect(preview).toEqual({
      email: SETUP_BODY.owner.email,
      name: SETUP_BODY.owner.name,
      orgName: 'Milvasoft',
    });
    await expect(
      phone.api.call('getMobileConnect', { params: { token: link!.token! } }),
    ).rejects.toMatchObject({ status: 410, code: 'mobile_connect_invalid' });

    const [row] = await app.deps.db.select().from(mobileConnectTokens).limit(1);
    expect(row?.tokenHash).not.toContain(link!.token!);
    const actions = (await app.deps.db.select({ a: auditLogs.action }).from(auditLogs)).map(
      (r) => r.a,
    );
    expect(actions).toEqual(
      expect.arrayContaining(['mobile.connect.create', 'mobile.connect.use']),
    );
  });

  it('rejects expired and unknown tokens', async () => {
    const ticket = await owner.api.call('createMobileConnect');
    const token = parseConnectUrl(ticket.url)!.token!;
    await app.deps.db
      .update(mobileConnectTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(sql`${mobileConnectTokens.consumedAt} is null`);
    const phone = new Client(app);
    await expect(phone.api.call('getMobileConnect', { params: { token } })).rejects.toMatchObject({
      code: 'mobile_connect_invalid',
    });
    await expect(
      phone.api.call('getMobileConnect', { params: { token: 'not-a-token' } }),
    ).rejects.toMatchObject({ code: 'mobile_connect_invalid' });
  });

  it('needs a session to create one', async () => {
    await expect(new Client(app).api.call('createMobileConnect')).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });
});

describe('mobile browser handoff (PKCE S256)', () => {
  let app: TestApp;
  let owner: Client;
  beforeAll(async () => {
    app = await createTestApp();
    ({ owner } = await setupWithOwner(app));
  });
  afterAll(() => app.close());

  const pkce = () => {
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
  };

  it('exchanges code + verifier for a bearer session on the device', async () => {
    const { verifier, challenge } = pkce();
    const { code, expiresAt } = await owner.api.call('createMobileHandoff', {
      body: { codeChallenge: challenge, redirectUri: 'crewhall://auth' },
    });
    expect(Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000)).toBeLessThanOrEqual(60);

    const phone = new Client(app);
    phone.ip = IP;
    const session = await phone.api.call('exchangeMobileHandoff', {
      body: { code, codeVerifier: verifier },
    });
    expect(session.token).toBeTruthy();

    const device = new Client(app);
    device.bearer = session.token;
    const me = await device.api.call('me');
    expect(me.user.email).toBe(SETUP_BODY.owner.email);
    expect((await device.api.call('listSpaces')).items.length).toBeGreaterThan(0);
    const sessions = await device.api.call('listSessions');
    expect(sessions.items.find((s) => s.current)?.ip).toBe(IP);

    const [log] = await app.deps.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'auth.session.new_device'));
    expect(log?.meta).toMatchObject({ via: 'mobile_handoff' });

    // Single use.
    await expect(
      phone.api.call('exchangeMobileHandoff', { body: { code, codeVerifier: verifier } }),
    ).rejects.toMatchObject({ status: 400, code: 'mobile_handoff_invalid' });
  });

  it('signs in the listed browser extension and no other', async () => {
    const { verifier, challenge } = pkce();
    const own = 'https://giohfeehjcadcpdlojgobdhhklkmnkci.chromiumapp.org/auth';
    const { code } = await owner.api.call('createMobileHandoff', {
      body: { codeChallenge: challenge, redirectUri: own },
    });
    const extension = new Client(app);
    const session = await extension.api.call('exchangeMobileHandoff', {
      body: { code, codeVerifier: verifier },
    });
    const device = new Client(app);
    device.bearer = session.token;
    expect((await device.api.call('me')).user.email).toBe(SETUP_BODY.owner.email);
    const logs = await app.deps.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'auth.session.new_device'));
    expect(logs.some((l) => (l.meta as { via?: string }).via === 'browser_extension')).toBe(true);

    await expect(
      owner.api.call('createMobileHandoff', {
        body: {
          codeChallenge: challenge,
          redirectUri: 'https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.chromiumapp.org/auth',
        },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('answers CORS for the listed browser extension only', async () => {
    const asked = async (origin: string) =>
      (await app.app.request('/api/v1/bootstrap', { headers: { Origin: origin } })).headers.get(
        'access-control-allow-origin',
      );
    const own = 'chrome-extension://giohfeehjcadcpdlojgobdhhklkmnkci';
    expect(await asked(own)).toBe(own);
    expect(await asked('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBeNull();
  });

  it('burns the code on a wrong verifier', async () => {
    const { verifier, challenge } = pkce();
    const { code } = await owner.api.call('createMobileHandoff', {
      body: { codeChallenge: challenge, redirectUri: 'exp://192.168.1.20:8081/--/auth' },
    });
    const phone = new Client(app);
    await expect(
      phone.api.call('exchangeMobileHandoff', {
        body: { code, codeVerifier: pkce().verifier },
      }),
    ).rejects.toMatchObject({ code: 'mobile_handoff_invalid' });
    await expect(
      phone.api.call('exchangeMobileHandoff', { body: { code, codeVerifier: verifier } }),
    ).rejects.toMatchObject({ code: 'mobile_handoff_invalid' });
  });

  it('expires after 60 seconds', async () => {
    const { verifier, challenge } = pkce();
    const { code } = await owner.api.call('createMobileHandoff', {
      body: { codeChallenge: challenge, redirectUri: 'crewhall://auth' },
    });
    await app.deps.db
      .update(mobileHandoffs)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(sql`${mobileHandoffs.consumedAt} is null`);
    await expect(
      new Client(app).api.call('exchangeMobileHandoff', { body: { code, codeVerifier: verifier } }),
    ).rejects.toMatchObject({ code: 'mobile_handoff_invalid' });
  });

  describe('Expo Go redirects', () => {
    const inEnv = async (nodeEnv: 'development' | 'production', run: () => Promise<void>) => {
      const before = app.deps.env.NODE_ENV;
      app.deps.env.NODE_ENV = nodeEnv;
      try {
        await run();
      } finally {
        app.deps.env.NODE_ENV = before;
      }
    };

    it('are refused in production, however they are written', async () => {
      const { challenge } = pkce();
      await inEnv('production', async () => {
        for (const redirectUri of [
          'exp://evil.host/--/x',
          'EXP://evil.host/--/x',
          '  exp://evil.host/--/x',
        ]) {
          await expect(
            owner.api.call('createMobileHandoff', {
              body: { codeChallenge: challenge, redirectUri },
            }),
          ).rejects.toMatchObject({ code: 'validation_failed' });
        }
      });
    });

    it('leave the app and the listed extension working in production', async () => {
      const { challenge } = pkce();
      await inEnv('production', async () => {
        for (const redirectUri of [
          'crewhall://auth',
          'https://giohfeehjcadcpdlojgobdhhklkmnkci.chromiumapp.org/auth',
        ]) {
          const { code } = await owner.api.call('createMobileHandoff', {
            body: { codeChallenge: challenge, redirectUri },
          });
          expect(code).toBeTruthy();
        }
      });
    });

    it('still work in development', async () => {
      const { verifier, challenge } = pkce();
      await inEnv('development', async () => {
        const { code } = await owner.api.call('createMobileHandoff', {
          body: { codeChallenge: challenge, redirectUri: 'exp://192.168.1.20:8081/--/auth' },
        });
        const session = await new Client(app).api.call('exchangeMobileHandoff', {
          body: { code, codeVerifier: verifier },
        });
        expect(session.token).toBeTruthy();
      });
    });
  });

  it('only redirects to the app schemes and needs a session', async () => {
    const { challenge } = pkce();
    for (const redirectUri of [
      'https://evil.example/cb',
      'javascript://x',
      'crewhall-evil://auth',
    ]) {
      await expect(
        owner.api.call('createMobileHandoff', { body: { codeChallenge: challenge, redirectUri } }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
    }
    await expect(
      new Client(app).api.call('createMobileHandoff', {
        body: { codeChallenge: challenge, redirectUri: 'crewhall://auth' },
      }),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});

describe('bootstrap.server', () => {
  it('reports the package version and the minimum mobile version', async () => {
    const app = await createTestApp({ MIN_MOBILE_VERSION: '1.2.0' });
    try {
      const boot = await new Client(app).api.call('bootstrap');
      expect(boot.server).toMatchObject({ version: '0.1.0', minMobileVersion: '1.2.0' });
    } finally {
      await app.close();
    }
    const plain = await createTestApp({ APP_VERSION: '0.1.0-rc.1' });
    try {
      expect((await new Client(plain).api.call('bootstrap')).server).toMatchObject({
        version: '0.1.0-rc.1',
        minMobileVersion: null,
      });
    } finally {
      await plain.close();
    }
  });
});
