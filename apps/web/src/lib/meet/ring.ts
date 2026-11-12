import { type NotificationPrefs } from '@crewhall/shared';
import { RINGTONE_FILES, type RingtoneName } from '@crewhall/sounds';
import { type QueryClient } from '@tanstack/react-query';
import { chatKeys } from '@/lib/chat/queries';
import { clockIn, inQuietHours, isMessageSoundOn, playSound } from '@/lib/chat/sound';
import { getPresence } from '@/lib/chat/stores';
import { type ChatSettings } from '@/lib/chat/types';

/**
 * Call sounds (H7): a synthesised ring melody for an incoming call and a calmer ringback for
 * the caller, defined once in @crewhall/sounds. The committed WAV files (public/sounds, also
 * used by the mobile app) play first; if a file cannot load or the browser refuses to play it,
 * the same melody is rendered with Web Audio. Both loop without a seam.
 *
 * The message-sound settings (H6) apply: sound off in this browser, do-not-disturb or quiet
 * hours keep the call silent (the call screen still shows).
 */

const noop = () => undefined;

/** Silent by the person's sound settings (H6). */
export function ringSilenced(qc: QueryClient, meId: string, now = new Date()): boolean {
  if (!isMessageSoundOn()) return true;
  if (getPresence(meId)?.state === 'dnd') return true;
  const prefs = qc.getQueryData<NotificationPrefs>(chatKeys.notificationPrefs);
  const settings = qc.getQueryData<ChatSettings>(chatKeys.settings);
  return inQuietHours(prefs?.quietHours ?? null, clockIn(settings?.timezone ?? null, now));
}

/** The melody rendered live, looped or once (when the file cannot play). */
function playSynth(name: RingtoneName, loop = true): () => void {
  const source = playSound(name, { loop });
  if (!source) return noop;
  return () => {
    try {
      source.stop();
    } catch {
      /* already stopped */
    }
    source.disconnect();
  };
}

/**
 * Plays `kind` in a loop until the returned function is called. `silent` (the H6 settings)
 * plays nothing. Message sound off silences the caller's ringback too.
 */
export function playTone(
  kind: 'incoming' | 'ringback',
  { silent = false }: { silent?: boolean } = {},
): () => void {
  if (silent || !isMessageSoundOn() || typeof window === 'undefined') return noop;
  let stopped = false;
  let stopSynth: (() => void) | null = null;
  const fallback = () => {
    if (!stopped && !stopSynth) stopSynth = playSynth(kind);
  };
  let audio: HTMLAudioElement | null = null;
  try {
    audio = new Audio(`${import.meta.env.BASE_URL}sounds/${RINGTONE_FILES[kind]}`);
    audio.loop = true;
    audio.addEventListener('error', fallback, { once: true });
    void audio.play().catch(fallback);
  } catch {
    fallback();
  }
  return () => {
    stopped = true;
    if (audio) {
      audio.removeEventListener('error', fallback);
      audio.pause();
    }
    stopSynth?.();
  };
}

/**
 * The browser keeps this page silent: nobody clicked or typed in it yet (autoplay rules). The
 * AudioContext unlocks on the first gesture (armMessageSound), and a ring that started silent
 * becomes audible then.
 */
export function soundLocked(): boolean {
  if (typeof navigator === 'undefined') return false;
  const activation = (navigator as { userActivation?: { hasBeenActive: boolean } }).userActivation;
  return activation ? !activation.hasBeenActive : false;
}

/**
 * A ringing call is noticed even when its sound cannot play (no click in the tab yet) or the tab
 * is in the background: the tab title blinks and, when the tab is hidden or the page may not play
 * sound yet and notifications are allowed, a system notification shows (with the system's own
 * sound; clicking it brings the tab forward). Returns the stop.
 */
export function announceRing(text: string, opts: { tag: string; body?: string }): () => void {
  if (typeof document === 'undefined') return noop;
  const original = document.title;
  let on = false;
  const blink = window.setInterval(() => {
    on = !on;
    document.title = on ? `📞 ${text}` : original;
  }, 1000);
  let shown: Notification | null = null;
  const notify = () => {
    if (shown || (document.visibilityState === 'visible' && !soundLocked())) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    try {
      shown = new Notification(text, {
        body: opts.body ?? '',
        tag: opts.tag,
        requireInteraction: true,
      });
      shown.onclick = () => {
        window.focus();
        shown?.close();
      };
    } catch {
      shown = null;
    }
  };
  notify();
  document.addEventListener('visibilitychange', notify);
  return () => {
    window.clearInterval(blink);
    document.title = original;
    document.removeEventListener('visibilitychange', notify);
    shown?.close();
  };
}

/** Asks for system notifications once, on a click (browsers only ask after a gesture). */
export function askForCallNotifications() {
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    void Notification.requestPermission().catch(() => undefined);
  }
}

/**
 * A meeting cue played once (someone joined or left). The file first, the synthesised notes when
 * it cannot play. Message sound off keeps it silent too.
 */
export function playCue(kind: 'joined' | 'left'): void {
  if (!isMessageSoundOn() || typeof window === 'undefined') return;
  let done = false;
  const fallback = () => {
    if (done) return;
    done = true;
    playSynth(kind, false);
  };
  try {
    const audio = new Audio(`${import.meta.env.BASE_URL}sounds/${RINGTONE_FILES[kind]}`);
    audio.addEventListener('error', fallback, { once: true });
    void audio.play().then(() => {
      done = true;
    }, fallback);
  } catch {
    fallback();
  }
}
