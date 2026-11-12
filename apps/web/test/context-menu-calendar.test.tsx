import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addMockEvent, calendarMockState, resetCalendarMock } from '@/mocks/calendar';
import { contactsMockState, resetContactsMock } from '@/mocks/contacts';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** Right-click menus of the calendar (slots, days, events) and the contacts lists. */

const names = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole('menuitem')
    .map((el) => el.textContent?.trim() ?? '');

const stored = (title: string) =>
  calendarMockState().events.find((e) => e.title === title && !e.parentId)!;

describe('calendar › right-click menus', () => {
  beforeEach(() => {
    // Thursday 22 October 2026, 12:00 in Istanbul.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-22T09:00:00Z') });
    resetCalendarMock();
    signedInAs(USER.bugra);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates an event from the half hour right-clicked on the empty grid', async () => {
    renderApp('/calendar?view=week&date=2026-10-22');
    const user = userEvent.setup();
    const columns = await screen.findByTestId('calendar-columns');
    const day = columns.querySelector<HTMLElement>('[data-date="2026-10-22"]')!;
    // The grid starts at 0 in jsdom: 10 hours of 48 px, a little into the hour.
    fireEvent.contextMenu(day, { clientY: 10 * 48 + 10 });
    const menu = await screen.findByRole('menu');
    expect(names(menu)).toEqual(['Yeni etkinlik · 10:00']);
    await user.click(within(menu).getByRole('menuitem', { name: 'Yeni etkinlik · 10:00' }));
    const dialog = await screen.findByRole('dialog', { name: 'Yeni etkinlik' });
    await user.type(within(dialog).getByLabelText('Başlık'), 'Sağ tık toplantısı');
    await user.click(within(dialog).getByRole('button', { name: 'Oluştur' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(stored('Sağ tık toplantısı')).toMatchObject({
      allDay: false,
      start: '2026-10-22T07:00:00.000Z',
      end: '2026-10-22T08:00:00.000Z',
    });
  });

  it('creates an all-day event from a month day', async () => {
    renderApp('/calendar?view=month&date=2026-10-22');
    const user = userEvent.setup();
    const grid = await screen.findByTestId('calendar-month-grid');
    fireEvent.contextMenu(grid.querySelector<HTMLElement>('[data-date="2026-10-27"]')!);
    const menu = await screen.findByRole('menu');
    await user.click(within(menu).getByRole('menuitem', { name: /^Yeni etkinlik · 27/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Yeni etkinlik' });
    await user.type(within(dialog).getByLabelText('Başlık'), 'Bayram hazırlığı');
    await user.click(within(dialog).getByRole('button', { name: 'Oluştur' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(stored('Bayram hazırlığı')).toMatchObject({
      allDay: true,
      start: '2026-10-27',
      end: '2026-10-28',
    });
  });

  it('opens, edits and deletes an event from its menu; a right press does not drag it', async () => {
    addMockEvent({
      ownerId: USER.bugra,
      title: 'Demo',
      start: '2026-10-21T11:00:00.000Z',
      end: '2026-10-21T12:00:00.000Z',
    });
    renderApp('/calendar?view=week&date=2026-10-22');
    const user = userEvent.setup();
    const demo = await screen.findByRole('button', { name: /^Demo,/ });

    // The right button never starts a drag (dnd-kit's mouse sensor ignores it).
    fireEvent.mouseDown(demo, { clientX: 350, clientY: 300, button: 2 });
    fireEvent.mouseMove(document, { clientX: 356, clientY: 306 });
    fireEvent.mouseMove(document, { clientX: 500, clientY: 500 });
    expect(screen.queryByTestId('calendar-ghost')).toBeNull();
    fireEvent.mouseUp(document, { clientX: 500, clientY: 500 });

    fireEvent.contextMenu(demo);
    let menu = await screen.findByRole('menu');
    expect(names(menu)).toEqual(['Aç', 'Düzenle', 'Sil']);
    await user.click(within(menu).getByRole('menuitem', { name: 'Aç' }));
    expect(await screen.findByTestId('calendar-event-panel')).toHaveAccessibleName('Demo');

    fireEvent.contextMenu(demo);
    menu = await screen.findByRole('menu');
    await user.click(within(menu).getByRole('menuitem', { name: 'Düzenle' }));
    const dialog = await screen.findByRole('dialog', { name: 'Etkinliği düzenle' });
    expect(within(dialog).getByLabelText('Başlık')).toHaveValue('Demo');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    fireEvent.contextMenu(screen.getByRole('button', { name: /^Demo,/ }));
    menu = await screen.findByRole('menu');
    await user.click(within(menu).getByRole('menuitem', { name: 'Sil' }));
    await waitFor(() => expect(stored('Demo').deleted).toBe(true));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Demo,/ })).toBeNull());
    // The panel of the deleted event closes with it.
    expect(screen.queryByTestId('calendar-event-panel')).toBeNull();
  });

  it("offers to join an event's meeting and hides editing on others' events", async () => {
    const mine = addMockEvent({
      ownerId: USER.bugra,
      title: 'Teklif görüşmesi',
      start: '2026-10-22T11:00:00.000Z',
      end: '2026-10-22T12:00:00.000Z',
    });
    mine.meeting = {
      id: '0190f0a0-0000-7000-8000-00000000e001',
      slug: 'teklif-gorusmesi',
      url: 'http://localhost/m/teklif-gorusmesi',
    };
    addMockEvent({
      ownerId: USER.elif,
      title: 'Elif planı',
      start: '2026-10-23T08:00:00.000Z',
      end: '2026-10-23T09:00:00.000Z',
      inviteIds: [USER.bugra],
    });
    renderApp('/calendar?view=week&date=2026-10-22');

    fireEvent.contextMenu(await screen.findByRole('button', { name: /^Teklif görüşmesi,/ }));
    let menu = await screen.findByRole('menu');
    // The join item comes once the event (with its meeting) is read.
    await within(menu).findByRole('menuitem', { name: 'Toplantıya katıl' });
    expect(names(menu)).toEqual(['Aç', 'Toplantıya katıl', 'Düzenle', 'Sil']);
    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

    fireEvent.contextMenu(await screen.findByRole('button', { name: /^Elif planı,/ }));
    menu = await screen.findByRole('menu');
    expect(names(menu)).toEqual(['Aç']);
  });
});

describe('contacts › right-click menus', () => {
  beforeEach(() => {
    resetContactsMock();
    signedInAs(USER.bugra);
  });

  it('offers a person the profile, e-mail, chat and copies; copies the e-mail', async () => {
    contactsMockState().profiles[USER.mert]!.phone = '+90 212 555 01 02';
    renderApp('/contacts');
    const user = userEvent.setup();
    const list = await screen.findByTestId('directory-list');
    fireEvent.contextMenu(within(list).getByRole('button', { name: /Mert/ }));
    const menu = await screen.findByRole('menu');
    expect(names(menu)).toEqual([
      'Profili aç',
      'E-posta gönder',
      'Sohbet başlat',
      'E-postayı kopyala',
      'Telefonu kopyala',
    ]);
    await user.click(within(menu).getByRole('menuitem', { name: 'E-postayı kopyala' }));
    expect(await navigator.clipboard.readText()).toBe('mert@milvasoft.com');
  });

  it('does not offer a chat with oneself in the org chart', async () => {
    renderApp('/contacts/org-chart');
    const chart = await screen.findByTestId('org-chart');
    const me = within(chart)
      .getAllByRole('button', { name: /^Ahmet Buğra Kösen/ })
      .find((b) => b.hasAttribute('aria-pressed'))!;
    fireEvent.contextMenu(me);
    const menu = await screen.findByRole('menu');
    expect(names(menu)).toEqual(['Profili aç', 'E-posta gönder', 'E-postayı kopyala']);
  });

  it('edits and deletes an external contact from its row', async () => {
    const at = new Date().toISOString();
    contactsMockState().contacts.push({
      id: '0190f0a0-0000-7000-8000-00000000c001',
      kind: 'customer',
      firstName: 'Ayşe',
      lastName: 'Yılmaz',
      displayName: 'Ayşe Yılmaz',
      companyId: null,
      jobTitle: null,
      emails: [{ type: 'work', value: 'ayse@example.com' }],
      phones: [{ type: 'mobile', value: '+90 555 000 11 22' }],
      address: null,
      website: null,
      birthday: null,
      notes: null,
      tags: [],
      visibility: 'org',
      createdBy: USER.bugra,
      createdAt: at,
      updatedAt: at,
    });
    renderApp('/contacts/people');
    const user = userEvent.setup();
    const list = await screen.findByTestId('contacts-list');
    fireEvent.contextMenu(within(list).getByRole('button', { name: /Ayşe Yılmaz/ }));
    let menu = await screen.findByRole('menu');
    expect(names(menu)).toEqual([
      'Aç',
      'E-posta gönder',
      'E-postayı kopyala',
      'Telefonu kopyala',
      'Düzenle',
      'Sil',
    ]);
    await user.click(within(menu).getByRole('menuitem', { name: 'Düzenle' }));
    expect(await screen.findByRole('dialog', { name: 'Kişiyi düzenle' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    fireEvent.contextMenu(within(list).getByRole('button', { name: /Ayşe Yılmaz/ }));
    menu = await screen.findByRole('menu');
    await user.click(within(menu).getByRole('menuitem', { name: 'Sil' }));
    await waitFor(() => expect(contactsMockState().contacts).toHaveLength(0));
    await waitFor(() => expect(screen.queryByText('Ayşe Yılmaz')).toBeNull());
  });
});
