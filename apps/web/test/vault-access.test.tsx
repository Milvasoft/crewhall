import { screen } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { api } from '@/lib/api';
import { createSpaceVault } from '@/lib/vault/api';
import { lock } from '@/lib/vault/session';
import { db } from '@/mocks/db';
import { SPACE, USER } from '@/mocks/seed';
import { vaultState } from '@/mocks/vault';
import { setUpVault } from './support/vault';

/**
 * Nobody rotates themselves out of a vault: their device would make the new key, so the rotation
 * would not revoke them. Another manager removes them instead.
 */

afterEach(() => lock('manual'));

describe('vault access page', () => {
  it('offers removal for others, explains why not for yourself, and the server refuses it', async () => {
    const view = await setUpVault();
    const infra = await createSpaceVault(SPACE.altyapi, 'Sunucular');
    vaultState(db()).members.push({
      vaultId: infra.id,
      userId: USER.mert,
      role: 'read',
      wrappedKey: '',
      keyVersion: infra.keyVersion,
      grantedBy: USER.bugra,
      grantedAt: new Date().toISOString(),
    });
    await act(() =>
      view.router.navigate({ to: '/vault/$vaultId/access', params: { vaultId: infra.id } }),
    );

    expect(
      await screen.findByRole('button', { name: /^Erişimi kaldır: Mert/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Erişimi kaldır: Buğra/ })).toBeNull();
    expect(screen.getByText(/^Kendi erişimini kaldıramazsın/)).toBeInTheDocument();

    await expect(
      api.call('vaultRotate', {
        params: { vaultId: infra.id },
        body: {
          keyVersion: infra.keyVersion + 1,
          removeUserIds: [USER.bugra],
          members: [],
          items: [],
          revisions: [],
        },
      }),
    ).rejects.toMatchObject({ code: 'vault_cannot_remove_self' });
  }, 60_000);
});
