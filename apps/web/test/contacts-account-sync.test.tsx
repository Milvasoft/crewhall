import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CalendarAccount } from '@crewhall/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { api } from '@/lib/api';
import { resetCalendarMock, setMockCalendarAccounts } from '@/mocks/calendar';
import { addMockContactVersion, contactsMockState, resetContactsMock } from '@/mocks/contacts';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

const ACCOUNT = '0190f0a0-0000-7000-8000-00000000ac01';

const account = (contacts: CalendarAccount['contacts'], delegated = false): CalendarAccount => ({
  id: ACCOUNT,
  provider: 'microsoft',
  email: 'bugra@contoso.com',
  status: 'active',
  lastError: null,
  lastSyncedAt: null,
  calendars: [],
  createdAt: '2026-10-20T10:00:00.000Z',
  delegated,
  busyOnly: false,
  contacts,
});

/** A contact that came from the account's address book. */
function mirrored() {
  const c = {
    id: '0190f0a0-0000-7000-8000-00000000ac03',
    kind: 'other' as const,
    firstName: 'Anna',
    lastName: 'Yılmaz',
    displayName: 'Anna Yılmaz',
    companyId: null,
    jobTitle: null,
    emails: [],
    phones: [],
    address: null,
    website: null,
    birthday: null,
    notes: null,
    tags: [],
    visibility: 'private' as const,
    createdBy: USER.bugra,
    createdAt: '2026-10-20T10:00:00.000Z',
    updatedAt: '2026-10-20T10:00:00.000Z',
    external: {
      provider: 'microsoft' as const,
      accountId: ACCOUNT,
      email: 'bugra@contoso.com',
    },
  };
  contactsMockState().contacts.push(c);
  return c;
}

const syncing = { status: 'active' as const, lastError: null, lastSyncedAt: null, count: 12 };

/** Outlook contacts on the calendar's connected account. */
describe('account address books', () => {
  beforeEach(() => {
    resetContactsMock();
    resetCalendarMock();
    signedInAs(USER.bugra);
  });

  const newContactDialog = async () => {
    renderApp('/contacts/people');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Yeni kişi' }));
    return { user, dialog: await screen.findByRole('dialog') };
  };

  it('offers a syncing account for a new contact, which then goes there as private', async () => {
    setMockCalendarAccounts([account(syncing)]);
    const { user, dialog } = await newContactDialog();
    await user.type(within(dialog).getByLabelText('Ad'), 'Cem');
    const field = await within(dialog).findByRole('combobox', { name: 'Hesaba da ekle' });
    await user.click(field);
    await user.click(await screen.findByRole('option', { name: 'bugra@contoso.com' }));
    // The account decides: its contacts are private, so the switch goes.
    expect(within(dialog).queryByText('Yalnız ben göreyim')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Ekle' }));
    await waitFor(() =>
      expect(contactsMockState().contacts.find((c) => c.firstName === 'Cem')?.external).toEqual({
        provider: 'microsoft',
        accountId: ACCOUNT,
        email: 'bugra@contoso.com',
      }),
    );
  });

  it('does not offer an account whose address book does not sync', async () => {
    setMockCalendarAccounts([
      account({ status: 'needs_consent', lastError: null, lastSyncedAt: null, count: 0 }),
    ]);
    const { dialog } = await newContactDialog();
    await within(dialog).findByLabelText('Ad');
    expect(within(dialog).queryByText('Hesaba da ekle')).toBeNull();
  });

  it('shows where a mirrored contact comes from, and its lost versions', async () => {
    const c = mirrored();
    addMockContactVersion(c.id, {
      id: '0190f0a0-0000-7000-8000-00000000ac02',
      overwritten: 'crewhall',
      replacedAt: '2026-10-20T10:00:00.000Z',
      firstName: null,
      lastName: null,
      displayName: 'Eski ad',
      company: 'Contoso',
      jobTitle: 'Eski unvan',
      emails: [{ type: 'work', value: 'eski@contoso.com' }],
      phones: [],
      address: null,
      website: null,
      birthday: null,
      notes: null,
      tags: [],
    });
    renderApp('/contacts/people');
    const user = userEvent.setup();
    const list = await screen.findByTestId('contacts-list');
    await user.click(within(list).getByRole('button', { name: new RegExp(c.displayName) }));
    const panel = await screen.findByTestId('contact-panel');
    await within(panel).findByText(/Microsoft hesabınla eşitleniyor: bugra@contoso.com/);
    const versions = await within(panel).findByTestId('contact-versions');
    expect(within(versions).getByText('Önceki sürüm (1)')).toBeInTheDocument();
    const row = within(versions).getByRole('listitem');
    expect(row).toHaveTextContent('Eski ad');
    expect(row).toHaveTextContent("Crewhall'da yazılan sürüm");
    expect(row).toHaveTextContent('eski@contoso.com');
  });

  const calendarSettings = async () => {
    renderApp('/calendar');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Takvim ayarları' }));
    return screen.findByRole('dialog', { name: 'Takvim ayarları' });
  };

  it('tells the person what the address book needs in the calendar settings', async () => {
    setMockCalendarAccounts([
      account({ status: 'needs_consent', lastError: null, lastSyncedAt: null, count: 0 }),
    ]);
    const dialog = await calendarSettings();
    await within(dialog).findByText('Kişileri eşitlemek için hesabı yeniden bağla.');
    expect(within(dialog).getByRole('link', { name: 'Yeniden bağla' })).toBeInTheDocument();
  });

  it('counts what syncs', async () => {
    setMockCalendarAccounts([account(syncing)]);
    const dialog = await calendarSettings();
    await within(dialog).findByText('12 kişi eşitleniyor');
    expect(within(dialog).queryByRole('link', { name: 'Yeniden bağla' })).toBeNull();
  });

  it('points org-wide accounts at the admin', async () => {
    setMockCalendarAccounts([
      account({ status: 'needs_consent', lastError: null, lastSyncedAt: null, count: 0 }, true),
    ]);
    const dialog = await calendarSettings();
    await within(dialog).findByText(/yöneticinin Contacts.ReadWrite/);
    expect(within(dialog).queryByRole('link', { name: 'Yeniden bağla' })).toBeNull();
  });

  it('lets the admin switch the sync on for Microsoft only', async () => {
    renderApp('/admin/calendar');
    const user = userEvent.setup();
    const toggle = async (want: boolean) => {
      // Saving redraws the form: find the switch again each time.
      const switches = await screen.findAllByRole('switch', {
        name: 'Outlook kişilerini de eşitle',
      });
      expect(switches).toHaveLength(1);
      await user.click(switches[0]!);
      const form = switches[0]!.closest('form')!;
      await user.click(within(form).getByRole('button', { name: 'Kaydet' }));
      await waitFor(async () => {
        const { items } = await api.call('getCalendarIntegrations');
        expect(items.find((i) => i.provider === 'microsoft')?.contactsSync).toBe(want);
      });
    };
    await toggle(true);
    await screen.findByRole('switch', { name: 'Outlook kişilerini de eşitle', checked: true });
    await toggle(false);
  });

  it('shows no history for a mirrored contact nothing was lost from', async () => {
    const c = mirrored();
    renderApp('/contacts/people');
    const user = userEvent.setup();
    const list = await screen.findByTestId('contacts-list');
    await user.click(within(list).getByRole('button', { name: new RegExp(c.displayName) }));
    const panel = await screen.findByTestId('contact-panel');
    await within(panel).findByText(/hesabınla eşitleniyor/);
    expect(within(panel).queryByTestId('contact-versions')).toBeNull();
  });
});
