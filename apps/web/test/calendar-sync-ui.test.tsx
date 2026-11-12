import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { api } from '@/lib/api';
import { resetCalendarMock } from '@/mocks/calendar';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** Calendar sync settings of sonraki-isler: org-wide access on a provider card. */
describe('calendar sync settings', () => {
  beforeEach(() => {
    resetCalendarMock();
    signedInAs(USER.bugra);
  });

  it('switches on organization-wide sync for Google', async () => {
    renderApp('/admin/calendar');
    const user = userEvent.setup();
    const google = (await screen.findAllByRole('switch', { name: 'Kurum genelinde eşitle' }))[0]!;
    const card = google.closest('form') as HTMLElement;
    await user.type(within(card).getByLabelText('İstemci kimliği (Client ID)'), 'g-client');
    await user.type(within(card).getByLabelText('İstemci sırrı (Client secret)'), 'g-secret');
    await user.click(within(card).getByRole('switch', { name: 'Kişiler bağlayabilsin' }));
    await user.click(google);
    await user.click(within(card).getByRole('button', { name: 'Kaydet' }));
    expect(
      await screen.findByText('Kayıtlı sır korunur. Değiştirmek için yenisini yaz.'),
    ).toBeInTheDocument();
    const { items } = await api.call('getCalendarIntegrations');
    expect(items.find((i) => i.provider === 'google')?.domainWide).toBe(true);
  });
});
