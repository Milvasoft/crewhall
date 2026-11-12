import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { db } from '@/mocks/db';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

const selectAll = () => screen.findByRole('checkbox', { name: 'Tümünü seç' });

describe('select all on the remaining lists', () => {
  it('Drive recent: the header box selects every row and offers the bulk bar', async () => {
    signedInAs(USER.bugra);
    renderApp('/drive/recent');
    const user = userEvent.setup();
    await user.click(await selectAll());
    const bar = await screen.findByRole('toolbar', { name: 'Seçili öğeler' });
    expect(within(bar).getByText(/öğe seçili/)).toBeInTheDocument();
    await user.click(within(bar).getByRole('button', { name: 'Seçimi temizle' }));
    expect(screen.queryByRole('toolbar', { name: 'Seçili öğeler' })).toBeNull();
  });

  it('admin members: skips yourself and owners, and deactivates the selection after asking', async () => {
    signedInAs(USER.elif);
    renderApp('/admin/members');
    const user = userEvent.setup();
    await user.click(await selectAll());
    expect(screen.queryByRole('checkbox', { name: 'Elif Yıldız seç' })).toBeNull();
    const bar = await screen.findByRole('toolbar', { name: 'Seçilenler için eylemler' });
    await user.click(within(bar).getByRole('button', { name: 'Devre dışı bırak' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Devre dışı bırak' }));
    await waitFor(() => {
      const others = db().members.filter((m) => m.userId !== USER.elif && m.role !== 'owner');
      expect(others.length).toBeGreaterThan(0);
      expect(others.every((m) => m.status === 'suspended')).toBe(true);
    });
    const owner = db().members.find((m) => m.role === 'owner');
    expect(owner?.status).toBe('active');
  });
});
