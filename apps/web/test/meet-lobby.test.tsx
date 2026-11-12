import { QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type MeetSignal } from '@crewhall/shared';
import { useLobby } from '@/components/meet/room/ParticipantsPanel';
import { api } from '@/lib/api';
import { I18nProvider } from '@/lib/i18n/I18nContext';
import { createQueryClient } from '@/lib/queryClient';

type Listener = (s: MeetSignal) => void;
const listeners = new Set<Listener>();
const state = {
  meeting: { id: 'm1' },
  moderator: true,
  guest: false,
  setLobbyWaiting: vi.fn(),
  onSignal: (fn: Listener) => {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  },
};

vi.mock('@livekit/components-react', () => ({}));
vi.mock('../src/components/meet/room/context', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useRoomState: () => state,
}));

function Lobby() {
  useLobby();
  return null;
}

/** The lobby card and the people panel both watch the lobby. */
function Room({ panels }: { panels: number }) {
  return (
    <>
      {Array.from({ length: panels }, (_, i) => (
        <Lobby key={i} />
      ))}
    </>
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  listeners.clear();
});

describe('the lobby watch in the room', () => {
  it('does not refetch on every remount or every lobby signal', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const call = vi.spyOn(api, 'call').mockResolvedValue({ items: [], lobby: [] } as never);
    const client = createQueryClient();
    const view = render(
      <I18nProvider locale="tr">
        <QueryClientProvider client={client}>
          <Room panels={2} />
        </QueryClientProvider>
      </I18nProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(call).toHaveBeenCalledTimes(1);

    // The room re-renders and panels open and close: still the same answer.
    for (let i = 0; i < 20; i++) {
      view.rerender(
        <I18nProvider locale="tr">
          <QueryClientProvider client={client}>
            <Room panels={i % 2 ? 1 : 2} />
          </QueryClientProvider>
        </I18nProvider>,
      );
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(call).toHaveBeenCalledTimes(1);

    // A burst of knocks: one refetch.
    act(() => {
      for (let i = 0; i < 30; i++) for (const l of listeners) l({ type: 'lobby', waiting: i });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(call).toHaveBeenCalledTimes(2);

    // A steady stream (10 a second for 3 seconds): at most one refetch a second.
    for (let i = 0; i < 30; i++) {
      act(() => {
        for (const l of listeners) l({ type: 'lobby', waiting: i });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(call.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(call.mock.calls.length).toBeLessThanOrEqual(6);
    view.unmount();
  });
});
