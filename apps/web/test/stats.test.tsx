import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { db } from '@/mocks/db';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** Yönetim › İstatistikler (roadmap 21) against the contract mock. */

describe('admin statistics', () => {
  it('shows tiles, charts with a table view, module use and growing spaces', async () => {
    signedInAs(USER.bugra);
    renderApp('/admin/stats');
    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'İstatistikler' })).toBeInTheDocument();
    expect(await screen.findByText('Bugün aktif')).toBeInTheDocument();
    expect(screen.getByText('Son 30 gün')).toBeInTheDocument();

    // The activity chart has an exact table view (30 days by default).
    const active = screen.getByRole('region', { name: 'Aktif kullanıcılar' });
    await user.click(within(active).getByRole('button', { name: 'Tablo olarak göster' }));
    expect(within(active).getAllByRole('row')).toHaveLength(31);

    const modules = screen.getByRole('region', { name: 'Modül kullanımı' });
    expect(within(modules).getByText('Drive')).toBeInTheDocument();
    expect(within(modules).getByText('Sohbet')).toBeInTheDocument();

    // Growing spaces lists shared spaces only; personal ones are never listed.
    const spaces = screen.getByRole('region', { name: "Büyüyen space'ler" });
    const shared = db().spaces.filter((s) => s.kind === 'shared' && s.usedBytes > 0);
    expect(within(spaces).getAllByRole('row')).toHaveLength(Math.min(10, shared.length) + 1);

    // Another range refetches; the table view stays open.
    await user.click(screen.getByRole('radio', { name: '7 gün' }));
    await waitFor(() => expect(within(active).getAllByRole('row')).toHaveLength(8));
  });

  it('is in the admin menu only for those who can see it', async () => {
    signedInAs(USER.bugra);
    renderApp('/admin/general');
    expect(await screen.findByRole('link', { name: /İstatistikler/ })).toBeInTheDocument();
  });

  it('keeps members out', async () => {
    signedInAs(USER.mert);
    const { router } = renderApp('/admin/stats');
    await screen.findByRole('main');
    expect(router.state.location.pathname).not.toBe('/admin/stats');
  });
});
