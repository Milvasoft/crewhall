import { emptyItem } from '@crewhall/crypto';
import { screen, waitFor, within } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSpaceVault } from '@/lib/vault/api';
import { lock } from '@/lib/vault/session';
import { SPACE } from '@/mocks/seed';
import { loginItem, seedItems, setUpVault } from './support/vault';

/**
 * Search across vaults (sonraki-isler "Kasalar arası arama"): on this device only, grouped by
 * vault, Ctrl K from any vault page; the term never reaches the server.
 */

afterEach(() => {
  lock('manual');
  vi.restoreAllMocks();
});

describe('vault search across vaults', () => {
  it('finds items in every vault, grouped by vault, without sending the term', async () => {
    const view = await setUpVault();
    const infra = await createSpaceVault(SPACE.altyapi, 'Sunucular');
    seedItems(12, loginItem);
    seedItems(
      3,
      (i) => ({
        ...emptyItem('login', `Hizmet sunucu ${i}`),
        username: `root${i}`,
        uris: [`ssh://db${i}.example.com`],
      }),
      infra.id,
    );
    await act(() => view.queryClient.invalidateQueries());
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const box = await screen.findByRole('textbox', { name: 'Bütün kasalarda ara' });
    // Ctrl K focuses the vault search instead of the app palette.
    await view.user.keyboard('{Control>}k{/Control}');
    expect(box).toHaveFocus();
    await view.user.type(box, 'hizmet');

    const results = await screen.findByRole('region', { name: 'Kasalardaki sonuçlar' });
    const personal = await within(results).findByRole('region', { name: 'Kişisel' });
    const shared = within(results).getByRole('region', { name: 'Sunucular' });
    expect(within(personal).getByText('12')).toBeInTheDocument();
    expect(within(personal).getByText('7 öğe daha')).toBeInTheDocument();
    expect(within(shared).getByText('Hizmet sunucu 2')).toBeInTheDocument();
    expect(within(shared).getByText('root2 · db2.example.com')).toBeInTheDocument();

    // Vault names are filtered too.
    await view.user.clear(box);
    await view.user.type(box, 'sunuc');
    const sidebar = screen.getByRole('complementary', { name: 'Kasa menüsü' });
    await waitFor(() =>
      expect(within(sidebar).queryByRole('link', { name: /^Kişisel/ })).toBeNull(),
    );
    expect(within(sidebar).getByRole('link', { name: /^Sunucular/ })).toBeInTheDocument();

    // A hit opens the item in its vault and clears the search.
    await view.user.click(await screen.findByText('Hizmet sunucu 1'));
    expect(await screen.findByRole('article', { name: 'Hizmet sunucu 1' })).toBeInTheDocument();
    expect(box).toHaveValue('');

    const sent = fetchSpy.mock.calls.map(([input, init]) =>
      `${String(input instanceof Request ? input.url : input)} ${String(init?.body ?? '')}`.toLowerCase(),
    );
    expect(sent.some((s) => s.includes('hizmet') || s.includes('sunuc'))).toBe(false);
  }, 90_000);
});
