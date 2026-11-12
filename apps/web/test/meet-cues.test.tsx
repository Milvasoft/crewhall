import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, renderHook } from '@testing-library/react';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cueAllowed,
  CUE_BURST_MS,
  ModuleChatWatch,
  previewLine,
  SPEAK_LOWERS_MS,
  useHandCues,
  usePresenceCues,
} from '@/components/meet/room/roomCues';
import { api } from '@/lib/api';
import { I18nProvider } from '@/lib/i18n/I18nContext';
import { writePrefs } from '@/lib/meet/prefs';
import { createQueryClient } from '@/lib/queryClient';

const cue = vi.fn();
vi.mock('../src/lib/meet/ring', () => ({ playCue: (k: string) => cue(k) }));
const { toast } = vi.hoisted(() => ({ toast: Object.assign(vi.fn(), { dismiss: vi.fn() }) }));
vi.mock('@crewhall/ui', async (orig) => ({ ...(await orig<object>()), toast }));

class FakeParticipant extends EventEmitter {
  isSpeaking = false;
  attributes: Record<string, string> = {};
  setAttributes = vi.fn((a: Record<string, string>) => {
    Object.assign(this.attributes, a);
    return Promise.resolve();
  });
  constructor(
    public identity: string,
    public name: string,
    public isLocal = false,
  ) {
    super();
  }
}
class FakeRoom extends EventEmitter {
  state = 'connected';
  localParticipant = new FakeParticipant('me', 'Ben', true);
  remoteParticipants = new Map<string, FakeParticipant>();
  join(p: FakeParticipant) {
    this.remoteParticipants.set(p.identity, p);
    this.emit('participantConnected', p);
  }
}
let room = new FakeRoom();
vi.mock('@livekit/components-react', async (orig) => ({
  ...(await orig<object>()),
  useRoomContext: () => room,
}));

const roomState = {
  moderator: false,
  panel: null as string | null,
  setPanel: vi.fn(),
  setUnreadChat: vi.fn(),
};
vi.mock('../src/components/meet/room/context', () => ({
  useRoomState: () => roomState,
  handOf: (p: { attributes: Record<string, string> }) => p.attributes.hand || '',
}));
vi.mock('../src/lib/session', () => ({ useMe: () => ({ user: { id: 'me' } }) }));

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <I18nProvider locale="tr">{children}</I18nProvider>
);

beforeEach(() => {
  room = new FakeRoom();
  writePrefs({ joinLeaveSound: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  cue.mockReset();
  toast.mockReset();
  roomState.setUnreadChat.mockReset();
});

describe('join and leave cues', () => {
  it('stays quiet in a crowd and for a burst of joins', () => {
    expect(cueAllowed([], 0, 9)).toBe(false);
    const recent: number[] = [];
    expect([0, 1, 2, 3].map((i) => cueAllowed(recent, i * 100, 4))).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(cueAllowed(recent, CUE_BURST_MS + 500, 4)).toBe(true);
  });

  it('plays for someone joining later, not for those already inside', () => {
    vi.useFakeTimers();
    renderHook(() => usePresenceCues(), { wrapper });
    room.join(new FakeParticipant('elif', 'Elif Yıldız'));
    expect(cue).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2500);
    room.join(new FakeParticipant('mert', 'Mert Kaya'));
    expect(cue).toHaveBeenCalledWith('joined');
    expect(toast).toHaveBeenCalledWith('Mert Kaya katıldı', expect.anything());
    room.emit('participantDisconnected', room.remoteParticipants.get('mert'));
    expect(cue).toHaveBeenLastCalledWith('left');
  });

  it('shows the toast without the sound when the setting is off', () => {
    vi.useFakeTimers();
    writePrefs({ joinLeaveSound: false });
    renderHook(() => usePresenceCues(), { wrapper });
    vi.advanceTimersByTime(2500);
    room.join(new FakeParticipant('mert', 'Mert Kaya'));
    expect(cue).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledTimes(1);
  });
});

describe('raised hands', () => {
  it('says who raised a hand', () => {
    renderHook(() => useHandCues(), { wrapper });
    const elif = new FakeParticipant('elif', 'Elif Yıldız');
    room.emit('participantAttributesChanged', { hand: new Date().toISOString() }, elif);
    expect(toast).toHaveBeenCalledWith('Elif Yıldız elini kaldırdı', expect.anything());
    // Lowering it says nothing.
    room.emit('participantAttributesChanged', { hand: '' }, elif);
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('lowers my hand when I get the floor and keep talking', () => {
    vi.useFakeTimers();
    renderHook(() => useHandCues(), { wrapper });
    const me = room.localParticipant;
    me.attributes.hand = new Date(Date.now() - 10_000).toISOString();
    me.isSpeaking = true;
    me.emit('isSpeakingChanged', true);
    vi.advanceTimersByTime(SPEAK_LOWERS_MS + 10);
    expect(me.setAttributes).toHaveBeenCalledWith({ hand: '' });
  });

  it('keeps a hand just raised, and a short word does not lower it', () => {
    vi.useFakeTimers();
    renderHook(() => useHandCues(), { wrapper });
    const me = room.localParticipant;
    me.attributes.hand = new Date().toISOString();
    me.isSpeaking = true;
    me.emit('isSpeakingChanged', true);
    vi.advanceTimersByTime(SPEAK_LOWERS_MS + 10);
    expect(me.setAttributes).not.toHaveBeenCalled();
    me.attributes.hand = new Date(Date.now() - 10_000).toISOString();
    me.emit('isSpeakingChanged', true);
    me.isSpeaking = false;
    me.emit('isSpeakingChanged', false);
    vi.advanceTimersByTime(SPEAK_LOWERS_MS + 10);
    expect(me.setAttributes).not.toHaveBeenCalled();
  });
});

describe('the meeting chat while its panel is closed', () => {
  const msg = (id: string, author: string, text: string, at: string) => ({
    id,
    kind: 'user',
    author: { id: author, name: author === 'me' ? 'Ben' : 'Elif Yıldız', imageUrl: null },
    text,
    createdAt: at,
    deletedAt: null,
  });

  it('counts the new messages of others and previews them', async () => {
    let items = [msg('1', 'elif', 'eski', '2026-10-29T08:00:00Z')];
    vi.spyOn(api, 'call').mockImplementation(() =>
      Promise.resolve({ items, nextCursor: null } as never),
    );
    const client = createQueryClient();
    render(
      <I18nProvider locale="tr">
        <QueryClientProvider client={client}>
          <ModuleChatWatch conversationId="c1" />
        </QueryClientProvider>
      </I18nProvider>,
    );
    await vi.waitFor(() => expect(client.getQueryData(['meet', 'chat', 'c1'])).toBeTruthy());
    await act(async () => undefined);
    expect(roomState.setUnreadChat).not.toHaveBeenCalled();
    items = [
      ...items,
      msg('2', 'me', 'benim', '2026-10-29T08:01:00Z'),
      msg('3', 'elif', 'Selam\nikinci satır', '2026-10-29T08:02:00Z'),
    ];
    await act(() => client.refetchQueries());
    await vi.waitFor(() => expect(roomState.setUnreadChat).toHaveBeenCalledTimes(1));
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('keeps the first line of a long message', () => {
    expect(previewLine('\nSelam\nnasılsın')).toBe('Selam');
    expect(previewLine('a'.repeat(100), 10)).toBe(`${'a'.repeat(9)}…`);
  });
});
