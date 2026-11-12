import { act, fireEvent, render, screen } from '@testing-library/react';
import { Track } from 'livekit-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VolumeBadge, VolumeControl, VolumeProvider } from '@/components/meet/room/Volume';
import { I18nProvider } from '@/lib/i18n/I18nContext';
import { applyVolume, clampVolume, readVolumes, VOLUME, writeVolumes } from '@/lib/meet/volume';

/** A remote participant with a microphone and a screen-share audio track. */
function fakeParticipant(identity: string) {
  const track = () => ({ setAudioContext: vi.fn() });
  const tracks = {
    [Track.Source.Microphone]: track(),
    [Track.Source.ScreenShareAudio]: track(),
  } as Record<string, { setAudioContext: ReturnType<typeof vi.fn> }>;
  return {
    identity,
    tracks,
    setVolume: vi.fn(),
    getTrackPublication: (source: string) =>
      tracks[source] ? { track: tracks[source] } : undefined,
  };
}

let elif = fakeParticipant('user:elif');
const room = {
  name: 'm-room',
  remoteParticipants: new Map<string, unknown>(),
  on: vi.fn(),
  off: vi.fn(),
};

vi.mock('@livekit/components-react', () => ({ useRoomContext: () => room }));
vi.mock('../src/components/meet/room/context', () => ({
  useRoomState: () => ({ meeting: { id: 'meeting-1' } }),
}));
vi.mock('../src/lib/session', () => ({ useMe: () => ({ user: { id: 'me' } }) }));

class FakeAudioContext {
  state = 'running';
  resume = () => Promise.resolve();
}

beforeEach(() => {
  localStorage.clear();
  elif = fakeParticipant('user:elif');
  room.remoteParticipants = new Map([[elif.identity, elif]]);
  vi.stubGlobal('AudioContext', FakeAudioContext);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderControl() {
  return render(
    <I18nProvider locale="tr">
      <VolumeProvider>
        <VolumeControl identity="user:elif" name="Elif" />
        <VolumeBadge identity="user:elif" />
      </VolumeProvider>
    </I18nProvider>,
  );
}

describe('per-person volume (for me only)', () => {
  it('keeps to 0-200 % in 5 % steps', () => {
    expect(clampVolume(-20)).toBe(0);
    expect(clampVolume(250)).toBe(200);
    expect(clampVolume(152)).toBe(150);
    expect(clampVolume(Number.NaN)).toBe(100);
    expect(VOLUME).toMatchObject({ min: 0, max: 200, step: 5, normal: 100 });
  });

  it('turns people up through Web Audio, down on the element, both mic and screen audio', () => {
    const p = fakeParticipant('user:can');
    applyVolume(p as never, { level: 150, muted: false });
    expect(p.setVolume).toHaveBeenCalledWith(1.5, Track.Source.Microphone);
    expect(p.setVolume).toHaveBeenCalledWith(1.5, Track.Source.ScreenShareAudio);
    expect(p.tracks[Track.Source.Microphone]!.setAudioContext).toHaveBeenLastCalledWith(
      expect.any(FakeAudioContext),
    );

    applyVolume(p as never, { level: 50, muted: false });
    expect(p.setVolume).toHaveBeenLastCalledWith(0.5, Track.Source.ScreenShareAudio);
    expect(p.tracks[Track.Source.Microphone]!.setAudioContext).toHaveBeenLastCalledWith(undefined);

    applyVolume(p as never, { level: 200, muted: true });
    expect(p.setVolume).toHaveBeenLastCalledWith(0, Track.Source.ScreenShareAudio);
    applyVolume(p as never, { level: 0, muted: false });
    expect(p.setVolume).toHaveBeenLastCalledWith(0, Track.Source.ScreenShareAudio);
    applyVolume(p as never, { level: 200, muted: false });
    expect(p.setVolume).toHaveBeenLastCalledWith(2, Track.Source.ScreenShareAudio);
  });

  it('remembers per meeting and per person; a new meeting starts at 100 %', () => {
    writeVolumes('me', 'meeting-1', {
      'user:elif': { level: 150, muted: false },
      'user:can': { level: 100, muted: false },
    });
    expect(readVolumes('me', 'meeting-1')).toEqual({ 'user:elif': { level: 150, muted: false } });
    expect(readVolumes('me', 'meeting-2')).toEqual({});
    expect(readVolumes('someone-else', 'meeting-1')).toEqual({});
  });

  it('sets the level from the slider, says it for screen readers and applies it again on return', () => {
    const view = renderControl();
    const slider = screen.getByRole('slider', { name: 'Elif ses düzeyi' });
    expect(slider).toHaveAttribute('aria-valuetext', 'Elif · %100');
    expect(slider).toHaveAttribute('step', '5');
    expect(screen.queryByText('%150')).toBeNull();

    act(() => {
      fireEvent.change(slider, { target: { value: '150' } });
    });
    expect(elif.setVolume).toHaveBeenLastCalledWith(1.5, Track.Source.ScreenShareAudio);
    expect(slider).toHaveAttribute('aria-valuetext', 'Elif · %150');
    // The tile badge shows a level that is not 100 %.
    expect(screen.getAllByText('%150').length).toBeGreaterThan(0);
    view.unmount();

    // Back in the same meeting: the setting comes back and is applied to Elif at once.
    elif = fakeParticipant('user:elif');
    room.remoteParticipants = new Map([[elif.identity, elif]]);
    renderControl();
    expect(screen.getByRole('slider', { name: 'Elif ses düzeyi' })).toHaveValue('150');
    expect(elif.setVolume).toHaveBeenCalledWith(1.5, Track.Source.Microphone);
  });

  it('mutes just for me and says so on the tile', () => {
    renderControl();
    act(() => {
      fireEvent.click(screen.getByRole('switch'));
    });
    expect(elif.setVolume).toHaveBeenLastCalledWith(0, Track.Source.ScreenShareAudio);
    expect(screen.getByText('Yalnız sana kapalı')).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Elif ses düzeyi' })).toBeDisabled();
  });
});
