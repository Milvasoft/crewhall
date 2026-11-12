import {
  emptyItem,
  encryptItem,
  newId,
  newVaultKey,
  pwnedQuery,
  type ItemPayload,
} from '@crewhall/crypto';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { VaultEngine, type EngineRow } from '@/lib/vault/engine';
import { lock, vaultKeyFor } from '@/lib/vault/session';
import { db } from '@/mocks/db';
import { USER } from '@/mocks/seed';
import { vaultState } from '@/mocks/vault';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/**
 * Roadmap 20 on the web: leaked password check (k-anonymity, in the vault engine and on the
 * item), TOTP from custom fields, one-time share links end to end against the contract mock,
 * and the org policy for admins.
 */

const PASSWORD = 'kayısı-pusula-fener-yelken-41';
const MFA = 'otpauth://totp/AWS:root?secret=JBSWY3DPEHPK3PXP&issuer=AWS';

afterEach(() => lock('manual'));

describe('leak check in the vault engine', () => {
  const VAULT = 'vault-1';
  const rowOf = (key: Uint8Array, p: ItemPayload): EngineRow => {
    const id = newId();
    return {
      id,
      vaultId: VAULT,
      type: p.type,
      revision: 1,
      keyVersion: 1,
      updatedAt: '2026-10-01T00:00:00.000Z',
      ...encryptItem(
        key,
        { vaultId: VAULT, itemId: id, revision: 1, keyVersion: 1, type: p.type },
        p,
      ),
    };
  };
  const login = (name: string, password: string) => ({
    ...emptyItem('login', name),
    password,
  });

  it('sends one prefix per distinct hash, never the password, and reports breaches', async () => {
    const key = newVaultKey();
    const engine = new VaultEngine();
    engine.setKey(VAULT, 1, key);
    const rows = [
      rowOf(key, login('a', 'password')),
      rowOf(key, login('b', 'password')),
      rowOf(key, login('c', 'Tamamen-Benzersiz-91!x')),
    ];
    engine.summarize(rows);
    const asked: string[] = [];
    const report = await engine.health(
      rows.map((r) => r.id),
      new Date('2026-10-20T00:00:00Z'),
      () => 4,
      async () => {},
      async (prefix) => {
        asked.push(prefix);
        return '1E4C9B93F3F0682250B6CF8331B7EE68FD8:42';
      },
    );
    expect(asked.sort()).toEqual(
      [pwnedQuery('password').prefix, pwnedQuery('Tamamen-Benzersiz-91!x').prefix].sort(),
    );
    expect(asked.join()).not.toMatch(/password|Benzersiz/);
    expect(report!.counts.breached).toBe(2);
    // Cached for the session: a second scan asks nothing.
    await engine.health(
      rows.map((r) => r.id),
      new Date(),
      () => 4,
      async () => {},
      async (prefix) => {
        asked.push(prefix);
        return '';
      },
    );
    expect(asked).toHaveLength(2);
  });

  it('leaves items unchecked when the relay fails, and counts the failure', async () => {
    const key = newVaultKey();
    const engine = new VaultEngine();
    engine.setKey(VAULT, 1, key);
    const rows = [rowOf(key, login('a', 'password'))];
    engine.summarize(rows);
    const report = await engine.health(
      rows.map((r) => r.id),
      new Date(),
      () => 4,
      async () => {},
      () => Promise.reject(new Error('down')),
    );
    expect(report!.counts.breached).toBe(0);
    expect(engine.stats.breachErrors).toBe(1);
  });
});

async function setUpVault() {
  signedInAs(USER.bugra);
  const view = renderApp('/vault');
  const user = userEvent.setup();
  expect(await screen.findByRole('heading', { name: 'Kasa şifreni oluştur' })).toBeInTheDocument();
  await user.type(screen.getByLabelText('Kasa şifresi'), PASSWORD);
  await user.type(screen.getByLabelText('Kasa şifresi tekrar'), PASSWORD);
  const continueButton = screen.getByRole('button', { name: /Devam et/ });
  await waitFor(() => expect(continueButton).toBeEnabled());
  await user.click(continueButton);
  await screen.findByRole('heading', { name: 'Kurtarma anahtarını sakla' }, { timeout: 15_000 });
  await user.click(screen.getByLabelText('Kurtarma anahtarımı güvenli bir yere kaydettim'));
  await user.click(screen.getByRole('button', { name: 'Kasayı aç' }));
  expect(await screen.findByText('Kasan hazır, henüz boş')).toBeInTheDocument();
  return { ...view, user };
}

function seed(items: ItemPayload[]) {
  const v = vaultState(db());
  const vault = v.vaults.find((x) => x.kind === 'personal' && x.ownerUserId === USER.bugra)!;
  const member = v.members.find((m) => m.vaultId === vault.id && m.userId === USER.bugra)!;
  const key = vaultKeyFor({ ...vault, myWrappedKey: member.wrappedKey });
  const at = new Date().toISOString();
  return items.map((payload) => {
    const id = newId();
    const ctx = { vaultId: vault.id, itemId: id, revision: 1, keyVersion: vault.keyVersion };
    v.items.push({
      id,
      vaultId: vault.id,
      type: payload.type,
      revision: 1,
      keyVersion: vault.keyVersion,
      ...encryptItem(key, { ...ctx, type: payload.type }, payload),
      createdBy: USER.bugra,
      updatedBy: USER.bugra,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
      deletedBy: null,
      attachments: [],
      revisions: [],
    });
    return { id, vaultId: vault.id };
  });
}

describe('vault extras in the app (roadmap 20)', () => {
  it('flags a leaked password, shows a custom-field TOTP and shares a one-time link', async () => {
    const { user, queryClient, router } = await setUpVault();
    const [legacy] = seed([
      { ...emptyItem('login', 'Eski Router'), username: 'admin', password: 'password' },
      {
        ...emptyItem('api_key', 'AWS root'),
        key: 'AKIA-SECRET',
        fields: [{ id: 'f1', type: 'hidden', label: 'MFA', value: MFA }],
      },
    ]);
    await act(() => queryClient.invalidateQueries());

    // Health: the scan asks the relay with prefixes and lists the breached password first.
    await act(() => router.navigate({ to: '/vault/health' }));
    expect(
      await screen.findByText(/Sızıntıda görüldü · 9\.545\.824 kez/, {}, { timeout: 20_000 }),
    ).toBeInTheDocument();
    expect(screen.getByText('Sızıntıda görülen')).toBeInTheDocument();

    // Detail: the badge under the password, and the TOTP of the API key's custom field.
    await act(() =>
      router.navigate({
        to: '/vault/$vaultId/$category',
        params: { vaultId: legacy!.vaultId, category: 'all' },
        search: { item: legacy!.id },
      }),
    );
    const article = await screen.findByRole('article', { name: 'Eski Router' });
    expect(await within(article).findByText(/Sızıntıda görüldü/)).toBeInTheDocument();

    // Share: the item is encrypted again; the server never gets the key or plaintext.
    await user.click(within(article).getByRole('button', { name: 'Diğer işlemler' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Link ile paylaş' }));
    const dialog = await screen.findByRole('dialog', { name: 'Tek kullanımlık link' });
    await user.click(within(dialog).getByRole('button', { name: 'Linki oluştur' }));
    const input = await within(dialog).findByDisplayValue(/\/vault-share\//);
    const link = (input as HTMLInputElement).value;
    const m = /\/vault-share\/([A-Za-z0-9_-]{43})#([A-Za-z0-9_-]{43})$/.exec(link);
    expect(m).not.toBeNull();
    const stored = JSON.stringify(vaultState(db()).shares);
    for (const plain of ['Eski Router', 'password', m![1]!, m![2]!]) {
      expect(stored).not.toContain(plain);
    }
    expect(await within(dialog).findByText(/0\/1 açıldı/)).toBeInTheDocument();
    cleanup();
    lock('manual');

    // The recipient: no session, the key from the fragment.
    window.history.replaceState(null, '', `/vault-share/${m![1]}#${m![2]}`);
    renderApp(`/vault-share/${m![1]}`);
    expect(
      await screen.findByRole('heading', { name: 'Sana bir kasa öğesi gönderildi' }),
    ).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Göster' }));
    expect(await screen.findByRole('heading', { name: 'Eski Router' })).toBeInTheDocument();
    expect(screen.getByText('admin')).toBeInTheDocument();
    expect(screen.getByText(/Bu son açılıştı/)).toBeInTheDocument();
    // The fragment is gone from the address bar, and the link is used up.
    expect(window.location.hash).toBe('');
    expect(vaultState(db()).shares).toEqual([]);
  }, 120_000);

  it('shows the TOTP code of a custom field', async () => {
    const { queryClient, router } = await setUpVault();
    const [aws] = seed([
      {
        ...emptyItem('api_key', 'AWS root'),
        key: 'AKIA-SECRET',
        fields: [{ id: 'f1', type: 'hidden', label: 'MFA', value: MFA }],
      },
    ]);
    await act(() => queryClient.invalidateQueries());
    await act(() =>
      router.navigate({
        to: '/vault/$vaultId/$category',
        params: { vaultId: aws!.vaultId, category: 'all' },
        search: { item: aws!.id },
      }),
    );
    const article = await screen.findByRole('article', { name: 'AWS root' });
    expect(within(article).getByText('MFA')).toBeInTheDocument();
    expect(within(article).getByText(/^\d{3} \d{3}$/)).toBeInTheDocument();
    expect(within(article).queryByText(MFA)).toBeNull();
  }, 90_000);

  it('lets org admins set the vault policy', async () => {
    const { user, router } = await setUpVault();
    await act(() => router.navigate({ to: '/vault/settings' }));
    expect(await screen.findByText('Kurum politikası')).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: 'Tek kullanımlık paylaşım linkleri' }));
    await waitFor(() => expect(vaultState(db()).policy?.shareLinks).toBe(false));
    await user.click(screen.getByRole('switch', { name: 'Sızdırılmış şifre kontrolü' }));
    await waitFor(() => expect(vaultState(db()).policy?.breachCheck).toBe(false));
  }, 90_000);
});
