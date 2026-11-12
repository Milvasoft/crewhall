import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuthModule from '@/lib/auth/auth';
import { db } from '@/mocks/db';
import { identityMockState } from '@/mocks/identity';
import { MOCK_PASSWORD, USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

// The passkey ceremony itself is better-auth's; here: that it asks for this device's own lock.
const addPasskey = vi.hoisted(() => vi.fn(async () => ({ ok: true as const, data: undefined })));
vi.mock('@/lib/auth/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthModule>()),
  addPasskey,
}));

/**
 * Step-up with the password when the person has no passkey yet: in the same window, an offer to
 * verify with this device's lock (Windows Hello, Touch ID…) next time.
 */
describe('step-up offers the device lock after the password', () => {
  beforeEach(() => {
    addPasskey.mockClear();
    localStorage.clear();
    db().users.find((u) => u.id === USER.bugra)!.passkeys = [];
    // A user-verifying platform authenticator (jsdom has none).
    vi.stubGlobal('PublicKeyCredential', {
      isUserVerifyingPlatformAuthenticatorAvailable: async () => true,
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  async function verifyWithPassword() {
    signedInAs(USER.bugra);
    renderApp('/admin/security');
    const user = userEvent.setup();
    await screen.findByText(/üye kurdu/);
    await user.click(screen.getByRole('switch', { name: 'Sızıntı listesi kontrolü' }));
    await user.click(screen.getByRole('button', { name: 'Kaydet' }));
    const dialog = await screen.findByRole('dialog', { name: 'Kimliğini doğrula' });
    await user.type(within(dialog).getByLabelText('Şifre'), MOCK_PASSWORD);
    await user.click(within(dialog).getByRole('button', { name: 'Doğrula' }));
    return { user, dialog };
  }

  it('adds a platform passkey when accepted, then carries on', async () => {
    const { user, dialog } = await verifyWithPassword();
    // jsdom's user agent names no lock: "the device lock".
    await within(dialog).findByText('Bir dahaki sefere cihaz kilidi ile doğrula');
    await user.click(
      within(dialog).getByRole('button', { name: /cihaz kilidi ile doğrulamayı ekle/ }),
    );
    expect(addPasskey).toHaveBeenCalledWith('cihaz kilidi · bu cihaz', { platform: true });
    await waitFor(() => expect(identityMockState(db()).policy.password.breachCheck).toBe(false));
  });

  it('carries on with "not now" and does not ask again', async () => {
    const { user, dialog } = await verifyWithPassword();
    await user.click(await within(dialog).findByRole('button', { name: 'Şimdi değil' }));
    await waitFor(() => expect(identityMockState(db()).policy.password.breachCheck).toBe(false));
    expect(addPasskey).not.toHaveBeenCalled();
    expect(localStorage.getItem(`crewhall.stepup.deviceOffer.${USER.bugra}`)).toBe('later');
  });

  it('does not offer it where the device has no platform authenticator', async () => {
    vi.stubGlobal('PublicKeyCredential', {
      isUserVerifyingPlatformAuthenticatorAvailable: async () => false,
    });
    const { dialog } = await verifyWithPassword();
    await waitFor(() => expect(identityMockState(db()).policy.password.breachCheck).toBe(false));
    expect(within(dialog).queryByText(/Bir dahaki sefere/)).toBeNull();
  });
});
