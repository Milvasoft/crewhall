import { TooltipProvider } from '@crewhall/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MeetingChatJoin, MeetingChatStrip } from '@/components/meet/MeetingChat';
import { api } from '@/lib/api';
import { type Conversation } from '@/lib/chat/types';
import { I18nProvider } from '@/lib/i18n/I18nContext';
import { useMeetingLive } from '@/lib/meet/live';
import { readPrefs } from '@/lib/meet/prefs';
import { createQueryClient } from '@/lib/queryClient';

const open = vi.fn();
vi.mock('../src/components/meet/openMeeting', () => ({ useOpenMeeting: () => open }));
vi.mock('../src/lib/identity/modules', () => ({ useModuleEnabled: () => true }));
vi.mock('../src/lib/session', () => ({ usePermissions: () => ({ role: 'member' }) }));

const conv = { id: 'c1', type: 'meeting', meetingId: 'room-1' } as unknown as Conversation;
const person = (name: string) => ({ name, user: null });
const meeting = (live: boolean) => ({
  id: 'room-1',
  slug: 'genel',
  cancelledAt: null,
  permissions: { join: true },
  live: live
    ? {
        participantCount: 3,
        participants: [person('Elif'), person('Mert'), person('Can')],
      }
    : null,
});

function renderBoth() {
  render(
    <I18nProvider locale="tr">
      <QueryClientProvider client={createQueryClient()}>
        <TooltipProvider>
          <MeetingChatJoin conv={conv} />
          <MeetingChatStrip conv={conv} />
        </TooltipProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  open.mockReset();
});

describe('joining a room from its chat', () => {
  it('offers voice and video joins in the header', async () => {
    vi.spyOn(api, 'call').mockResolvedValue(meeting(false) as never);
    renderBoth();
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Odaya sesli katıl' }));
    expect(open).toHaveBeenCalledWith('genel');
    expect(readPrefs().joinCameraOff).toBe(true);
    await u.click(screen.getByRole('button', { name: 'Odaya görüntülü katıl' }));
    expect(readPrefs().joinCameraOff).toBe(false);
    // Nobody inside: no strip.
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows a strip with the people inside while the meeting goes on', async () => {
    vi.spyOn(api, 'call').mockResolvedValue(meeting(true) as never);
    renderBoth();
    expect(await screen.findByText('Toplantı sürüyor · 3 kişi')).toBeInTheDocument();
    const u = userEvent.setup();
    await u.click(screen.getByRole('button', { name: 'Katıl' }));
    expect(open).toHaveBeenCalledWith('genel');
  });
});

describe('a meeting chat in the chat list', () => {
  it('is live while people are in its meeting', async () => {
    vi.spyOn(api, 'call').mockResolvedValue({
      live: [],
      today: [],
      rooms: [meeting(true), { ...meeting(false), id: 'room-2' }],
      upcomingCount: 0,
      recordingCount: 0,
    } as never);
    const client = createQueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const one = renderHook(() => useMeetingLive('room-1'), { wrapper });
    const two = renderHook(() => useMeetingLive('room-2'), { wrapper });
    await waitFor(() => expect(one.result.current).toBe(true));
    expect(two.result.current).toBe(false);
  });
});
