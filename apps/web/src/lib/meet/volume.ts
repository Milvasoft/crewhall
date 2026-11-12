import {
  Track,
  type RemoteAudioTrack,
  type RemoteParticipant,
  type RemoteTrackPublication,
} from 'livekit-client';
import { readPrefs } from './prefs';

/**
 * How loud each person sounds, for me only (Teams/Zoom "volume"): 0-200 %, 5 % steps, plus
 * "Sesi kapat (yalnız benim için)". Nobody's microphone changes. Kept per meeting and per
 * signed-in person in this browser, so coming back to the same room brings it back; a new meeting
 * starts everyone at 100 %.
 */

export const VOLUME = { min: 0, max: 200, step: 5, normal: 100 } as const;

export interface VolumeSetting {
  /** Percent, 0-200. */
  level: number;
  /** "Yalnız benim için" muted; the level is kept for when it is turned back on. */
  muted: boolean;
}

export const NORMAL_VOLUME: VolumeSetting = { level: VOLUME.normal, muted: false };

export type VolumeMap = Record<string, VolumeSetting>;

/** Snaps to the 5 % grid inside 0-200. */
export function clampVolume(level: number): number {
  if (!Number.isFinite(level)) return VOLUME.normal;
  const snapped = Math.round(level / VOLUME.step) * VOLUME.step;
  return Math.min(VOLUME.max, Math.max(VOLUME.min, snapped));
}

export const isNormal = (v: VolumeSetting) => !v.muted && v.level === VOLUME.normal;

/** LiveKit gain: 1 is as sent. */
export const gainOf = (v: VolumeSetting) => (v.muted ? 0 : v.level / 100);

// ---- storage ----

const STORAGE_KEY = 'crewhall.meet.volumes';
/** The most recent meetings kept; older ones fall off. */
const KEEP_MEETINGS = 20;

interface Stored {
  [meetingKey: string]: { at: number; people: VolumeMap };
}

const meetingKey = (userId: string, meetingId: string) => `${userId}:${meetingId}`;

function readAll(): Stored {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Stored) : {};
  } catch {
    return {};
  }
}

function sane(v: unknown): VolumeSetting | null {
  if (!v || typeof v !== 'object') return null;
  const { level, muted } = v as Partial<VolumeSetting>;
  if (typeof level !== 'number') return null;
  return { level: clampVolume(level), muted: muted === true };
}

/** The settings I made in this meeting earlier (by participant identity). */
export function readVolumes(userId: string, meetingId: string): VolumeMap {
  const entry = readAll()[meetingKey(userId, meetingId)];
  const out: VolumeMap = {};
  for (const [identity, v] of Object.entries(entry?.people ?? {})) {
    const s = sane(v);
    if (s && !isNormal(s)) out[identity] = s;
  }
  return out;
}

export function writeVolumes(userId: string, meetingId: string, people: VolumeMap) {
  const all = readAll();
  const key = meetingKey(userId, meetingId);
  const kept = Object.fromEntries(Object.entries(people).filter(([, v]) => !isNormal(v)));
  if (Object.keys(kept).length) all[key] = { at: Date.now(), people: kept };
  else delete all[key];
  const recent = Object.entries(all)
    .sort(([, a], [, b]) => (b.at ?? 0) - (a.at ?? 0))
    .slice(0, KEEP_MEETINGS);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(recent)));
  } catch {
    /* private mode or full: the setting lasts for this visit only */
  }
}

// ---- applying ----

const AUDIO_SOURCES = [Track.Source.Microphone, Track.Source.ScreenShareAudio] as const;

let boostContext: AudioContext | null = null;

/**
 * Above 100 % an <audio> element cannot go (volume is 0-1), so that person's audio plays through
 * Web Audio with a gain instead, on the chosen speaker when the browser can pick one. At or below
 * 100 % it stays on the element, the path the browser's echo cancellation knows best.
 */
function boost(): AudioContext | null {
  if (typeof AudioContext === 'undefined') return null;
  if (!boostContext || boostContext.state === 'closed') {
    boostContext = new AudioContext();
    const sink = readPrefs().audioOutput;
    const ctx = boostContext as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    if (sink && ctx.setSinkId) void ctx.setSinkId(sink).catch(() => undefined);
  }
  if (boostContext.state === 'suspended') void boostContext.resume().catch(() => undefined);
  return boostContext;
}

/** Applies one person's setting to their microphone and screen-share audio. */
export function applyVolume(p: RemoteParticipant, v: VolumeSetting) {
  const gain = gainOf(v);
  for (const source of AUDIO_SOURCES) {
    const pub = p.getTrackPublication(source) as RemoteTrackPublication | undefined;
    const track = pub?.track as RemoteAudioTrack | undefined;
    if (track) track.setAudioContext(gain > 1 ? (boost() ?? undefined) : undefined);
    // Also remembered by LiveKit for tracks subscribed later.
    p.setVolume(gain, source);
  }
}
