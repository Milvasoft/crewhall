import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { markSessionExpired } from '@/lib/sessionEvents';
import { db } from '@/mocks/db';
import { identityMockState } from '@/mocks/identity';
import { MOCK_PASSWORD, USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

// jsdom has no authenticator: the browser library answers like a platform passkey would.
const startAuthentication = vi.hoisted(() =>
  vi.fn(async () => ({ id: 'pk-1', rawId: 'pk-1', type: 'public-key', response: {} })),
);
vi.mock('@simplewebauthn/browser', () => ({ startAuthentication }));

/** Re-verification without typing the password: passkey first, password as the fallback. */
describe('step-up with a passkey', () => {
  async function openPolicyDialog() {
    renderApp('/admin/security');
    const user = userEvent.setup();
    await screen.findByText(/üye kurdu/);
    await user.click(screen.getByRole('switch', { name: 'Sızıntı listesi kontrolü' }));
    await user.click(screen.getByRole('button', { name: 'Kaydet' }));
    return { user, dialog: await screen.findByRole('dialog', { name: 'Kimliğini doğrula' }) };
  }

  it('offers the passkey first and saves once it verifies', async () => {
    signedInAs(USER.bugra);
    const { user, dialog } = await openPolicyDialog();
    // No password field until the person asks for it.
    expect(within(dialog).queryByLabelText('Şifre')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Passkey ile doğrula' }));
    await waitFor(() => expect(identityMockState(db()).policy.password.breachCheck).toBe(false));
    // The server's options went to the authenticator.
    expect(startAuthentication).toHaveBeenCalledWith({
      optionsJSON: expect.objectContaining({ userVerification: 'required' }),
    });
  });

  it('keeps the password for people without a passkey and points to adding one', async () => {
    db().users.find((u) => u.id === USER.bugra)!.passkeys = [];
    signedInAs(USER.bugra);
    const { user, dialog } = await openPolicyDialog();
    expect(within(dialog).queryByRole('button', { name: 'Passkey ile doğrula' })).toBeNull();
    expect(
      within(dialog).getByRole('link', {
        name: 'Passkey ekleyerek bir dahaki sefere hızlıca doğrula',
      }),
    ).toHaveAttribute('href', '/account/security');
    await user.type(within(dialog).getByLabelText('Şifre'), MOCK_PASSWORD);
    await user.click(within(dialog).getByRole('button', { name: 'Doğrula' }));
    await waitFor(() => expect(identityMockState(db()).policy.password.breachCheck).toBe(false));
  });

  it('puts the passkey first in the session dialog too', async () => {
    signedInAs(USER.bugra);
    renderApp('/admin/compliance');
    await screen.findByRole('heading', { name: 'Uyumluluk' });
    act(() => markSessionExpired());
    const dialog = await screen.findByRole('dialog', { name: 'Güvenlik için yeniden doğrula' });
    const buttons = within(dialog)
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(buttons.indexOf('Passkey ile doğrula')).toBeLessThan(buttons.indexOf('Devam'));
  });
});
