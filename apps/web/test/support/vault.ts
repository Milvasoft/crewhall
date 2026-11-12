import { emptyItem, encryptItem, newId, type ItemPayload } from '@crewhall/crypto';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect } from 'vitest';
import { vaultKeyFor } from '@/lib/vault/session';
import { db } from '@/mocks/db';
import { USER } from '@/mocks/seed';
import { vaultState } from '@/mocks/vault';
import { renderApp } from './render';
import { signedInAs } from './session';

export const VAULT_PASSWORD = 'kayısı-pusula-fener-yelken-41';

/** Signs in as Buğra and sets up a new vault through the screens (design 8.1-8.2). */
export async function setUpVault(path = '/vault') {
  signedInAs(USER.bugra);
  const view = renderApp(path);
  const user = userEvent.setup();
  expect(await screen.findByRole('heading', { name: 'Kasa şifreni oluştur' })).toBeInTheDocument();
  const continueButton = screen.getByRole('button', { name: /Devam et/ });
  expect(continueButton).toBeDisabled();
  await user.type(screen.getByLabelText('Kasa şifresi'), VAULT_PASSWORD);
  await user.type(screen.getByLabelText('Kasa şifresi tekrar'), VAULT_PASSWORD);
  await waitFor(() => expect(continueButton).toBeEnabled());
  await user.click(continueButton);
  expect(
    await screen.findByRole('heading', { name: 'Kurtarma anahtarını sakla' }, { timeout: 15_000 }),
  ).toBeInTheDocument();
  const recovery = screen.getByLabelText('Kurtarma anahtarı').textContent ?? '';
  expect(recovery.replace(/\s/g, '')).toHaveLength(56);
  // Nothing is uploaded until the recovery key is confirmed.
  expect(vaultState(db()).keys[USER.bugra]).toBeUndefined();
  const open = screen.getByRole('button', { name: 'Kasayı aç' });
  expect(open).toBeDisabled();
  await user.click(screen.getByLabelText('Kurtarma anahtarımı güvenli bir yere kaydettim'));
  await user.click(open);
  expect(await screen.findByText('Kasan hazır, henüz boş')).toBeInTheDocument();
  return { ...view, user, recovery };
}

/** A vault of Buğra's as the mock server stores it, with its key (personal by default). */
export function vaultOf(vaultId?: string) {
  const v = vaultState(db());
  const vault = vaultId
    ? v.vaults.find((x) => x.id === vaultId)!
    : v.vaults.find((x) => x.kind === 'personal' && x.ownerUserId === USER.bugra)!;
  const member = v.members.find((m) => m.vaultId === vault.id && m.userId === USER.bugra)!;
  return { vault, key: vaultKeyFor({ ...vault, myWrappedKey: member.wrappedKey }) };
}

export const loginItem = (i: number): ItemPayload => ({
  ...emptyItem('login', `Hizmet ${String(i).padStart(4, '0')}`),
  username: `user${i}@example.com`,
  password: `Gizli-${i}-Xq9!pass`,
});

/** Puts encrypted items straight into one of the mock server's vaults (bypassing the UI). */
export function seedItems(
  count: number,
  payload: (i: number) => ItemPayload = loginItem,
  vaultId?: string,
) {
  const v = vaultState(db());
  const { vault, key } = vaultOf(vaultId);
  const at = new Date().toISOString();
  for (let i = 0; i < count; i++) {
    const id = newId();
    const p = payload(i);
    const ctx = { vaultId: vault.id, itemId: id, revision: 1, keyVersion: vault.keyVersion };
    v.items.push({
      id,
      vaultId: vault.id,
      type: p.type,
      revision: 1,
      keyVersion: vault.keyVersion,
      ...encryptItem(key, { ...ctx, type: p.type }, p),
      createdBy: USER.bugra,
      updatedBy: USER.bugra,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
      deletedBy: null,
      attachments: [],
      revisions: [],
    });
  }
}
