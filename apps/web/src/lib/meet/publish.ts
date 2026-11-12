import {
  AudioPresets,
  ScreenSharePresets,
  Track,
  VideoPresets,
  type LocalParticipant,
  type RoomOptions,
  type ScreenShareCaptureOptions,
  type TrackPublishOptions,
  type VideoCodec,
} from 'livekit-client';
import { type MeetPrefs } from './prefs';
import { desktopBridge } from '@/lib/desktop';

/**
 * What the room sends and receives (design 7.9, 7.5). Kept here, apart from the components, so the
 * choices can be tested and read in one place.
 *
 * - Camera: 720p at 24 fps (360p when asked), simulcast 720/360/180 so others receive what their
 *   tile and link can take; dynacast pauses layers nobody watches.
 * - The camera is the costliest thing a meeting does on the CPU; React, stats and timers stay under
 *   2% of the main thread. Measured in Chrome (two people, 720p): VP8 (libvpx) 7.7-8.1 ms a frame
 *   and 0.49-0.60 cores in all, H.264 4.7 ms and 0.42 cores. So H.264 wherever it is in hardware or
 *   in Chromium's OpenH264 (others who cannot decode it get LiveKit's VP8 backup). Firefox stays on
 *   VP8: its H.264 simulcast is not dependable.
 * - Receiving: adaptive stream at the screen's pixel density (small or hidden tiles get the low
 *   layer or are paused); "Veri tasarrufu" asks for the lowest.
 * - Microphone: speech preset with DTX (silence costs nothing) and RED (survives packet loss).
 * - Screen: see screenShareOptions.
 */

const CAMERA_FPS = 24;

export interface DeviceClass {
  /** Few cores or little memory: the camera sends 540p. */
  weak: boolean;
  /** VP9 encoding available (screen share uses it with SVC). */
  vp9: boolean;
  /** The desktop app (hardware encoders, a picker that gives native size): shares up to 1440p. */
  desktopApp?: boolean;
  /** Send the camera in H.264 (see probeCameraH264). */
  cameraH264?: boolean;
}

export function deviceClass(): DeviceClass {
  if (typeof navigator === 'undefined') return { weak: false, vp9: false };
  const cores = navigator.hardwareConcurrency ?? 8;
  const memory = (navigator as { deviceMemory?: number }).deviceMemory ?? 8;
  return {
    weak: cores <= 4 || memory <= 4,
    vp9: canEncode('video/VP9'),
    desktopApp: desktopBridge() !== null,
    cameraH264,
  };
}

// Constrained baseline. Chrome on Windows says "power efficient" only for the first of these.
const H264_PROFILES = ['42001f', '42e01f'];
let cameraH264 = false;

const isChromium = () =>
  typeof navigator !== 'undefined' && /\b(Chrome|Chromium|Edg)\//.test(navigator.userAgent);

/**
 * Whether the camera goes out in H.264: encoded in hardware, or at least by Chromium's OpenH264.
 * The answer comes asynchronously, so this runs when the module loads, well before anyone clicks
 * "Katıl". No answer means VP8.
 */
export async function probeCameraH264(): Promise<boolean> {
  try {
    const answers = await Promise.all(
      H264_PROFILES.map((profile) =>
        navigator.mediaCapabilities?.encodingInfo?.({
          type: 'webrtc',
          video: {
            contentType: `video/H264;level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=${profile}`,
            width: 1280,
            height: 720,
            bitrate: 1_500_000,
            framerate: CAMERA_FPS,
          },
        }),
      ),
    );
    cameraH264 = answers.some((info) => info?.supported && (info.powerEfficient || isChromium()));
  } catch {
    cameraH264 = false;
  }
  return cameraH264;
}

if (typeof navigator !== 'undefined') void probeCameraH264();

function canEncode(mime: string): boolean {
  try {
    const caps =
      typeof RTCRtpSender !== 'undefined' ? RTCRtpSender.getCapabilities?.('video') : null;
    return Boolean(caps?.codecs.some((c) => c.mimeType.toLowerCase() === mime.toLowerCase()));
  } catch {
    return false;
  }
}

function cameraResolution(prefs: MeetPrefs, device: DeviceClass) {
  if (prefs.quality === '360p') return { ...VideoPresets.h360.resolution, frameRate: CAMERA_FPS };
  if (device.weak && !device.cameraH264 && prefs.quality === 'auto') {
    return { ...VideoPresets.h540.resolution, frameRate: CAMERA_FPS };
  }
  return { ...VideoPresets.h720.resolution, frameRate: CAMERA_FPS };
}

export function roomOptionsFor(prefs: MeetPrefs, device: DeviceClass): RoomOptions {
  const resolution = cameraResolution(prefs, device);
  return {
    adaptiveStream: { pixelDensity: prefs.dataSaver ? 1 : 'screen' },
    dynacast: true,
    publishDefaults: {
      simulcast: prefs.quality === 'auto',
      videoCodec: device.cameraH264 ? 'h264' : 'vp8',
      videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
      videoEncoding: {
        maxBitrate: resolution.height >= 720 ? 1_500_000 : 800_000,
        maxFramerate: CAMERA_FPS,
      },
      audioPreset: AudioPresets.speech,
      dtx: true,
      red: true,
      // Screen defaults; the share itself passes screenShareOptions().publish.
      screenShareEncoding: SCREEN.detail.encoding,
      screenShareSimulcastLayers: SCREEN.detail.layers,
    },
    videoCaptureDefaults: { deviceId: prefs.videoInput ?? undefined, resolution },
    audioCaptureDefaults: {
      deviceId: prefs.audioInput ?? undefined,
      noiseSuppression: prefs.noiseSuppression,
      echoCancellation: prefs.echoCancellation,
      autoGainControl: prefs.echoCancellation,
    },
    audioOutput: prefs.audioOutput ? { deviceId: prefs.audioOutput } : undefined,
  };
}

/**
 * Screen share modes. "detail" (default): documents, code, slides; full resolution, few frames,
 * the encoder drops frames before it blurs text. "motion": video, animations; smoother at 720p.
 */
export type ShareMode = 'detail' | 'motion';

const SCREEN = {
  detail: {
    resolution: { ...ScreenSharePresets.h1080fps15.resolution, frameRate: 15 },
    // Measured (desktop session, 2560×1440 with scrolling text): at 2.5 Mbps the encoder keeps
    // the resolution but quantizes text into a blur; 5 Mbps at 1080p keeps it readable.
    encoding: { maxBitrate: 5_000_000, maxFramerate: 15 },
    layers: [ScreenSharePresets.h360fps3, ScreenSharePresets.h720fps5],
    contentHint: 'detail' as const,
    degradation: 'maintain-resolution' as const,
  },
  motion: {
    resolution: { ...ScreenSharePresets.h720fps30.resolution, frameRate: 30 },
    encoding: { maxBitrate: 3_500_000, maxFramerate: 30 },
    layers: [ScreenSharePresets.h360fps15, ScreenSharePresets.h720fps15],
    contentHint: 'motion' as const,
    degradation: 'maintain-framerate' as const,
  },
};

/**
 * The share's sound switched during a share: a share that has sound is muted or unmuted at once
 * ("live"); one started without it can get sound only from the next share ("next"), because the
 * browser asks for sound when the share starts. Nothing to do without a share ("idle").
 */
export async function applyShareAudio(
  participant: LocalParticipant,
  on: boolean,
): Promise<'live' | 'next' | 'idle'> {
  if (!participant.isScreenShareEnabled) return 'idle';
  const sound = participant.getTrackPublication(Track.Source.ScreenShareAudio)?.track;
  if (!sound) return on ? 'next' : 'idle';
  await (on ? sound.unmute() : sound.mute());
  return 'live';
}

export function screenShareOptions(
  mode: ShareMode,
  device: DeviceClass,
  audio = false,
): { capture: ScreenShareCaptureOptions; publish: TrackPublishOptions } {
  // The desktop app captures a 1440p screen at its own size instead of scaling text down.
  const s =
    mode === 'detail' && device.desktopApp
      ? {
          ...SCREEN.detail,
          resolution: { width: 2560, height: 1440, frameRate: 15 },
          encoding: { maxBitrate: 7_000_000, maxFramerate: 15 },
        }
      : SCREEN[mode];
  // VP9 with one spatial and three temporal layers keeps text sharp and lets slow links drop
  // frames instead of resolution; browsers without it get VP8 simulcast (1080/720/360).
  const codec: VideoCodec = device.vp9 ? 'vp9' : 'vp8';
  return {
    capture: {
      // Without audio the browser's picker offers no sound checkbox at all.
      audio,
      resolution: s.resolution,
      contentHint: s.contentHint,
    },
    publish: {
      videoCodec: codec,
      ...(codec === 'vp9'
        ? { scalabilityMode: 'L1T3' as const, backupCodec: { codec: 'vp8' as const } }
        : {}),
      screenShareEncoding: s.encoding,
      screenShareSimulcastLayers: s.layers,
      degradationPreference: s.degradation,
    },
  };
}
