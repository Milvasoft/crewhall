import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAudioFactoryForTests, setMessageSoundOn } from '@/lib/chat/sound';
import { announceRing, askForCallNotifications, playTone, ringSilenced } from '@/lib/meet/ring';

/** Records what Web Audio is asked to do. */
class FakeContext {
  state: AudioContextState = 'running';
  sampleRate = 8000;
  destination = {};
  sources: { loop: boolean; started: boolean; stopped: boolean; length: number }[] = [];
  resume() {
    return Promise.resolve();
  }
  createBuffer(_channels: number, length: number) {
    const data = new Float32Array(length);
    return { length, getChannelData: () => data };
  }
  createBufferSource() {
    const s = {
      loop: false,
      started: false,
      stopped: false,
      length: 0,
      buffer: null as { length: number } | null,
      connect: () => undefined,
      disconnect: () => undefined,
      start: () => {
        s.started = true;
        s.length = s.buffer?.length ?? 0;
      },
      stop: () => {
        s.stopped = true;
      },
    };
    this.sources.push(s);
    return s;
  }
}

let ctx: FakeContext;
let plays: string[] = [];

beforeEach(() => {
  ctx = new FakeContext();
  setAudioFactoryForTests(() => ctx as unknown as AudioContext);
  setMessageSoundOn(true);
  plays = [];
});
afterEach(() => {
  vi.restoreAllMocks();
  setAudioFactoryForTests(null);
  setMessageSoundOn(true);
});

describe('call sounds on the web (H7)', () => {
  it('plays the committed file in a loop', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (
      this: HTMLMediaElement,
    ) {
      plays.push(`${this.src} loop=${String(this.loop)}`);
      return Promise.resolve();
    });
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    const stop = playTone('incoming');
    await Promise.resolve();
    expect(plays).toEqual([expect.stringMatching(/\/sounds\/call-incoming\.wav loop=true$/)]);
    expect(ctx.sources).toEqual([]);
    stop();
    expect(pause).toHaveBeenCalled();
  });

  it('renders the same melody with Web Audio when the file cannot play', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(new Error('NotAllowedError'));
    const stop = playTone('ringback');
    await vi.waitFor(() => expect(ctx.sources).toHaveLength(1));
    const [source] = ctx.sources;
    expect(source).toMatchObject({ loop: true, started: true });
    // One 4 s ringback cycle at the context's rate.
    expect(source!.length).toBe(4 * ctx.sampleRate);
    stop();
    expect(source!.stopped).toBe(true);
  });

  it('stays silent with the message sound off, in do-not-disturb or quiet hours', () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play');
    setMessageSoundOn(false);
    playTone('incoming')();
    expect(play).not.toHaveBeenCalled();
    setMessageSoundOn(true);

    const qc = new QueryClient();
    const noon = new Date('2026-10-22T12:00:00');
    expect(ringSilenced(qc, 'me', noon)).toBe(false);
    qc.setQueryData(['me', 'notification-prefs'], { quietHours: { from: '11:00', to: '13:00' } });
    qc.setQueryData(['me', 'chat-settings'], { timezone: null });
    expect(ringSilenced(qc, 'me', noon)).toBe(true);
    playTone('incoming', { silent: true })();
    expect(play).not.toHaveBeenCalled();
  });
});

describe('a ringing call is noticed without sound', () => {
  it('blinks the title and shows a system notification while the tab is hidden', () => {
    vi.useFakeTimers();
    const shown: { title: string; options: NotificationOptions; closed: boolean }[] = [];
    class FakeNotification {
      static permission: NotificationPermission = 'granted';
      static requestPermission = vi.fn(() => Promise.resolve('granted' as NotificationPermission));
      onclick: (() => void) | null = null;
      entry: { title: string; options: NotificationOptions; closed: boolean };
      constructor(title: string, options: NotificationOptions) {
        this.entry = { title, options, closed: false };
        shown.push(this.entry);
      }
      close() {
        this.entry.closed = true;
      }
    }
    vi.stubGlobal('Notification', FakeNotification);
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.title = 'Crewhall';
    const stop = announceRing('Ahmet arıyor', { tag: 'call-1', body: 'Sprint' });
    expect(shown).toEqual([
      expect.objectContaining({
        title: 'Ahmet arıyor',
        options: expect.objectContaining({
          tag: 'call-1',
          body: 'Sprint',
          requireInteraction: true,
        }),
      }),
    ]);
    vi.advanceTimersByTime(1000);
    expect(document.title).toBe('📞 Ahmet arıyor');
    vi.advanceTimersByTime(1000);
    expect(document.title).toBe('Crewhall');
    stop();
    expect(shown[0]!.closed).toBe(true);
    expect(document.title).toBe('Crewhall');

    // A visible tab gets no system notification; permission is asked once, on a click.
    visibility.mockReturnValue('visible');
    announceRing('Ahmet arıyor', { tag: 'call-2' })();
    expect(shown).toHaveLength(1);
    // Visible, but nobody clicked in the page yet: the ring is silent, the notification is not.
    vi.stubGlobal('navigator', { ...navigator, userActivation: { hasBeenActive: false } });
    announceRing('Ahmet arıyor', { tag: 'call-3' })();
    expect(shown).toHaveLength(2);
    expect(shown[1]!.options.tag).toBe('call-3');
    vi.stubGlobal('navigator', { ...navigator, userActivation: { hasBeenActive: true } });
    announceRing('Ahmet arıyor', { tag: 'call-4' })();
    expect(shown).toHaveLength(2);
    FakeNotification.permission = 'default';
    askForCallNotifications();
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
});
