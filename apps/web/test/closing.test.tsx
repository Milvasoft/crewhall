import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { openExternal } from '@/lib/external';
import { db } from '@/mocks/db';
import { MOCK_PASSWORD, USER } from '@/mocks/seed';
import { renderApp } from './support/render';

vi.mock('@/lib/external', () => ({ openExternal: vi.fn() }));

function signedInAs(userId: string) {
  const s = db();
  s.sessions.push({
    id: 'test-session',
    userId,
    userAgent: 'test',
    ip: null,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
  });
  s.auth.sessionId = 'test-session';
}

// A valid S256 pair (RFC 7636 appendix B).
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

describe('account lockout (1.2, 1.16)', () => {
  it('shows the lock screen with the end time, last attempt time and IP', async () => {
    renderApp('/login');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('E-posta'), 'can@milvasoft.com');
    for (let i = 1; i <= 5; i++) {
      await user.type(screen.getByLabelText('Şifre'), `nope-${i}`);
      await user.click(screen.getByRole('button', { name: 'Giriş yap' }));
      if (i < 5) await screen.findByRole('alert');
    }
    expect(
      await screen.findByRole('heading', { name: 'Hesap geçici olarak kilitlendi' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/176\.88\.142\.7 adresinden yapıldı/)).toBeInTheDocument();
  });

  it('keeps the account locked even with the right password', async () => {
    db().auth.lockedUntil['can@milvasoft.com'] = new Date(Date.now() + 10 * 60_000).toISOString();
    renderApp('/login');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('E-posta'), 'can@milvasoft.com');
    await user.type(screen.getByLabelText('Şifre'), MOCK_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Giriş yap' }));
    expect(await screen.findByRole('timer')).toHaveTextContent(/(09|10):\d\d/);
  });

  it('lets an admin see and lift the lock', async () => {
    db().auth.lockedUntil['mert@milvasoft.com'] = new Date(Date.now() + 10 * 60_000).toISOString();
    signedInAs(USER.bugra);
    renderApp('/admin/members');
    const row = await screen.findByRole('row', { name: /Mert Aydın/ });
    expect(within(row).getByText(/Kilitli/)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(row);
    const panel = await screen.findByRole('complementary', { name: 'Üye' });
    await user.click(within(panel).getByRole('button', { name: 'Kilidi kaldır' }));
    await waitFor(() => expect(db().auth.lockedUntil['mert@milvasoft.com']).toBeUndefined());
  });
});

describe('backup codes (1.4)', () => {
  it('accepts lower case without the dash', async () => {
    renderApp('/login');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('E-posta'), 'bugra@milvasoft.com');
    await user.type(screen.getByLabelText('Şifre'), MOCK_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Giriş yap' }));
    await user.click(await screen.findByRole('link', { name: 'Yedek kod kullan' }));
    await user.type(await screen.findByLabelText('Yedek kod'), 'p8tz5waf');
    await user.click(screen.getByRole('button', { name: 'Doğrula ve giriş yap' }));
    await screen.findByRole('heading', { level: 1, name: /Ahmet/ }, { timeout: 3000 });
  });
});

describe('mobile app linking', () => {
  it('shows a 5-minute QR for the app on Hesabım › Güvenlik', async () => {
    signedInAs(USER.bugra);
    renderApp('/account/security');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Mobil uygulamayı bağla' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mobil uygulamayı bağla' });
    expect(await within(dialog).findByRole('img', { name: /QR/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('timer')).toHaveTextContent(/[45]:\d\d geçerli/);
    expect(db().mobileConnect).toHaveLength(1);
  });

  it('rejects a mobile sign-in link with an untrusted redirect', async () => {
    renderApp(`/mobile-login?challenge=${CHALLENGE}&redirect=https://evil.test/cb`);
    expect(
      await screen.findByRole('heading', { name: 'Bu bağlantı geçersiz' }),
    ).toBeInTheDocument();
  });

  it('rejects an Expo Go redirect in a production build', async () => {
    vi.stubEnv('PROD', true);
    try {
      signedInAs(USER.bugra);
      renderApp(
        `/mobile-login?challenge=${CHALLENGE}&redirect=${encodeURIComponent('exp://evil.host/--/x')}`,
      );
      expect(
        await screen.findByRole('heading', { name: 'Bu bağlantı geçersiz' }),
      ).toBeInTheDocument();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('still offers an Expo Go redirect in development', async () => {
    signedInAs(USER.bugra);
    renderApp(
      `/mobile-login?challenge=${CHALLENGE}&redirect=${encodeURIComponent('exp://192.168.1.20:8081/--/auth')}`,
    );
    await screen.findByText('bugra@milvasoft.com');
    expect(screen.getByRole('button', { name: 'Onayla ve uygulamaya dön' })).toBeInTheDocument();
  });

  it('sends a signed-out visitor through sign-in first', async () => {
    const { router } = renderApp(
      `/mobile-login?challenge=${CHALLENGE}&redirect=${encodeURIComponent('crewhall://auth')}`,
    );
    await screen.findByRole('heading', { name: 'Giriş yap' });
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.search).toMatchObject({
      redirect: expect.stringContaining('/mobile-login'),
    });
  });

  it('hands a one-time code to the app, which exchanges it with the verifier', async () => {
    signedInAs(USER.bugra);
    renderApp(
      `/mobile-login?challenge=${CHALLENGE}&redirect=${encodeURIComponent('crewhall://auth')}`,
    );
    const user = userEvent.setup();
    await screen.findByText('bugra@milvasoft.com');
    await user.click(screen.getByRole('button', { name: 'Onayla ve uygulamaya dön' }));
    await waitFor(() => expect(openExternal).toHaveBeenCalled());
    const target = vi.mocked(openExternal).mock.calls.at(-1)?.[0] ?? '';
    expect(target).toMatch(/^crewhall:\/\/auth\?code=/);
    const code = decodeURIComponent(target.split('code=')[1] ?? '');

    const wrong = await fetch('http://localhost:3000/api/v1/mobile/handoff/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, codeVerifier: 'x'.repeat(43) }),
    });
    expect(wrong.status).toBe(400);

    // Single use: the failed attempt consumed it, so a fresh code is needed.
    db().mobileHandoff = [
      {
        code: 'fresh',
        challenge: CHALLENGE,
        redirectUri: 'crewhall://auth',
        userId: USER.bugra,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ];
    const ok = await fetch('http://localhost:3000/api/v1/mobile/handoff/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'fresh', codeVerifier: VERIFIER }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ token: expect.any(String) });
  });
});
