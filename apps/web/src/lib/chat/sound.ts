import { type QueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { desktopBridge } from '@/lib/desktop';
import { isMeetingWindow } from '@/lib/meet/window';
import { readStorage, StorageKey, writeStorage } from '@/lib/storage';
import { findConversation } from './cache';
import { chatKeys, conversationQuery } from './queries';
import { getPresence, getVisibleConversation, isLooking } from './stores';
import { type ChatSettings, type Message } from './types';
import { messageSeverity, type NotificationPrefs } from '@crewhall/shared';
import { renderRingtone, RINGTONES, type RingtoneName } from '@crewhall/sounds';

/**
 * Message sound (H6). A short chime when a message lands somewhere you are not looking: the
 * tab is in the background or another chat is open. Mentions and direct messages get a
 * brighter three-note tone. Never for my own messages, a muted chat, do-not-disturb or quiet
 * hours. The tones come from @crewhall/sounds (the wooden voice the calls use), rendered here
 * into a Web Audio buffer: nothing to download, nothing to license.
 *
 * Browsers only let a page make sound after the person interacted with it, so the
 * AudioContext is created on the first pointer or key press (`armMessageSound`), or at the first
 * chime once the page has had an interaction. The desktop app may always play (Electron's
 * autoplay policy): it starts at once, so a window opened in the tray chimes without a click.
 */

export type Tone = 'message' | 'mention';

// ---- setting (per browser; the chat settings contract has no field for it yet) ----

const listeners = new Set<() => void>();

export function isMessageSoundOn(): boolean {
  return readStorage(StorageKey.messageSound) !== 'off';
}

export function setMessageSoundOn(on: boolean): void {
  writeStorage(StorageKey.messageSound, on ? null : 'off');
  listeners.forEach((l) => l());
}

export function useMessageSoundOn(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    isMessageSoundOn,
    () => true,
  );
}

// ---- rules ----

/** "HH:MM" now in `timeZone` (browser zone when null or unknown). */
export function clockIn(timeZone: string | null, now: Date): string {
  const fmt = (tz?: string) =>
    new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: tz,
    }).format(now);
  try {
    return fmt(timeZone ?? undefined);
  } catch {
    return fmt();
  }
}

/** Inside [from, to); a window like 22:00–08:00 wraps midnight. */
export function inQuietHours(q: { from: string; to: string } | null, clock: string): boolean {
  if (!q || q.from === q.to) return false;
  return q.from < q.to ? clock >= q.from && clock < q.to : clock >= q.from || clock < q.to;
}

function mentionsMe(m: Message, meId: string): boolean {
  return m.mentions.some((x) => x.kind !== 'user' || x.userId === meId);
}

/** Which tone this new message deserves, or null when it should stay silent. */
export function toneFor(
  qc: QueryClient,
  m: Message,
  meId: string,
  now: Date = new Date(),
): Tone | null {
  if (!isMessageSoundOn()) return null;
  if (m.author?.id === meId || m.kind === 'system' || m.deletedAt) return null;
  // The open chat in a focused window: you are already looking at it.
  if (getVisibleConversation() === m.conversationId && isLooking()) return null;
  if (getPresence(meId)?.state === 'dnd') return null;
  const conv = findConversation(qc, m.conversationId);
  if (!conv) return null;
  const mention = mentionsMe(m, meId);
  const muted = conv.my.mutedUntil !== null && Date.parse(conv.my.mutedUntil) > now.getTime();
  if (muted || conv.my.notify === 'none') return null;
  if (conv.my.notify === 'mentions' && !mention) return null;
  // A webhook's plain text is read for its severity, as the server does (guessAlertSeverity).
  if (conv.my.notify === 'critical' && messageSeverity(m) !== 'critical' && !mention) return null;
  const prefs = qc.getQueryData<NotificationPrefs>(chatKeys.notificationPrefs);
  const settings = qc.getQueryData<ChatSettings>(chatKeys.settings);
  if (inQuietHours(prefs?.quietHours ?? null, clockIn(settings?.timezone ?? null, now))) {
    return null;
  }
  return mention || conv.type === 'direct' ? 'mention' : 'message';
}

// ---- audio ----

type AudioFactory = () => AudioContext;

let makeContext: AudioFactory | null =
  typeof window !== 'undefined' && 'AudioContext' in window ? () => new AudioContext() : null;
let ctx: AudioContext | null = null;
let lastAt = 0;
/** A burst of messages chimes once. */
const GAP_MS = 1500;

const buffers = new Map<string, AudioBuffer>();

/**
 * `name` (@crewhall/sounds) rendered once per AudioContext rate and kept: the same samples as
 * the committed WAV files, made here so a chime needs no download.
 */
function soundBuffer(audio: AudioContext, name: RingtoneName): AudioBuffer {
  const key = `${name}:${audio.sampleRate}`;
  let buffer = buffers.get(key);
  if (!buffer) {
    const channels = renderRingtone(RINGTONES[name], audio.sampleRate);
    buffer = audio.createBuffer(channels.length, channels[0].length, audio.sampleRate);
    channels.forEach((ch, i) => buffer!.getChannelData(i).set(ch));
    buffers.set(key, buffer);
  }
  return buffer;
}

function unlock() {
  if (!makeContext) return;
  try {
    if (!ctx || ctx.state === 'closed') ctx = makeContext();
    // resume() is refused without a gesture in a browser; the next interaction tries again.
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
  } catch {
    ctx = null;
  }
}

/**
 * Whether a context may start without a fresh gesture: always in the desktop app, in a browser
 * once the page was interacted with (sticky user activation).
 */
function mayStartAudio(): boolean {
  if (desktopBridge()) return true;
  const activation = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } })
    .userActivation;
  return activation?.hasBeenActive === true;
}

/** The shared AudioContext (created on demand; it plays once the page was interacted with). */
export function soundContext(): AudioContext | null {
  unlock();
  return ctx;
}

/**
 * Waits for the first interaction, then keeps the AudioContext ready. Returns the cleanup.
 */
export function armMessageSound(): () => void {
  if (desktopBridge()) unlock();
  // A touch only counts as a gesture on touchend/click (not pointerdown) in mobile browsers.
  const events = ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'] as const;
  events.forEach((e) => window.addEventListener(e, unlock, { passive: true }));
  return () => events.forEach((e) => window.removeEventListener(e, unlock));
}

/**
 * Plays `name` on the shared AudioContext, once or looped. Null when the page has no audio; the
 * caller stops a looped one with `stop()`.
 */
export function playSound(
  name: RingtoneName,
  { loop = false }: { loop?: boolean } = {},
): AudioBufferSourceNode | null {
  const audio = soundContext();
  if (!audio) return null;
  const source = audio.createBufferSource();
  source.buffer = soundBuffer(audio, name);
  source.loop = loop;
  if (!loop) source.onended = () => source.disconnect();
  source.connect(audio.destination);
  source.start();
  return source;
}

/** Plays a tone if audio was unlocked; `force` skips the burst gap (the settings preview). */
export function playTone(tone: Tone, { force = false }: { force?: boolean } = {}): boolean {
  if ((!ctx || ctx.state === 'closed') && mayStartAudio()) unlock();
  if (!ctx || ctx.state === 'closed') return false;
  const now = Date.now();
  if (!force && now - lastAt < GAP_MS) return false;
  lastAt = now;
  if (ctx.state === 'running') return playSound(tone) !== null;
  // Suspended (no gesture yet, or the OS took the audio device): a chime queued on it would
  // sound later, out of place; play only if it resumes right away.
  const audio = ctx;
  const asked = Date.now();
  void audio
    .resume()
    .then(() => {
      if (audio.state === 'running' && Date.now() - asked < RESUME_WAIT_MS) playSound(tone);
    })
    .catch(() => undefined);
  return true;
}

/** How late a chime may still play after its context woke up. */
const RESUME_WAIT_MS = 1000;

/** Runtime hook: a new message reached the cache. */
export function soundForMessage(qc: QueryClient, m: Message, meId: string): void {
  // The main tab chimes; a meeting's own tab stays quiet (lib/meet/window).
  if (isMeetingWindow()) return;
  if (!findConversation(qc, m.conversationId) && m.author?.id !== meId && m.kind !== 'system') {
    // The first message of a chat new to me (a direct or group chat exists for others from its
    // first message): load the chat, then decide. Without it the chime never came.
    void qc
      .fetchQuery(conversationQuery(m.conversationId))
      .then(() => {
        const tone = toneFor(qc, m, meId);
        if (tone) playTone(tone);
      })
      .catch(() => undefined);
    return;
  }
  const tone = toneFor(qc, m, meId);
  if (tone) playTone(tone);
}

/**
 * The desktop app showed a native notification and left its toast silent (bridge
 * `onNotificationSound`): the chime comes from here, the same wooden tone as in the page. A burst
 * with the message's own chime sounds once (GAP_MS); sound off, a muted chat, do not disturb and a
 * meeting window stay quiet. The server already left out my own messages, quiet hours and the
 * chat open in front of me.
 */
export function soundForNotification(
  qc: QueryClient,
  sound: { tone: Tone; conversationId: string | null },
  meId: string,
  now: Date = new Date(),
): boolean {
  if (isMeetingWindow() || !isMessageSoundOn()) return false;
  if (getPresence(meId)?.state === 'dnd') return false;
  const conv = sound.conversationId ? findConversation(qc, sound.conversationId) : undefined;
  if (conv) {
    const muted = conv.my.mutedUntil !== null && Date.parse(conv.my.mutedUntil) > now.getTime();
    if (muted || conv.my.notify === 'none') return false;
  }
  return playTone(sound.tone);
}

/** In the desktop app: chime for its native notifications. Returns the cleanup. */
export function armNotificationSound(qc: QueryClient, meId: string): () => void {
  const off = desktopBridge()?.onNotificationSound?.((s) => {
    soundForNotification(qc, s, meId);
  });
  return off ?? (() => undefined);
}

export function setAudioFactoryForTests(f: AudioFactory | null): void {
  makeContext = f;
  ctx = null;
  lastAt = 0;
  buffers.clear();
}
