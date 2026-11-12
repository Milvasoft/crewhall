import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Toaster } from '@crewhall/ui';
import { render } from '@testing-library/react';
import { api } from '@/lib/api';
import { resetMeetMock } from '@/mocks/meet';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

const ROOM = 'Milvasoft Daily';

async function openMenu(user: ReturnType<typeof userEvent.setup>, title = ROOM) {
  const buttons = await screen.findAllByRole('button', { name: `${title} için işlemler` });
  await user.click(buttons[0]!);
  return screen.findByRole('menu');
}

describe('persistent room actions (rename, link, delete)', () => {
  it('renames a room; the link stays', async () => {
    resetMeetMock();
    signedInAs(USER.bugra);
    render(<Toaster />);
    renderApp('/meetings');
    const user = userEvent.setup();
    const menu = await openMenu(user);
    expect(within(menu).getByRole('menuitem', { name: 'Bağlantıyı kopyala' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Bağlantıyı yenile' })).toBeInTheDocument();
    await user.click(within(menu).getByRole('menuitem', { name: 'Adını değiştir' }));
    const dialog = await screen.findByRole('dialog', { name: 'Odanın adını değiştir' });
    expect(within(dialog).getByText(/^Bağlantı değişmez: /)).toBeInTheDocument();
    const input = within(dialog).getByLabelText('Oda adı');
    await user.clear(input);
    expect(within(dialog).getByRole('button', { name: 'Kaydet' })).toBeDisabled();
    await user.type(input, 'Günlük toplantı');
    await user.click(within(dialog).getByRole('button', { name: 'Kaydet' }));
    expect(await screen.findByText('Odanın adı değişti')).toBeInTheDocument();
    expect((await screen.findAllByText('Günlük toplantı')).length).toBeGreaterThan(0);
  });

  it('deletes a room after a confirmation, and not while a meeting goes on in it', async () => {
    resetMeetMock();
    signedInAs(USER.bugra);
    const home = await api.call('getMeetHome', { query: {} });
    const room = home.rooms.find((r) => r.title === ROOM)!;
    await api.call('joinMeeting', { params: { meetingId: room.id }, body: {} });
    const view = renderApp('/meetings');
    const user = userEvent.setup();
    let menu = await openMenu(user);
    expect(within(menu).getByRole('menuitem', { name: 'Sil' })).toHaveAttribute('data-disabled');
    await user.keyboard('{Escape}');
    view.unmount();

    // The meeting ends: now the room can go.
    await api.call('endMeetingForAll', { params: { meetingId: room.id } });
    renderApp('/meetings');
    menu = await openMenu(user);
    await user.click(within(menu).getByRole('menuitem', { name: 'Sil' }));
    const dialog = await screen.findByRole('dialog', { name: `${ROOM} silinsin mi?` });
    expect(
      within(dialog).getByText(/Geçmiş toplantılar, kayıtlar ve özetler kalır/),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Sil' }));
    await waitFor(() =>
      expect(screen.queryAllByRole('button', { name: `${ROOM} için işlemler` })).toHaveLength(0),
    );
    expect((await api.call('getMeetingLink', { params: { slug: room.slug } })).status).toBe(
      'ended',
    );
  });

  it('shows only "Bağlantıyı kopyala" to someone who is not a moderator of the room', async () => {
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
