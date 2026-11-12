import { screen, within } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/mocks/db';
import { USER } from '@/mocks/seed';
import { vaultState } from '@/mocks/vault';
import { getSession, lock, vaultStats } from '@/lib/vault/session';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';
import { seedItems, setUpVault, VAULT_PASSWORD } from './support/vault';

/**
 * Vault screens (design 08) against the contract mock, with the real @crewhall/crypto: the
 * mock server only ever receives ciphertext, wrapped keys and verifier hashes.
 */

const PASSWORD = VAULT_PASSWORD;

afterEach(() => lock('manual'));

describe('vault (design 08)', () => {
  it('sets up keys on the device; the server gets only wrapped keys and hashes', async () => {
    const { recovery } = await setUpVault();
    const keys = vaultState(db()).keys[USER.bugra]!;
    expect(keys.kdf).toMatchObject({ alg: 'argon2id', m: 65536, t: 3, p: 4 });
    const stored = JSON.stringify(vaultState(db()));
    expect(stored).not.toContain(PASSWORD);
    expect(stored).not.toContain(recovery.replace(/\s/g, '').slice(0, 20));
    // Nothing decrypted or secret lands in browser storage.
    const storage = JSON.stringify({ ...localStorage, ...sessionStorage });
    expect(storage).not.toContain(PASSWORD);
    expect(storage).not.toMatch(/privateKey|vaultKey/);
  }, 60_000);

  it('creates a login, locks, unlocks and locks again a while after the tab is hidden', async () => {
    const { user } = await setUpVault();
    await user.click(screen.getAllByRole('button', { name: /Yeni öğe/ })[0]!);
    await user.click(await screen.findByRole('button', { name: /^Giriş/ }));
    await user.type(await screen.findByLabelText('Ad'), 'Docker Hub');
    await user.type(screen.getByLabelText('Kullanıcı adı'), 'crewhall');
    await user.type(screen.getByLabelText('Şifre'), 'T7#qWm2!vR9pLx4$Kd8z');
    await user.click(screen.getByRole('button', { name: /Kaydet/ }));
    const detail = await screen.findByRole('article', { name: 'Docker Hub' });
    expect(within(detail).getByText('crewhall')).toBeInTheDocument();
    // The password stays hidden until "Göster".
    expect(within(detail).queryByText('T7#qWm2!vR9pLx4$Kd8z')).toBeNull();
    await user.click(within(detail).getAllByRole('button', { name: 'Göster' })[0]!);
    expect(within(detail).getByText('T7#qWm2!vR9pLx4$Kd8z')).toBeInTheDocument();
    // The mock server holds ciphertext only.
    const serverItems = JSON.stringify(vaultState(db()).items);
    expect(serverItems).not.toContain('Docker Hub');
    expect(serverItems).not.toContain('T7#qWm2');

    await user.click(screen.getAllByRole('button', { name: /Kilitle/ })[0]!);
    expect(await screen.findByRole('heading', { name: 'Kasa kilitli' })).toBeInTheDocument();
    expect(screen.queryByText('Docker Hub')).toBeNull();
    expect(getSession().unlocked).toBeNull();

    await user.type(screen.getByLabelText('Kasa şifresi'), 'wrong-password-123');
    await user.click(screen.getByRole('button', { name: 'Kilidi aç' }));
    expect(
      await screen.findByText(/4 deneme hakkın kaldı/, {}, { timeout: 15_000 }),
    ).toBeInTheDocument();

    await user.type(screen.getByLabelText('Kasa şifresi'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Kilidi aç' }));
    expect(
      (await screen.findAllByText('Docker Hub', {}, { timeout: 15_000 })).length,
    ).toBeGreaterThan(0);

    // Hidden: the vault waits 5 minutes (user decision 2026-10-29), so a quick look elsewhere
    // keeps it open; back after longer, it is locked.
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(screen.queryByRole('heading', { name: 'Kasa kilitli' })).toBeNull();
    const later = Date.now() + 6 * 60_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(later);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(await screen.findByRole('heading', { name: 'Kasa kilitli' })).toBeInTheDocument();
    clock.mockRestore();
  }, 90_000);

  it('opens 1000 items with one summary decryption each and a windowed list (H13)', async () => {
    const { user, queryClient } = await setUpVault();
    seedItems(1000);
    const before = vaultStats();
    const started = performance.now();
    await act(() => queryClient.invalidateQueries());
    const list = await screen.findByRole('region', { name: 'Öğeler' });
    expect(
      await within(list).findByText('Hizmet 0000', {}, { timeout: 15_000 }),
    ).toBeInTheDocument();
    const took = performance.now() - started;

    // Each item is decrypted once, into a summary; no full payload for the list.
    expect(vaultStats().decrypted - before.decrypted).toBe(1000);
    expect(vaultStats().full).toBe(before.full);
    // jsdom (no worker, slow DOM) on a dev laptop: 0.35-0.7 s; a loaded full run passed 3 s, so
    // the budget leaves room for that and still fails on the old decrypt-everything path.
    expect(took).toBeLessThan(10000);
    // Only a screenful of rows is in the DOM.
    expect(within(list).getAllByRole('listitem').length).toBeLessThan(60);
    expect(within(list).getByText('1.000 öğe')).toBeInTheDocument();

    // Searching and opening an item decrypt nothing again, except the opened item in full.
    await user.type(within(list).getByLabelText('Kasada ara'), 'Hizmet 0999');
    await user.click(await within(list).findByText('Hizmet 0999'));
    expect(await screen.findByRole('article', { name: 'Hizmet 0999' })).toBeInTheDocument();
    expect(vaultStats().decrypted - before.decrypted).toBe(1000);
    expect(vaultStats().full - before.full).toBe(1);
  }, 120_000);

  it('keeps guests out', async () => {
    signedInAs(USER.burak);
    const m = db().members.find((x) => x.userId === USER.burak)!;
    m.role = 'guest';
    renderApp('/vault');
    expect(await screen.findByText('Kasa misafirlere kapalı')).toBeInTheDocument();
  });
});
