import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { api } from '@/lib/api';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** Hesabım › Bildirimler: every kind of notification × bell, desktop, phone and e-mail. */
describe('notification settings page', () => {
  it('turns one kind off on one channel, with calls having no e-mail and security locked', async () => {
    signedInAs(USER.bugra);
    renderApp('/account/notifications');
    const user = userEvent.setup();
    const direct = await screen.findByRole('checkbox', { name: 'Birebir mesajlar · Masaüstü' });
    expect(direct).toBeChecked();
    await user.click(direct);
    await waitFor(async () => {
      const prefs = await api.call('getNotificationPrefs');
      expect(prefs.groups!.find((g) => g.group === 'chat_direct')?.desktop).toBe(false);
    });
    // Its neighbour in the same older category is untouched.
    expect(screen.getByRole('checkbox', { name: 'Yanıtlar · Masaüstü' })).toBeChecked();

    expect(screen.getByRole('checkbox', { name: 'Aramalar · Push' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Aramalar · E-posta' })).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Hesap güvenliği · E-posta' })).toBeDisabled();
    expect(screen.getByText('Kilitli kutular güvenlik için kapatılamaz.')).toBeInTheDocument();
    // Sections head the rows.
    const table = screen.getByRole('table');
    expect(within(table).getByText('Toplantı, arama ve takvim')).toBeInTheDocument();
  });

  it('shows an admin why a member did not get a push', async () => {
    signedInAs(USER.bugra);
    renderApp(`/admin/members/${USER.selin}`);
    const user = userEvent.setup();
    const panel = await screen.findByRole('region', { name: 'Push tanılama' });
    await user.click(within(panel).getByRole('button', { name: 'Göster' }));
    expect(await within(panel).findByText('O an bir oturumun başındaydı')).toBeInTheDocument();
    expect(within(panel).getByText('chat.direct')).toBeInTheDocument();
  });

  it('reaches the page from the notification centre dialog', async () => {
    signedInAs(USER.bugra);
    renderApp('/notifications');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Bildirim ayarları' }));
    await user.click(await screen.findByRole('link', { name: 'Tüm ayarlar' }));
    expect(
      await screen.findByRole('checkbox', { name: 'Birebir mesajlar · Masaüstü' }),
    ).toBeInTheDocument();
  });
});
