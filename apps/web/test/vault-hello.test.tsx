import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DesktopVaultDeviceBridge } from '@/lib/desktop';
import { lock } from '@/lib/vault/session';
import { db } from '@/mocks/db';
import { USER } from '@/mocks/seed';
import { vaultState } from '@/mocks/vault';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/**
 * Windows Hello vault unlock in the desktop app, against the vault mock and the real crypto. The
 * app side (OS-encrypted secret, Hello assertion check) is a fake that keeps what it is given:
 * apps/desktop tests that part.
 */

const PASSWORD = 'kayısı-pusula-fener-yelken-41';

function fakeApp() {
  let stored: { unlockId: string; secret: string; stamp: string } | null = null;
  const bridge = {
    status: vi.fn(async (_userId: string, stamp: string) =>
      stored
        ? stored.stamp === stamp
          ? { available: true, enrolled: true, usable: true, unlockId: stored.unlockId }
          : { available: true, enrolled: false, stale: stored.unlockId }
        : { available: true, enrolled: false },
    ),
    challenge: vi.fn(async (_userId: string, purpose: string) => ({
      challenge: 'AAEC',
      rpId: 'localhost',
      ...(purpose === 'unlock' ? { credentialId: 'CQk' } : {}),
    })),
    enrol: vi.fn(
      async (_userId: string, input: { unlockId: string; secret: string; stamp: string }) => {
        stored = { unlockId: input.unlockId, secret: input.secret, stamp: input.stamp };
        return { replaced: null };
      },
    ),
    unlock: vi.fn(async () => ({ unlockId: stored!.unlockId, secret: stored!.secret })),
    passwordUnlocked: vi.fn(async () => undefined),
    forget: vi.fn(async () => {
      const unlockId = stored?.unlockId ?? null;
      stored = null;
      return { unlockId };
    }),
  };
  return bridge;
}

const ab = (...b: number[]) => new Uint8Array(b).buffer;
let bridge: ReturnType<typeof fakeApp>;
let create: ReturnType<typeof vi.fn>;
let get: ReturnType<typeof vi.fn>;

beforeEach(() => {
  bridge = fakeApp();
  window.crewhallDesktop = {
    isDesktop: true,
    platform: 'win32',
    features: ['vaultDevice'],
    vaultDevice: bridge as unknown as DesktopVaultDeviceBridge,
  };
  vi.stubGlobal('PublicKeyCredential', {
    isUserVerifyingPlatformAuthenticatorAvailable: async () => true,
  });
  create = vi.fn(async () => ({
    rawId: ab(9, 9),
    response: {
      clientDataJSON: ab(1),
      getAuthenticatorData: () => ab(2),
      getPublicKey: () => ab(3),
      getPublicKeyAlgorithm: () => -7,
    },
  }));
  get = vi.fn(async () => ({
    rawId: ab(9, 9),
    response: { clientDataJSON: ab(4), authenticatorData: ab(5), signature: ab(6) },
  }));
  vi.stubGlobal('navigator', { ...navigator, credentials: { create, get } });
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  localStorage.clear();
});

afterEach(() => {
  lock('manual');
  delete window.crewhallDesktop;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function setUpVault() {
  signedInAs(USER.bugra);
  const { router } = renderApp('/vault');
  const user = userEvent.setup();
  await screen.findByRole('heading', { name: 'Kasa şifreni oluştur' });
  await user.type(screen.getByLabelText('Kasa şifresi'), PASSWORD);
  await user.type(screen.getByLabelText('Kasa şifresi tekrar'), PASSWORD);
  const next = screen.getByRole('button', { name: /Devam et/ });
  await waitFor(() => expect(next).toBeEnabled());
  await user.click(next);
  await screen.findByRole('heading', { name: 'Kurtarma anahtarını sakla' }, { timeout: 15_000 });
  await user.click(screen.getByLabelText('Kurtarma anahtarımı güvenli bir yere kaydettim'));
  await user.click(screen.getByRole('button', { name: 'Kasayı aç' }));
  await screen.findByText('Kasan hazır, henüz boş');
  return { user, router };
}

/** Later, the person comes back to the vault from another page: a request to open it. */
async function comeBackLater(router: { navigate: (o: { to: string }) => Promise<void> }) {
  const later = Date.now() + 60_000;
  vi.spyOn(Date, 'now').mockReturnValue(later);
  await act(() => router.navigate({ to: '/' }));
  await act(() => router.navigate({ to: '/vault' }));
}

describe('vault unlock with Windows Hello (desktop app)', () => {
  it('offers Hello after the password, then opens with it by itself when the person comes back', async () => {
    const { user, router } = await setUpVault();
    const offer = await screen.findByRole('dialog', { name: 'Bundan sonra Windows Hello ile aç' });
    await user.click(within(offer).getByRole('button', { name: 'Windows Hello ile açmayı kur' }));
    await waitFor(() => expect(bridge.enrol).toHaveBeenCalled());
    // A platform credential with user verification, and a `device` method on the server.
    const options = (create.mock.calls[0] as [CredentialCreationOptions])[0].publicKey!;
    expect(options.authenticatorSelection).toMatchObject({
      authenticatorAttachment: 'platform',
      userVerification: 'required',
    });
    const keys = vaultState(db()).keys[USER.bugra]!;
    expect(JSON.stringify(keys)).toContain('device');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /Windows Hello ile aç/ })).toBeNull(),
    );

    // Locked by hand: the lock screen offers Hello but does not start it (no surprise prompt).
    act(() => lock('manual'));
    await screen.findByRole('button', { name: 'Windows Hello ile aç' });
    await new Promise((r) => setTimeout(r, 300));
    expect(get).not.toHaveBeenCalled();

    // Coming back to the locked vault later: Hello opens by itself and the vault opens.
    await comeBackLater(router);
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect((get.mock.calls[0] as [CredentialRequestOptions])[0].publicKey!.userVerification).toBe(
      'required',
    );
    expect(await screen.findByText('Kasan hazır, henüz boş')).toBeInTheDocument();
  }, 60_000);

  it('keeps the master password one click away', async () => {
    const { user } = await setUpVault();
    const offer = await screen.findByRole('dialog', { name: 'Bundan sonra Windows Hello ile aç' });
    await user.click(within(offer).getByRole('button', { name: 'Windows Hello ile açmayı kur' }));
    await waitFor(() => expect(bridge.enrol).toHaveBeenCalled());
    get.mockRejectedValue(new DOMException('cancelled', 'NotAllowedError'));
    act(() => lock('manual'));
    await user.click(await screen.findByRole('button', { name: 'Windows Hello ile aç' }));
    await screen.findByText('Windows Hello doğrulaması iptal edildi.');
    await user.click(screen.getByRole('button', { name: 'Ana şifreyle aç' }));
    await user.type(screen.getByLabelText('Kasa şifresi'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Kilidi aç' }));
    expect(
      await screen.findByText('Kasan hazır, henüz boş', {}, { timeout: 15_000 }),
    ).toBeInTheDocument();
    // The password restarts the 14-day window.
    expect(bridge.passwordUnlocked).toHaveBeenCalled();
  }, 60_000);

  it('never starts Hello by itself when the window is not in focus', async () => {
    const { user, router } = await setUpVault();
    const offer = await screen.findByRole('dialog', { name: 'Bundan sonra Windows Hello ile aç' });
    await user.click(within(offer).getByRole('button', { name: 'Windows Hello ile açmayı kur' }));
    await waitFor(() => expect(bridge.enrol).toHaveBeenCalled());
    act(() => lock('idle'));
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    await comeBackLater(router);
    await screen.findByRole('button', { name: 'Windows Hello ile aç' });
    // Focus comes back while the lock screen is up: still no prompt until the person asks.
    act(() => void window.dispatchEvent(new Event('focus')));
    await new Promise((r) => setTimeout(r, 300));
    expect(get).not.toHaveBeenCalled();
  }, 60_000);

  it('remembers "not now"', async () => {
    const { user } = await setUpVault();
    const offer = await screen.findByRole('dialog', { name: 'Bundan sonra Windows Hello ile aç' });
    await user.click(within(offer).getByRole('button', { name: 'Şimdi değil' }));
    expect(localStorage.getItem(`crewhall.vault.helloOffer.${USER.bugra}`)).toBe('later');
    expect(bridge.enrol).not.toHaveBeenCalled();
  }, 60_000);
});
