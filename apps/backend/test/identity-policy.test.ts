import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { auditLogs, sessions } from '@crewhall/db';
import {
  Client,
  createTestApp,
  join,
  PASSWORD,
  setupWithOwner,
  SETUP_BODY,
  type TestApp,
} from './helpers';

describe('security policy (9.11)', () => {
  let app: TestApp;
  let owner: Client;
  let member: Client;
  let orgId: string;

  beforeAll(async () => {
    app = await createTestApp();
    ({ owner, orgId } = await setupWithOwner(app));
    ({ person: member } = await join(app, owner, 'elif@milvasoft.com', 'member'));
  });
  afterAll(() => app.close());

  it('shows the defaults and the 2FA status', async () => {
    const view = await owner.api.call('getSecurityPolicy');
    expect(view.policy).toMatchObject({
      twoFactor: { required: false, passkeyEnabled: true, rememberDevice: true },
      password: { localLogin: true, minLength: 12, breachCheck: false },
      session: { hours: 12, rememberDays: 30 },
      ipAllowlist: { enabled: false },
    });
    expect(view.status.twoFactor).toMatchObject({ enrolled: 1, total: 2 });
    expect(view.status.twoFactor.pending.map((p) => p.email)).toEqual(['elif@milvasoft.com']);
    await expect(member.api.call('getSecurityPolicy')).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('asks for a fresh verification before a change', async () => {
    await app.deps.db
      .update(sessions)
      .set({ createdAt: sql`now() - interval '1 hour'` })
      .where(
        sql`${sessions.userId} = (select id from users where email = ${SETUP_BODY.owner.email})`,
      );
    await expect(
      owner.api.call('updateSecurityPolicy', { body: { password: { minLength: 14 } } }),
    ).rejects.toMatchObject({ status: 403, code: 'identity_reauth_required' });
    expect((await owner.api.call('getSecurityPolicy')).status.needsReauth).toBe(true);
    await expect(
      owner.api.call('identityReauth', { body: { password: 'wrong-password' } }),
    ).rejects.toMatchObject({
      code: 'identity_password_invalid',
    });
    await owner.api.call('identityReauth', { body: { password: PASSWORD } });
    const view = await owner.api.call('updateSecurityPolicy', {
      body: { password: { minLength: 14 }, twoFactor: { required: true } },
    });
    expect(view.policy.password.minLength).toBe(14);
    expect(view.policy.twoFactor.required).toBe(true);
    expect((await owner.api.call('getOrg')).settings.requireTwoFactor).toBe(true);
    const rows = await app.deps.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.orgId, orgId), eq(auditLogs.action, 'identity.policy.update')));
    expect(rows[0]?.meta).toMatchObject({
      before: { password: { minLength: 12 } },
      after: { password: { minLength: 14 } },
    });
    await owner.api.call('updateSecurityPolicy', { body: { twoFactor: { required: false } } });
  });

  it('applies the minimum length to every new password', async () => {
    const short = await member.auth<{ code: string }>('/change-password', {
      currentPassword: PASSWORD,
      newPassword: 'thirteen-char',
    });
    expect(short.status).toBe(400);
    expect(short.body.code).toBe('PASSWORD_TOO_SHORT');
    const ok = await member.auth('/change-password', {
      currentPassword: PASSWORD,
      newPassword: 'a-much-longer-password',
    });
    expect(ok.status).toBe(200);
  });

  it('turns local password sign-in off for everyone but owners', async () => {
    await owner.api.call('updateSecurityPolicy', { body: { password: { localLogin: false } } });
    const boot = await new Client(app).api.call('bootstrap');
    expect(boot.auth.password).toBe(false);
    const elif = await new Client(app).auth<{ code: string }>('/sign-in/email', {
      email: 'elif@milvasoft.com',
      password: 'a-much-longer-password',
    });
    expect(elif.status).toBe(403);
    expect(elif.body.code).toBe('PASSWORD_LOGIN_DISABLED');
    const ownerLogin = await new Client(app).auth('/sign-in/email', {
      email: SETUP_BODY.owner.email,
      password: PASSWORD,
    });
    expect(ownerLogin.status).toBe(200);
    await owner.api.call('updateSecurityPolicy', {
      body: { password: { localLogin: true }, twoFactor: { passkeyEnabled: false } },
    });
    expect((await new Client(app).api.call('bootstrap')).auth.passkey).toBe(false);
    await owner.api.call('updateSecurityPolicy', { body: { twoFactor: { passkeyEnabled: true } } });
  });

  it('caps session lifetimes', async () => {
    await owner.api.call('updateSecurityPolicy', {
      body: { session: { hours: 2, rememberDays: 7 } },
    });
    // Each sign-in's own session (by token): earlier sessions of the same person were created
    // under the previous policy and must not be picked up, however fast the run is.
    const lifetime = async (rememberMe: boolean) => {
      const res = await new Client(app).auth<{ token: string }>('/sign-in/email', {
        email: 'elif@milvasoft.com',
        password: 'a-much-longer-password',
        rememberMe,
      });
      expect(res.status).toBe(200);
      const [row] = await app.deps.db
        .select({ expiresAt: sessions.expiresAt, createdAt: sessions.createdAt })
        .from(sessions)
        .where(eq(sessions.token, res.body.token));
      return (row!.expiresAt.getTime() - row!.createdAt.getTime()) / 3_600_000;
    };
    expect(await lifetime(false)).toBeCloseTo(2, 1);
    expect(await lifetime(true)).toBeCloseTo(7 * 24, 0);
  });

  it('guards the admin area with the IP allow list and refuses to lock the admin out', async () => {
    owner.ip = '85.105.12.44';
    await expect(
      owner.api.call('updateSecurityPolicy', {
        body: {
          ipAllowlist: {
            enabled: true,
            scope: 'admin',
            ranges: [{ cidr: '10.8.0.0/16', label: 'VPN' }],
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'ip_allowlist_self_lockout' });
    const view = await owner.api.call('updateSecurityPolicy', {
      body: {
        ipAllowlist: {
          enabled: true,
          scope: 'admin',
          ranges: [
            { cidr: '85.105.12.0/24', label: 'Ofis' },
            { cidr: '10.8.0.0/16', label: 'VPN' },
          ],
        },
      },
    });
    expect(view.status.currentIp).toBe('85.105.12.44');

    owner.ip = '192.168.1.5';
    await expect(owner.api.call('listMembers', { query: {} as never })).rejects.toMatchObject({
      status: 403,
      code: 'ip_not_allowed',
    });
    // Outside the admin area the scope "admin" lets requests through.
    await expect(owner.api.call('listSpaces')).resolves.toBeTruthy();

    owner.ip = '10.8.3.4';
    await owner.api.call('updateSecurityPolicy', { body: { ipAllowlist: { scope: 'all' } } });
    member.ip = '192.168.1.5';
    await expect(member.api.call('listSpaces')).rejects.toMatchObject({ code: 'ip_not_allowed' });
    member.ip = '10.8.9.9';
    await expect(member.api.call('listSpaces')).resolves.toBeTruthy();
    await owner.api.call('updateSecurityPolicy', { body: { ipAllowlist: { enabled: false } } });
  });
});
