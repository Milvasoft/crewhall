import { Toaster } from '@crewhall/ui';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { createSpaceVault } from '@/lib/vault/api';
import { lock } from '@/lib/vault/session';
import { db } from '@/mocks/db';
import { SPACE } from '@/mocks/seed';
import { vaultState } from '@/mocks/vault';
import { seedItems, setUpVault, vaultOf } from './support/vault';

/**
 * "Başka kasaya taşı" with a small searchable picker, undo, and the same picker for a
 * selection in the list (sonraki-isler · Kasa).
 */

const countIn = (vaultId: string) =>
  vaultState(db()).items.filter((i) => i.vaultId === vaultId && !i.deletedAt).length;

afterEach(() => lock('manual'));

describe('move vault items', () => {
  it('moves one item from its menu, undoes it, then moves a selection', async () => {
    const view = await setUpVault();
    const infra = await createSpaceVault(SPACE.altyapi, 'Sunucular');
    seedItems(4);
    await act(() => view.queryClient.invalidateQueries());
    const personal = vaultOf().vault.id;
    const { user } = view;
    // renderApp mounts no Toaster; the move toast and its "Geri al" need one.
    render(<Toaster />);

    // One item, from the detail menu.
    const list = await screen.findByRole('region', { name: 'Öğeler' });
    await user.click(await within(list).findByText('Hizmet 0001', {}, { timeout: 15_000 }));
    await user.click(await screen.findByRole('button', { name: 'Diğer işlemler' }));
    const moveItem = await screen.findByRole('menuitem', { name: /Başka kasaya taşı/ });
    // The icon sits beside the label (shared MenuItem `icon`), not inside the label's line.
    expect(moveItem.firstElementChild?.tagName.toLowerCase()).toBe('svg');
    await user.click(moveItem);
    const dialog = await screen.findByRole('dialog', { name: 'Başka kasaya taşı' });
    // Only vaults one can write to, without the current one.
    expect(within(dialog).queryByRole('option', { name: /Kişisel/ })).toBeNull();
    await user.type(within(dialog).getByPlaceholderText('Kasa ara'), 'sunuc');
    await user.click(within(dialog).getByRole('option', { name: /Sunucular/ }));

    expect(await screen.findByText('Sunucular kasasına taşındı')).toBeInTheDocument();
    expect(countIn(personal)).toBe(3);
    expect(countIn(infra.id)).toBe(1);
    await waitFor(() => expect(within(list).queryByText('Hizmet 0001')).toBeNull());

    // fireEvent: sonner's swipe handler needs pointer capture, which jsdom lacks.
    fireEvent.click(screen.getByRole('button', { name: 'Geri al' }));
    expect(await screen.findByText('Taşıma geri alındı')).toBeInTheDocument();
    expect(countIn(personal)).toBe(4);
    expect(countIn(infra.id)).toBe(0);
    expect(await within(list).findByText('Hizmet 0001')).toBeInTheDocument();

    // A selection in the list, with the same picker.
    await user.click(within(list).getByRole('checkbox', { name: 'Hizmet 0002 öğesini seç' }));
    await user.click(within(list).getByRole('checkbox', { name: 'Hizmet 0003 öğesini seç' }));
    expect(within(list).getByText('2 seçili')).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: 'Taşı' }));
    const many = await screen.findByRole('dialog', { name: '2 öğeyi başka kasaya taşı' });
    await user.click(within(many).getByRole('option', { name: /Sunucular/ }));
    expect(await screen.findByText('2 öğe Sunucular kasasına taşındı')).toBeInTheDocument();
    expect(countIn(personal)).toBe(2);
    expect(countIn(infra.id)).toBe(2);
    await waitFor(() => expect(within(list).queryByText('2 seçili')).toBeNull());
    // Encrypted again for the target vault: the server still sees ciphertext only.
    expect(JSON.stringify(vaultState(db()).items)).not.toContain('Hizmet 0002');
  }, 120_000);
});
