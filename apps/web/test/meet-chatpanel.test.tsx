import { ApiError } from '@crewhall/api-client';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatPanel } from '@/components/meet/room/ChatPanel';

import { api } from '@/lib/api';
import { I18nProvider } from '@/lib/i18n/I18nContext';
import { createQueryClient } from '@/lib/queryClient';

let state: Record<string, unknown> = {};
vi.mock('@livekit/components-react', () => ({
  useChat: () => ({ chatMessages: [], send: vi.fn() }),
}));
vi.mock('../src/components/meet/room/context', () => ({ useRoomState: () => state }));
vi.mock('../src/lib/session', () => ({ useMe: () => ({ user: { id: 'me' } }) }));

function renderPanel() {
  render(
    <I18nProvider locale="tr">
      <QueryClientProvider client={createQueryClient()}>
        <ChatPanel />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

const meeting = { conversationId: 'dm-1', chatConversationId: 'meeting-chat' };
const listed = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls
    .filter((c) => c[0] === 'listMessages')
    .map((c) => (c[1] as { params: { conversationId: string } }).params.conversationId);

afterEach(() => vi.restoreAllMocks());

describe('the chat inside a meeting', () => {
  it("a one-to-one call opens the two people's direct chat", async () => {
    state = { meeting, callId: 'call-1', guest: false, setPanel: vi.fn() };
    const spy = vi
      .spyOn(api, 'call')
      .mockImplementation(((name: string) =>
        Promise.resolve(
          name === 'getCall'
            ? { id: 'call-1', conversationId: 'dm-1', conversationTitle: null }
            : { items: [], nextCursor: null },
        )) as never);
    renderPanel();
    await waitFor(() => expect(listed(spy)).toContain('dm-1'));
    expect(listed(spy)).not.toContain('meeting-chat');
  });

  it("a group call and a meeting use the meeting's own chat", async () => {
    state = { meeting, callId: 'call-2', guest: false, setPanel: vi.fn() };
    const spy = vi
      .spyOn(api, 'call')
      .mockImplementation(((name: string) =>
        Promise.resolve(
          name === 'getCall'
            ? { id: 'call-2', conversationId: 'group-1', conversationTitle: 'Ekip' }
            : { items: [], nextCursor: null },
        )) as never);
    renderPanel();
    await waitFor(() => expect(listed(spy)).toContain('meeting-chat'));
    expect(listed(spy)).not.toContain('group-1');
  });

  it("marks a guest's message in the members' chat", async () => {
    state = { meeting, callId: null, guest: false, setPanel: vi.fn() };
    vi.spyOn(api, 'call').mockResolvedValue({
      items: [
        {
          id: 'm1',
          kind: 'user',
          author: null,
          guestAuthor: { name: 'Deniz Kaya' },
          text: 'merhaba',
          createdAt: new Date().toISOString(),
          deletedAt: null,
        },
      ],
    } as never);
    renderPanel();
    expect(await screen.findByText('Deniz Kaya')).toBeInTheDocument();
    expect(screen.getByText('Misafir')).toBeInTheDocument();
    expect(screen.getByText('merhaba')).toBeInTheDocument();
  });
});

describe('the same chat for a guest', () => {
  const ticket = { requestId: 'lobby-1', secret: 's'.repeat(32) };
  const line = (id: string, name: string, text: string, mine = false, guest = false) => ({
    id,
    name,
    text,
    mine,
    guest,
    createdAt: new Date().toISOString(),
  });

  it('reads and writes through the guest path, never the chat api', async () => {
    state = { meeting: null, callId: null, guest: true, guestTicket: ticket, setPanel: vi.fn() };
    const spy = vi
      .spyOn(api, 'call')
      .mockImplementation(((name: string) =>
        Promise.resolve(
          name === 'listGuestChat'
            ? {
                items: [
                  line('1', 'Elif Yıldız', 'hoş geldin'),
                  line('2', 'Deniz', 'selam', true, true),
                ],
              }
            : line('3', 'Deniz', 'teşekkürler', true, true),
        )) as never);
    renderPanel();
    expect(await screen.findByText('hoş geldin')).toBeInTheDocument();
    expect(screen.getByText('Elif Yıldız')).toBeInTheDocument();

    const u = userEvent.setup();
    await u.type(screen.getByPlaceholderText('Mesaj yaz…'), 'teşekkürler{Enter}');
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith(
        'sendGuestChat',
        expect.objectContaining({
          params: { requestId: 'lobby-1' },
          body: expect.objectContaining({ secret: ticket.secret, text: 'teşekkürler' }),
        }),
      ),
    );
    expect(spy.mock.calls.map((c) => c[0])).not.toContain('listMessages');
    expect(spy.mock.calls.map((c) => c[0])).not.toContain('sendMessage');
  });

  it('uses the live channel when the meeting has no chat', async () => {
    state = { meeting: null, callId: null, guest: true, guestTicket: ticket, setPanel: vi.fn() };
    vi.spyOn(api, 'call').mockRejectedValue(new ApiError(404, 'not_found', ''));
    renderPanel();
    expect(await screen.findByText('Toplantı bitince bu mesajlar kaybolur')).toBeInTheDocument();
  });
});
