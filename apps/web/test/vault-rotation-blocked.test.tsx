import { encryptItem, fingerprint, generateKeyPair, newVaultKey, toB64 } from '@crewhall/crypto';
import { screen, waitFor, within } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { createSpaceVault } from '@/lib/vault/api';
import { rotateVault, RotationBlockedError } from '@/lib/vault/rotation';
import { lock } from '@/lib/vault/session';
import { db } from '@/mocks/db';
import { SPACE, USER } from '@/mocks/seed';
import { vaultState } from '@/mocks/vault';
import { loginItem, seedItems, setUpVault, vaultOf } from './support/vault';

/**
 * A kept revision that can't be re-wrapped stops a rotation, which leaves nothing behind. The
 * person is told which one and can delete it for good, then rotate: nobody stays stuck in a vault.
 */

afterEach(() => lock('manual'));

/** Two members and one item at revision 2, whose kept revision 1 opens under no key of ours. */
async function vaultWithBrokenRevision() {
  const view = await setUpVault();
  const infra = await createSpaceVault(SPACE.altyapi, 'Sunucular');
  seedItems(1, loginItem, infra.id);
  const { key } = vaultOf(infra.id);
  const v = vaultState(db());
  const item = v.items.find((i) => i.vaultId === infra.id)!;
  const payload = loginItem(0);
  const ctx = { vaultId: infra.id, itemId: item.id, keyVersion: 1, type: 'login' as const };
  const elsewhere = encryptItem(newVaultKey(), { ...ctx, revision: 1 }, payload);
  Object.assign(item, encryptItem(key, { ...ctx, revision: 2 }, payload), { revision: 2 });
  item.revisions = [
    {
      ...elsewhere,
      revision: 1,
      type: 'login',
      keyVersion: 1,
      createdBy: USER.bugra,
      createdAt: item.createdAt,
    },
  ];
  const pair = generateKeyPair();
  v.keys[USER.mert] = {
    ...v.keys[USER.bugra]!,
    publicKey: toB64(pair.publicKey),
    fingerprint: fingerprint(pair.publicKey),
  };
  v.members.push({
    vaultId: infra.id,
    userId: USER.mert,
    role: 'read',
    wrappedKey: '',
    keyVersion: 1,
    grantedBy: USER.bugra,
    grantedAt: new Date().toISOString(),
  });
  return { view, infra, item };
}

describe('a revision that stops a rotation', () => {
  it('is named, deleted for good only after a confirm, and the rotation then goes through', async () => {
    const { view, infra, item } = await vaultWithBrokenRevision();
    await act(() => view.queryClient.invalidateQueries());
    await act(() =>
      view.router.navigate({ to: '/vault/$vaultId/access', params: { vaultId: infra.id } }),
    );
    await view.user.click(await screen.findByRole('button', { name: /^Erişimi kaldır: Mert/ }));
    const dialog = await screen.findByRole('dialog');
    const run = within(dialog).getByRole('button', { name: 'Kaldır ve anahtarı döndür' });
    await view.user.click(run);

    const alert = await within(dialog).findByRole('alert');
    expect(await within(alert).findByText(/Hizmet 0000 · 1\. sürüm \(eski\)/)).toBeInTheDocument();
    expect(vaultState(db()).vaults.find((v) => v.id === infra.id)!.keyVersion).toBe(1);
    expect(run).toBeDisabled();

    // Cancelling keeps it.
    await view.user.click(within(alert).getByRole('button', { name: 'Bu sürümü sil' }));
    const askName = 'Hizmet 0000 öğesinin 1. sürümü kalıcı silinsin mi?';
    let ask = await screen.findByRole('dialog', { name: askName });
    expect(within(ask).getByText(/geri alınamaz/)).toBeInTheDocument();
    await view.user.click(within(ask).getByRole('button', { name: 'Vazgeç' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: askName })).toBeNull());
    expect(item.revisions).toHaveLength(1);

    await view.user.click(within(alert).getByRole('button', { name: 'Bu sürümü sil' }));
    ask = await screen.findByRole('dialog', { name: askName });
    await view.user.click(within(ask).getByRole('button', { name: 'Kalıcı sil' }));
    await waitFor(() => expect(item.revisions).toHaveLength(0));
    expect(
      vaultState(db()).events.some(
        (e) => e.action === 'item.revision_purge' && e.itemId === item.id,
      ),
    ).toBe(true);

    await waitFor(() => expect(run).toBeEnabled());
    await view.user.click(run);
    expect(await within(dialog).findByRole('button', { name: 'Tamam' })).toBeInTheDocument();
    expect(vaultState(db()).vaults.find((v) => v.id === infra.id)!.keyVersion).toBe(2);
  }, 60_000);

  it('names every blocked one, and a current revision is not offered for deletion', async () => {
    const { infra, item } = await vaultWithBrokenRevision();
    item.itemKeyWrapped = item.revisions[0]!.itemKeyWrapped;
    const error = await rotateVault(infra.id, [USER.mert]).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RotationBlockedError);
    expect((error as RotationBlockedError).blocked).toEqual([
      { itemId: item.id, revision: 2, current: true },
      { itemId: item.id, revision: 1, current: false },
    ]);
    expect(vaultState(db()).vaults.find((v) => v.id === infra.id)!.keyVersion).toBe(1);
  }, 60_000);
});
