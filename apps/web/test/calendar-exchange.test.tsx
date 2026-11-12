import { render, screen, waitFor, within } from '@testing-library/react';
import { Toaster } from '@crewhall/ui';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { api } from '@/lib/api';
import {
  MOCK_WRONG_EXCHANGE_PASSWORD,
  resetCalendarMock,
  setMockCalendarAccounts,
} from '@/mocks/calendar';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

const TITLE = 'Exchange (şirket içi)';
const URL_LABEL = 'EWS adresi';
const SERVER = 'https://mail.contoso.test/EWS/Exchange.asmx';
const PASSWORD = 'exchange-test-pass';

/** On-premises Exchange: no OAuth, the admin sets the server and people sign in. */
describe('Exchange accounts', () => {
  beforeEach(async () => {
    resetCalendarMock();
    signedInAs(USER.bugra);
    // The mock keeps integrations between tests.
    await api.call('updateCalendarIntegration', {
      params: { provider: 'exchange' },
      body: { enabled: false, ewsUrl: null, ewsAuth: 'ntlm', contactsSync: false },
    });
  });

  const enable = () =>
    api.call('updateCalendarIntegration', {
      params: { provider: 'exchange' },
      body: { enabled: true, ewsUrl: SERVER },
    });

  const calendarSettings = async () => {
    renderApp('/calendar');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Takvim ayarları' }));
    return { user, dialog: await screen.findByRole('dialog', { name: 'Takvim ayarları' }) };
  };

  const exchangeCard = async () => {
    renderApp('/admin/calendar');
    const user = userEvent.setup();
    const label = await screen.findByLabelText(URL_LABEL);
    return { user, form: label.closest('form')!, url: label };
  };

  it('lets the admin set the server up, over https only', async () => {
    const { user, form, url } = await exchangeCard();
    const save = within(form).getByRole('button', { name: 'Kaydet' });
    await user.type(url, 'http://mail.contoso.test/EWS');
    expect(save).toBeDisabled();
    await user.clear(url);
    await user.type(url, SERVER);
    expect(save).toBeEnabled();
    await user.click(
      within(form).getByRole('switch', { name: `Kişiler bağlayabilsin · ${TITLE}` }),
    );
    await user.click(within(form).getByRole('switch', { name: 'Exchange kişilerini de eşitle' }));
    await user.click(save);
    await waitFor(async () => {
      const { items } = await api.call('getCalendarIntegrations');
      expect(items.find((i) => i.provider === 'exchange')).toMatchObject({
        enabled: true,
        ewsUrl: SERVER,
        ewsAuth: 'ntlm',
        contactsSync: true,
      });
    });
  });

  it('does not let it be switched on without a server', async () => {
    const { user, form } = await exchangeCard();
    await user.click(
      within(form).getByRole('switch', { name: `Kişiler bağlayabilsin · ${TITLE}` }),
    );
    expect(within(form).getByRole('button', { name: 'Kaydet' })).toBeDisabled();
  });

  it('shows no client id or OAuth fields on the Exchange card', async () => {
    const { form } = await exchangeCard();
    expect(within(form).queryByText(/redirect URI/)).toBeNull();
    expect(within(form).queryByLabelText(/Client ID/)).toBeNull();
    expect(within(form).queryByText('Kurum genelinde eşitle')).toBeNull();
  });

  it('offers nothing until the admin switched it on', async () => {
    const { dialog } = await calendarSettings();
    await within(dialog).findByText('Bağlı hesaplar');
    expect(within(dialog).queryByRole('button', { name: 'Exchange hesabı bağla' })).toBeNull();
  });

  it("connects with the person's sign-in, and says so when it is refused", async () => {
    await enable();
    // The app's root mounts this; the refusal is told through it.
    render(<Toaster />);
    const { user, dialog } = await calendarSettings();
    await user.click(await within(dialog).findByRole('button', { name: 'Exchange hesabı bağla' }));
    const form = await screen.findByRole('dialog', { name: 'Exchange hesabı bağla' });
    const connect = within(form).getByRole('button', { name: 'Bağla' });
    expect(connect).toBeDisabled();
    await user.type(within(form).getByLabelText('E-posta adresi'), 'bugra@contoso.test');
    const password = within(form).getByLabelText('Şifre');
    expect(password).toHaveAttribute('type', 'password');
    await user.type(password, MOCK_WRONG_EXCHANGE_PASSWORD);
    await user.click(connect);
    await screen.findByText(/Exchange girişi reddetti/);
    // The form stays, so a typo is one fix away.
    expect(screen.getByRole('dialog', { name: 'Exchange hesabı bağla' })).toBeInTheDocument();
    await user.clear(password);
    await user.type(password, PASSWORD);
    await user.click(connect);
    const row = await within(dialog).findByRole('listitem', { name: 'bugra@contoso.test' });
    expect(within(row).getByText('E')).toBeInTheDocument();
    expect(within(row).getByText(/^Exchange ·/)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Exchange hesabı bağla' })).toBeNull(),
    );
  });

  it('connects a revoked account again from a form, not a redirect', async () => {
    await enable();
    setMockCalendarAccounts([
      {
        id: '0190f0a0-0000-7000-8000-00000000ec01',
        provider: 'exchange',
        email: 'bugra@contoso.test',
        status: 'revoked',
        lastError: 'calendar_account_revoked',
        lastSyncedAt: null,
        calendars: [],
        createdAt: '2026-10-20T10:00:00.000Z',
        delegated: false,
        busyOnly: false,
        contacts: null,
      },
    ]);
    const { user, dialog } = await calendarSettings();
    const row = await within(dialog).findByRole('listitem', { name: 'bugra@contoso.test' });
    expect(within(row).queryByRole('link', { name: 'Yeniden bağla' })).toBeNull();
    await user.click(within(row).getByRole('button', { name: 'Yeniden bağla' }));
    const form = await screen.findByRole('dialog', { name: 'Exchange hesabı bağla' });
    expect(within(form).getByLabelText('E-posta adresi')).toHaveValue('bugra@contoso.test');
  });
});
