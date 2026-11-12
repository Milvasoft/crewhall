import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Toaster } from '@crewhall/ui';
import { api } from '@/lib/api';
import { resetMeetMock } from '@/mocks/meet';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

const TITLE = 'Opsiyon · ürün demosu';

async function openMenu(user: ReturnType<typeof userEvent.setup>, title = TITLE) {
  const buttons = await screen.findAllByRole('button', { name: `${title} için işlemler` });
  await user.click(buttons[0]!);
  return screen.findByRole('menu');
}

describe('scheduled meeting actions (edit, people, cancel)', () => {
  it('edits everything of a scheduled meeting in one dialog', async () => {
    resetMeetMock();
    signedInAs(USER.bugra);
    render(<Toaster />);
    renderApp('/meetings');
    const user = userEvent.setup();
    const menu = await openMenu(user);
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((i) => i.textContent),
    ).toEqual(['Düzenle', 'Bağlantıyı kopyala', 'Davetlileri yönet', 'İptal et']);
    await user.click(within(menu).getByRole('menuitem', { name: 'Düzenle' }));
    const dialog = await screen.findByRole('dialog', { name: 'Toplantıyı düzenle' });
    expect(within(dialog).getByLabelText('Açıklama')).toHaveValue(
      'Opsiyon yönetim paneli demosu ve ilk geri bildirimler.',
    );
    const title = within(dialog).getByLabelText('Başlık');
    await user.clear(title);
    expect(within(dialog).getByRole('button', { name: 'Kaydet' })).toBeDisabled();
    await user.type(title, 'Opsiyon demosu (ertelendi)');
    await user.click(within(dialog).getByRole('button', { name: 'Kaydet' }));
    expect(
      await screen.findByText('Toplantı güncellendi; katılımcılara bildirildi'),
    ).toBeInTheDocument();
    expect((await screen.findAllByText('Opsiyon demosu (ertelendi)')).length).toBeGreaterThan(0);
    const home = await api.call('getMeetHome', { query: {} });
    expect(home.today.find((m) => m.title === 'Opsiyon demosu (ertelendi)')).toBeTruthy();
  });

  it('"Davetlileri yönet" opens on the people field', async () => {
    resetMeetMock();
    signedInAs(USER.bugra);
    renderApp('/meetings');
    const user = userEvent.setup();
    const menu = await openMenu(user);
    await user.click(within(menu).getByRole('menuitem', { name: 'Davetlileri yönet' }));
    const dialog = await screen.findByRole('dialog', { name: 'Toplantıyı düzenle' });
    await waitFor(() =>
      expect(within(dialog).getByPlaceholderText(/Kişi ya da e-posta/)).toHaveFocus(),
    );
    expect(within(dialog).getByText('deniz.kaya@opsiyon.com.tr')).toBeInTheDocument();
  });

  it('cancels after a confirmation and the meeting leaves the list', async () => {
    resetMeetMock();
    signedInAs(USER.bugra);
    renderApp('/meetings');
    const user = userEvent.setup();
    const menu = await openMenu(user);
    await user.click(within(menu).getByRole('menuitem', { name: 'İptal et' }));
    const dialog = await screen.findByRole('dialog', { name: `${TITLE} iptal edilsin mi?` });
    await user.click(within(dialog).getByRole('button', { name: 'İptal et' }));
    await waitFor(() =>
      expect(screen.queryAllByRole('button', { name: `${TITLE} için işlemler` })).toHaveLength(0),
    );
  });

  it('shows only "Bağlantıyı kopyala" to someone who cannot change it', async () => {
    resetMeetMock();
    signedInAs(USER.elif);
    renderApp('/meetings');
    const user = userEvent.setup();
    const menu = await openMenu(user);
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((i) => i.textContent),
    ).toEqual(['Bağlantıyı kopyala']);
  });
});
