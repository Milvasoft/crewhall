import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Toaster } from '@crewhall/ui';
import { api } from '@/lib/api';
import { resetMeetMock } from '@/mocks/meet';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

const ROOM = 'Milvasoft Daily';
const REJOIN = 'Yeniden katıl';

/** A room with `sessions` finished sessions in its history. */
async function finishedRoom(sessions = 1) {
  resetMeetMock();
  signedInAs(USER.bugra);
  const home = await api.call('getMeetHome', { query: {} });
  const room = home.rooms.find((r) => r.title === ROOM)!;
  for (let i = 0; i < sessions; i++) {
    await api.call('joinMeeting', { params: { meetingId: room.id }, body: {} });
    await api.call('endMeetingForAll', { params: { meetingId: room.id } });
  }
  return room;
}

/** The table and the phone cards are both in the DOM; CSS shows one of them. */
const tableScope = async () => within((await screen.findByRole('table')) as HTMLElement);

describe('rejoining from the meeting history', () => {
  it('links an open meeting to its room', async () => {
    const room = await finishedRoom();
    renderApp('/meetings?view=history');
    const table = await tableScope();
    const link = await table.findByRole('link', { name: REJOIN });
    expect(link).toHaveAttribute('href', `/meetings/room/${room.slug}`);
  });

  it('offers the room once when it has several sessions', async () => {
    await finishedRoom(3);
    renderApp('/meetings?view=history');
    const table = await tableScope();
    expect(await table.findAllByRole('link', { name: ROOM })).toHaveLength(3);
    expect(table.getAllByRole('link', { name: REJOIN })).toHaveLength(1);
  });

  it('shows no button or column once the meeting is cancelled', async () => {
    const room = await finishedRoom();
    await api.call('cancelMeeting', { params: { meetingId: room.id } });
    renderApp('/meetings?view=history');
    const table = await tableScope();
    await table.findByRole('link', { name: ROOM });
    expect(table.queryByRole('link', { name: REJOIN })).not.toBeInTheDocument();
    expect(table.queryByText('İşlemler')).not.toBeInTheDocument();
  });

  it('says the meeting has ended when the room is opened after it closed', async () => {
    const room = await finishedRoom();
    await api.call('cancelMeeting', { params: { meetingId: room.id } });
    renderApp(`/meetings/room/${room.slug}`);
    expect(await screen.findByText('Bu toplantı sona erdi')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Katıl' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Toplantılara dön' })).toHaveAttribute(
      'href',
      '/meetings',
    );
  });

  it('explains it when the meeting closes after the waiting room opened', async () => {
    const room = await finishedRoom();
    render(<Toaster />);
    renderApp(`/meetings/room/${room.slug}`);
    const join = await screen.findByRole('button', { name: 'Katıl' });
    await waitFor(() => expect(join).toBeEnabled());
    await api.call('cancelMeeting', { params: { meetingId: room.id } });
    await userEvent.setup().click(join);
    expect(await screen.findByText('Bu toplantı sona erdi.')).toBeInTheDocument();
    expect(await screen.findByText('Bu toplantı sona erdi')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Katıl' })).not.toBeInTheDocument();
  });
});
