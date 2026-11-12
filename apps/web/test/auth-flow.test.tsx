import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { MOCK_PASSWORD, MOCK_TOTP } from '@/mocks/seed';
import { renderApp } from './support/render';

async function signIn(email: string, password = MOCK_PASSWORD) {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('E-posta'), email);
  await user.type(screen.getByLabelText('Şifre'), password);
  await user.click(screen.getByRole('button', { name: 'Giriş yap' }));
  return user;
}

describe('sign-in', () => {
  it('redirects a signed-out visitor to /login', async () => {
    const { router } = renderApp('/');
    await screen.findByRole('heading', { name: 'Giriş yap' });
    expect(router.state.location.pathname).toBe('/login');
  });

  it('shows the error inside the form and keeps the email', async () => {
    renderApp('/login');
    await signIn('bugra@milvasoft.com', 'wrong-password');
    expect(await screen.findByRole('alert')).toHaveTextContent('E-posta ya da şifre hatalı.');
    expect(screen.getByLabelText('E-posta')).toHaveValue('bugra@milvasoft.com');
    expect(screen.getByLabelText('Şifre')).toHaveValue('');
  });

  it('counts down the remaining attempts and locks after five failures', async () => {
    renderApp('/login');
    const user = await signIn('can@milvasoft.com', 'nope-1');
    for (let i = 2; i <= 4; i++) {
      await screen.findByRole('alert');
      await user.type(screen.getByLabelText('Şifre'), `nope-${i}`);
      await user.click(screen.getByRole('button', { name: 'Giriş yap' }));
    }
    expect(await screen.findByText(/1 deneme hakkın kaldı/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Şifre'), 'nope-5');
    await user.click(screen.getByRole('button', { name: 'Giriş yap' }));
    expect(
      await screen.findByRole('heading', { name: 'Hesap geçici olarak kilitlendi' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('timer')).toHaveTextContent(/1[45]:\d\d/);
  });

  it('signs in with password and TOTP, then lands on home', async () => {
    const { router } = renderApp('/login');
    const user = await signIn('bugra@milvasoft.com');
    await screen.findByRole('heading', { name: 'Doğrulama kodu' });
    expect(screen.getByText('bugra@milvasoft.com')).toBeInTheDocument();
    await user.type(screen.getByLabelText('6 haneli doğrulama kodu'), MOCK_TOTP);
    await screen.findByRole('heading', { level: 1, name: /Ahmet/ }, { timeout: 3000 });
    expect(router.state.location.pathname).toBe('/');
    expect(screen.getAllByText('Milvasoft').length).toBeGreaterThan(0);
  });

  it('rejects a wrong TOTP code', async () => {
    renderApp('/login');
    const user = await signIn('bugra@milvasoft.com');
    await user.type(await screen.findByLabelText('6 haneli doğrulama kodu'), '000000');
    expect(await screen.findByText(/Kod hatalı/)).toBeInTheDocument();
  });

  it('accepts a backup code', async () => {
    renderApp('/login');
    const user = await signIn('bugra@milvasoft.com');
    await user.click(await screen.findByRole('link', { name: 'Yedek kod kullan' }));
    await user.type(await screen.findByLabelText('Yedek kod'), '4f7k-92qd');
    await user.click(screen.getByRole('button', { name: 'Doğrula ve giriş yap' }));
    await screen.findByRole('heading', { level: 1, name: /Ahmet/ }, { timeout: 3000 });
  });

  it('sends people without 2FA to the forced enrolment when the org requires it', async () => {
    const { router } = renderApp('/login');
    await signIn('selin@milvasoft.com');
    await screen.findByRole('heading', { name: 'İki adımlı doğrulamayı kur' }, { timeout: 3000 });
    expect(router.state.location.pathname).toBe('/security/2fa-setup');
    // The password typed at sign-in is reused from memory, so the QR step shows directly.
    expect(await screen.findByText('JBSW Y3DP EHPK 3PXP')).toBeInTheDocument();
  });

  it('switches the sign-in page to English', async () => {
    renderApp('/login', 'en');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(await screen.findByText('Continue with your Milvasoft account.')).toBeInTheDocument();
  });
});
