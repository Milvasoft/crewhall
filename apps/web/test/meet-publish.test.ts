import { type LocalParticipant } from 'livekit-client';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFS } from '@/lib/meet/prefs';
import {
  applyShareAudio,
  deviceClass,
  probeCameraH264,
  roomOptionsFor,
  screenShareOptions,
} from '@/lib/meet/publish';

const strong = { weak: false, vp9: true };

describe('what the room sends', () => {
  it('camera in H.264 at 720p with three layers wherever it can be sent', () => {
    const o = roomOptionsFor(DEFAULT_PREFS, { ...strong, cameraH264: true });
    expect(o.publishDefaults?.videoCodec).toBe('h264');
    expect(o.publishDefaults?.videoSimulcastLayers?.map((l) => l.height)).toEqual([180, 360]);
    expect(o.videoCaptureDefaults?.resolution).toMatchObject({ height: 720 });
    // A weak machine with a good encoder need not go down to 540p.
    const weak = roomOptionsFor(DEFAULT_PREFS, { weak: true, vp9: false, cameraH264: true });
    expect(weak.videoCaptureDefaults?.resolution).toMatchObject({ height: 720 });
    // The camera's codec never decides what a screen share uses.
    expect(screenShareOptions('detail', { ...strong, cameraH264: true }).publish.videoCodec).toBe(
      'vp9',
    );
  });

  it('asks the browser about H.264, and takes no answer as VP8', async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'mediaCapabilities');
    const set = (value: unknown) =>
      Object.defineProperty(navigator, 'mediaCapabilities', { configurable: true, value });
    set({ encodingInfo: async () => ({ supported: true, smooth: true, powerEfficient: true }) });
    expect(await probeCameraH264()).toBe(true);
    expect(deviceClass().cameraH264).toBe(true);
    // Chromium's OpenH264 is still cheaper than VP8; another browser needs the hardware.
    const agent = vi.spyOn(navigator, 'userAgent', 'get');
    set({ encodingInfo: async () => ({ supported: true, smooth: true, powerEfficient: false }) });
    agent.mockReturnValue('Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36');
    expect(await probeCameraH264()).toBe(true);
    agent.mockReturnValue('Mozilla/5.0 Gecko/20100101 Firefox/140.0');
    expect(await probeCameraH264()).toBe(false);
    agent.mockRestore();
    set({ encodingInfo: async () => ({ supported: false, smooth: false, powerEfficient: false }) });
    expect(await probeCameraH264()).toBe(false);
    set({
      encodingInfo: async () => {
        throw new Error('not supported');
      },
    });
    expect(await probeCameraH264()).toBe(false);
    set(undefined);
    expect(await probeCameraH264()).toBe(false);
    if (original) Object.defineProperty(navigator, 'mediaCapabilities', original);
    else Reflect.deleteProperty(navigator, 'mediaCapabilities');
  });

  it('camera otherwise VP8 at 720/360/180; 540p on a weak device', () => {
    const o = roomOptionsFor(DEFAULT_PREFS, strong);
    expect(o.publishDefaults?.videoCodec).toBe('vp8');
    expect(o.videoCaptureDefaults?.resolution).toMatchObject({
      width: 1280,
      height: 720,
      frameRate: 24,
    });
    expect(o.publishDefaults).toMatchObject({ simulcast: true, dtx: true, red: true });
    expect(o.publishDefaults?.videoSimulcastLayers?.map((l) => l.height)).toEqual([180, 360]);
    expect(o.dynacast).toBe(true);
    expect(o.adaptiveStream).toEqual({ pixelDensity: 'screen' });
    const weak = roomOptionsFor(DEFAULT_PREFS, { weak: true, vp9: false });
    expect(weak.videoCaptureDefaults?.resolution).toMatchObject({ height: 540, frameRate: 24 });
    // A choice made in the settings wins over the device guess.
    expect(
      roomOptionsFor({ ...DEFAULT_PREFS, quality: '720p' }, { weak: true, vp9: false })
        .videoCaptureDefaults?.resolution,
    ).toMatchObject({ height: 720 });
    expect(roomOptionsFor({ ...DEFAULT_PREFS, dataSaver: true }, strong).adaptiveStream).toEqual({
      pixelDensity: 1,
    });
  });

  it('shares text sharp: 1080p at 15 fps, VP9 L1T3 with a VP8 backup, resolution kept', () => {
    const { capture, publish } = screenShareOptions('detail', strong);
    expect(capture).toMatchObject({
      contentHint: 'detail',
      resolution: { height: 1080, frameRate: 15 },
    });
    expect(publish).toMatchObject({
      videoCodec: 'vp9',
      scalabilityMode: 'L1T3',
      backupCodec: { codec: 'vp8' },
      degradationPreference: 'maintain-resolution',
      screenShareEncoding: { maxBitrate: 5_000_000, maxFramerate: 15 },
    });
    expect(publish.screenShareSimulcastLayers?.map((l) => l.height)).toEqual([360, 720]);
  });

  it('asks for the sound only when the presenter wants it', () => {
    expect(screenShareOptions('detail', strong).capture.audio).toBe(false);
    expect(screenShareOptions('motion', strong, true).capture.audio).toBe(true);
  });

  it('mutes or unmutes the sound of a running share, or says it comes with the next one', async () => {
    const sound = { mute: vi.fn(async () => undefined), unmute: vi.fn(async () => undefined) };
    const p = (sharing: boolean, withSound: boolean) =>
      ({
        isScreenShareEnabled: sharing,
        getTrackPublication: () => (withSound ? { track: sound } : undefined),
      }) as unknown as LocalParticipant;
    expect(await applyShareAudio(p(false, false), true)).toBe('idle');
    expect(await applyShareAudio(p(true, false), true)).toBe('next');
    expect(await applyShareAudio(p(true, false), false)).toBe('idle');
    expect(await applyShareAudio(p(true, true), false)).toBe('live');
    expect(sound.mute).toHaveBeenCalled();
    expect(await applyShareAudio(p(true, true), true)).toBe('live');
    expect(sound.unmute).toHaveBeenCalled();
  });

  it('shares at native size up to 1440p in the desktop app', () => {
    const { capture, publish } = screenShareOptions('detail', { ...strong, desktopApp: true });
    expect(capture.resolution).toMatchObject({ width: 2560, height: 1440, frameRate: 15 });
    expect(publish.screenShareEncoding).toEqual({ maxBitrate: 7_000_000, maxFramerate: 15 });
  });

  it('shares video smooth, and falls back to VP8 simulcast without VP9', () => {
    const motion = screenShareOptions('motion', { weak: false, vp9: false });
    expect(motion.capture).toMatchObject({ contentHint: 'motion', resolution: { frameRate: 30 } });
    expect(motion.publish).toMatchObject({
      videoCodec: 'vp8',
      degradationPreference: 'maintain-framerate',
    });
    expect(motion.publish.scalabilityMode).toBeUndefined();
  });
});
