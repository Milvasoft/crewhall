import { paths } from '@crewhall/shared';
import { useSyncExternalStore } from 'react';

/**
 * Meetings open in their own tab or window, like Teams: chat and the rest keep running in the
 * main tab. Each meeting has its own window name (`crewhall-meet-<slug>`), so opening it again
 * focuses the tab that has it instead of a second copy. In the desktop app (Electron, preload
 * `window.crewhallDesktop`) the app opens its own meeting window instead.
 *
 * The meeting tab is plain (no rail, no incoming-call ring, no message sounds) and closes itself
 * when the meeting ends. Tabs tell each other over a BroadcastChannel that a meeting is open, so
 * the main tab can show "Toplantıdasın · Sekmeye geç".
 */

import { desktopBridge, desktopHas } from '@/lib/desktop';

export const MEET_WINDOW_PREFIX = 'crewhall-meet-';
/** Query flag the meeting tab is opened with (kept in sessionStorage for the tab's life). */
export const MEET_WINDOW_PARAM = 'window';
const SESSION_KEY = 'crewhall.meetWindow';
const CHANNEL = 'crewhall-meet';
/** A meeting tab says it is alive this often; silence for HEARTBEAT_MS * 3 means it is gone. */
const HEARTBEAT_MS = 4000;

export const meetingWindowName = (slug: string) => `${MEET_WINDOW_PREFIX}${slug}`;

/** This tab is a meeting tab (opened for one meeting). */
export function isMeetingWindow(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.name.startsWith(MEET_WINDOW_PREFIX)) return true;
  try {
    if (new URLSearchParams(window.location.search).get(MEET_WINDOW_PARAM) === '1') {
      sessionStorage.setItem(SESSION_KEY, '1');
      return true;
    }
    return sessionStorage.getItem(SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

export type OpenResult = 'desktop' | 'opened' | 'focused' | 'blocked';

/**
 * Opens (or focuses) the meeting tab for `slug` at `path` (with its query). `blocked`: the
 * browser refused a new window; the caller then opens it in this tab and says why.
 */
export function openMeetingWindow(slug: string, path: string): OpenResult {
  const url = new URL(path, window.location.origin);
  url.searchParams.set(MEET_WINDOW_PARAM, '1');
  const desktop = desktopHas('openMeeting') ? desktopBridge()?.openMeeting : undefined;
  if (desktop) {
    void desktop(url.toString());
    return 'desktop';
  }
  // An empty URL returns the existing tab of that name without reloading it.
  const w = window.open('', meetingWindowName(slug));
  if (!w) return 'blocked';
  let fresh: boolean;
  try {
    fresh = w.location.href === 'about:blank';
  } catch {
    fresh = true;
  }
  if (fresh) w.location.href = url.toString();
  w.focus();
  return fresh ? 'opened' : 'focused';
}

/** Leaving the meeting in its own tab closes the tab; false when the browser keeps it open. */
export function closeMeetingWindow(): boolean {
  if (!isMeetingWindow()) return false;
  window.close();
  return window.closed;
}

// ---- which meeting is open in another tab --------------------------------------------------

export interface OpenMeeting {
  slug: string;
  title: string;
}

type Message =
  | { type: 'alive'; meeting: OpenMeeting }
  | { type: 'gone'; slug: string }
  | { type: 'focus'; slug: string };

let channel: BroadcastChannel | null = null;
function bus(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  channel ??= new BroadcastChannel(CHANNEL);
  return channel;
}

/** Meeting tab: announce the meeting until the returned function is called. */
export function announceMeeting(meeting: OpenMeeting): () => void {
  const b = bus();
  if (!b) return () => undefined;
  const alive = () => b.postMessage({ type: 'alive', meeting } satisfies Message);
  alive();
  const timer = window.setInterval(alive, HEARTBEAT_MS);
  const onMessage = (e: MessageEvent<Message>) => {
    if (e.data?.type === 'focus' && e.data.slug === meeting.slug) window.focus();
  };
  b.addEventListener('message', onMessage);
  const gone = () => b.postMessage({ type: 'gone', slug: meeting.slug } satisfies Message);
  window.addEventListener('pagehide', gone);
  return () => {
    window.clearInterval(timer);
    b.removeEventListener('message', onMessage);
    window.removeEventListener('pagehide', gone);
    gone();
  };
}

/** Focuses the tab that has the meeting (asks it over the channel if this tab did not open it). */
export function focusMeetingWindow(slug: string) {
  // The desktop app keeps one window per meeting and brings it up; `window.open('', name)` has no
  // named tabs to find there.
  const desktop = desktopHas('openMeeting') ? desktopBridge()?.openMeeting : undefined;
  if (desktop) {
    const url = new URL(paths.meetingRoom(slug), window.location.origin);
    url.searchParams.set(MEET_WINDOW_PARAM, '1');
    void desktop(url.toString());
    return;
  }
  try {
    const w = window.open('', meetingWindowName(slug));
    if (w && w.location.href !== 'about:blank') {
      w.focus();
      return;
    }
    w?.close();
  } catch {
    /* another origin or blocked */
  }
  bus()?.postMessage({ type: 'focus', slug } satisfies Message);
}

const seen = new Map<string, { meeting: OpenMeeting; at: number }>();
const listeners = new Set<() => void>();
let snapshot: OpenMeeting | null = null;
let watching = false;

function refresh() {
  const now = Date.now();
  for (const [slug, v] of seen) if (now - v.at > HEARTBEAT_MS * 3) seen.delete(slug);
  const first = [...seen.values()][0]?.meeting ?? null;
  if (first?.slug !== snapshot?.slug || first?.title !== snapshot?.title) {
    snapshot = first;
    listeners.forEach((l) => l());
  }
}

function watch() {
  const b = bus();
  if (watching || !b) return;
  watching = true;
  b.addEventListener('message', (e: MessageEvent<Message>) => {
    if (e.data?.type === 'alive') {
      seen.set(e.data.meeting.slug, { meeting: e.data.meeting, at: Date.now() });
    }
    if (e.data?.type === 'gone') seen.delete(e.data.slug);
    refresh();
  });
  window.setInterval(refresh, HEARTBEAT_MS);
}

/** Main tab: the meeting open in another tab, or null. */
export function useMeetingElsewhere(): OpenMeeting | null {
  return useSyncExternalStore(
    (l) => {
      watch();
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
    () => null,
  );
}

/** Tests: forget what was heard. */
export function resetMeetingWindowsForTests() {
  seen.clear();
  snapshot = null;
}

/** Phones and touch screens keep the meeting in this tab, inside the app (back returns). */
export function prefersSameTab(): boolean {
  if (typeof window === 'undefined') return false;
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  return coarse || window.innerWidth < 768;
}

/**
 * "Ana sayfa" from a meeting tab: back to the tab that opened it (this one closes), or, when there
 * is none (a reload, a pasted link), this tab becomes a normal app tab again. Returns true when
 * the caller should navigate home itself.
 */
export function leaveMeetingWindow(): boolean {
  try {
    if (window.opener && !window.opener.closed) {
      (window.opener as Window).focus();
      window.close();
      if (window.closed) return false;
    }
  } catch {
    /* another origin */
  }
  window.name = '';
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage off */
  }
  return true;
}
