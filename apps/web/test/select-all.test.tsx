import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { db } from '@/mocks/db';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

const rowBoxes = (table: HTMLElement) =>
  within(table)
    .getAllByRole('checkbox')
    .filter((c) => c.getAttribute('aria-label') !== 'Tümünü seç');

describe('tables › Tümünü seç', () => {
  it('Drive trash: the header box selects, shows some, clears; Ctrl A and Esc; bulk purge', async () => {
    signedInAs(USER.bugra);
    renderApp('/drive/milvasoft/trash');
    const user = userEvent.setup();
    const table = await screen.findByRole('table', { name: 'Çöp kutusu' });
    const all = within(table).getByRole('checkbox', { name: 'Tümünü seç' });
    const rows = rowBoxes(table);
    expect(rows.length).toBeGreaterThan(1);
    expect(all).toHaveAttribute('data-state', 'unchecked');

    await user.click(all);
    expect(rows.every((c) => c.getAttribute('data-state') === 'checked')).toBe(true);
    expect(all).toHaveAttribute('data-state', 'checked');

    // One off: the header shows "some".
    await user.click(rows[0]!);
    expect(all).toHaveAttribute('data-state', 'indeterminate');
    await user.click(all);
    expect(all).toHaveAttribute('data-state', 'checked');
    await user.click(all);
    expect(rows.every((c) => c.getAttribute('data-state') === 'unchecked')).toBe(true);

    await user.keyboard('{Control>}a{/Control}');
    expect(all).toHaveAttribute('data-state', 'checked');
    await user.keyboard('{Escape}');
    expect(all).toHaveAttribute('data-state', 'unchecked');

    // Two picked: purge them both after a confirmation.
    await user.click(rows[0]!);
    await user.click(rows[1]!);
    await user.click(screen.getByRole('button', { name: 'Seçilen 2 öğeyi kalıcı sil' }));
    const dialog = await screen.findByRole('dialog', { name: '2 öğe kalıcı olarak silinsin mi?' });
    const before = db().drive!.nodes.filter((n) => n.deletedAt).length;
    await user.click(within(dialog).getByRole('button', { name: 'Kalıcı sil' }));
    await waitFor(() =>
      expect(db().drive!.nodes.filter((n) => n.deletedAt).length).toBeLessThan(before),
    );
  });

  it('Drive folder: the header box selects every shown row', async () => {
    signedInAs(USER.bugra);
    renderApp('/drive/milvasoft');
    const user = userEvent.setup();
    const table = await screen.findByRole('table', { name: 'Klasör içeriği' });
    await within(table).findByRole('row', { name: /Q3-rapor\.xlsx/ });
    await user.click(within(table).getByRole('checkbox', { name: 'Tümünü seç' }));
    expect(rowBoxes(table).every((c) => c.getAttribute('data-state') === 'checked')).toBe(true);
    expect(screen.getByRole('toolbar', { name: 'Seçili öğeler' })).toBeInTheDocument();
  });

  it('Notifications: the header box selects every shown notification', async () => {
    signedInAs(USER.bugra);
    renderApp('/notifications');
    const user = userEvent.setup();
    const all = await screen.findByRole('checkbox', { name: 'Tümünü seç' });
    await user.click(all);
    expect(await screen.findByRole('toolbar', { name: /toplu|Toplu/ })).toBeInTheDocument();
    expect(all).toHaveAttribute('data-state', 'checked');
  });
});
