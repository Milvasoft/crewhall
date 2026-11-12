import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpCode } from '../src/scripts/totp';
import { Client, createTestApp, linkFromMail, PASSWORD, SETUP_BODY, type TestApp } from './helpers';

describe('sign-in, 2FA policy and sessions', () => {
  let app: TestApp;
  let owner: Client;
  let totpUri: string;

  beforeAll(async () => {
    app = await createTestApp();
    owner = new Client(app);
    await owner.api.call('setup', { body: SETUP_BODY });
  });
  afterAll(() => app.close());

  it('does not reveal whether an account exists on a wrong password', async () => {
    const c = new Client(app);
    const wrong = await c.auth<{ code: string }>('/sign-in/email', {
      email: SETUP_BODY.owner.email,
      password: 'wrong-password-123',
    });
    const unknown = await c.auth<{ code: string }>('/sign-in/email', {
      email: 'nobody@milvasoft.com',
      password: 'wrong-password-123',
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.code).toBe(unknown.body.code);
  });

  it('owner signs in; org endpoints ask for 2FA until it is enrolled', async () => {
    const res = await owner.signIn(SETUP_BODY.owner.email);
    expect(res.status).toBe(200);

    const me = await owner.api.call('me');
    expect(me.memberships[0]).toMatchObject({ role: 'owner', orgSlug: 'milvasoft' });
    expect(me.twoFactorRequired).toBe(true);
    expect(me.personalSpaceId).toBeTruthy();

    await expect(owner.api.call('listSpaces')).rejects.toMatchObject({
      status: 403,
      code: 'two_factor_required',
    });
    // Account endpoints stay reachable so the user can enrol.
    expect((await owner.api.call('listSessions')).items).toHaveLength(1);
  });

  it('enrols TOTP through better-auth and then reaches the app', async () => {
    const enrolled = await owner.enrolTotp();
    totpUri = enrolled.totpURI;
    expect(enrolled.backupCodes).toHaveLength(10);
    expect(totpUri).toMatch(/^otpauth:\/\/totp\//);

    const me = await owner.api.call('me');
    expect(me.user.twoFactorEnabled).toBe(true);
    expect(me.twoFactorRequired).toBe(false);
    const { items } = await owner.api.call('listSpaces');
    expect(items.map((s) => s.kind)).toEqual(['personal', 'shared']);
  });

  it('a new sign-in needs the TOTP code; a wrong code is refused', async () => {
    const c = new Client(app);
    const first = await c.auth<{ twoFactorRedirect?: boolean }>('/sign-in/email', {
      email: SETUP_BODY.owner.email,
      password: PASSWORD,
    });
    expect(first.body.twoFactorRedirect).toBe(true);
    await expect(c.api.call('me')).rejects.toMatchObject({ code: 'unauthenticated' });

    const bad = await c.auth('/two-factor/verify-totp', { code: '000000' });
    expect(bad.status).toBe(401);
    const good = await c.auth('/two-factor/verify-totp', { code: await totpCode(totpUri) });
    expect(good.status).toBe(200);
    expect((await c.api.call('me')).user.email).toBe(SETUP_BODY.owner.email);
  });

  it('mobile clients use a bearer token instead of the cookie', async () => {
    const c = new Client(app);
    await c.auth('/sign-in/email', { email: SETUP_BODY.owner.email, password: PASSWORD });
    const verified = await c.auth('/two-factor/verify-totp', { code: await totpCode(totpUri) });
    const token = verified.headers.get('set-auth-token');
    expect(token).toBeTruthy();

    const mobile = new Client(app);
    mobile.bearer = token;
    const me = await mobile.api.call('me');
    expect(me.user.email).toBe(SETUP_BODY.owner.email);
  });

  it('lists sessions and revokes another one', async () => {
    const other = new Client(app);
    await other.signIn(SETUP_BODY.owner.email, PASSWORD, totpUri);
    const { items } = await owner.api.call('listSessions');
    expect(items.length).toBeGreaterThanOrEqual(2);
    const current = items.filter((s) => s.current);
    expect(current).toHaveLength(1);

    const otherMe = await other.api.call('listSessions');
    const otherId = otherMe.items.find((s) => s.current)?.id;
    expect(otherId).toBeTruthy();
    await owner.api.call('revokeSession', { params: { sessionId: otherId! } });
    await expect(other.api.call('me')).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(
      owner.api.call('revokeSession', { params: { sessionId: otherId! } }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('resets the password with the e-mailed link and signs out other sessions', async () => {
    const c = new Client(app);
    const req = await c.auth('/request-password-reset', { email: SETUP_BODY.owner.email });
    expect(req.status).toBe(200);
    const link = linkFromMail(app, SETUP_BODY.owner.email, 'http://localhost:5173/reset-password?t=');
    const mail = app.mailer.outbox.at(-1);
    expect(mail?.subject).toBe('Milvasoft şifreni sıfırla');

    const token = decodeURIComponent(new URL(link).searchParams.get('t') ?? '');
    const newPassword = 'a-brand-new-password-42';
    const reset = await c.auth('/reset-password', { newPassword, token });
    expect(reset.status).toBe(200);

    await expect(owner.api.call('me')).rejects.toMatchObject({ code: 'unauthenticated' });
    const again = new Client(app);
    const res = await again.signIn(SETUP_BODY.owner.email, newPassword, totpUri);
    expect(res.status).toBe(200);
  });

  it('updates profile locale and name', async () => {
    const c = new Client(app);
    await c.signIn(SETUP_BODY.owner.email, 'a-brand-new-password-42', totpUri);
    const me = await c.api.call('updateMe', { body: { locale: 'en', name: 'Buğra' } });
    expect(me.user).toMatchObject({ locale: 'en', name: 'Buğra' });
  });
});
