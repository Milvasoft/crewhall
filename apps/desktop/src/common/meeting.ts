import { currentPathname, isAuthPath, isMeetingPath } from './paths';
import type { Rect } from './remote-control';

/**
 * Meeting windows keep full speed in the background: the sharer is usually in another app while
 * presenting, and Chromium throttles hidden pages' timers hard after a few minutes (the media
 * client's bitrate and connection checks run on them). Page visibility then also stays
 * "visible", so the room does not treat itself as backgrounded.
 */
export const MEETING_WEB_PREFERENCES = { backgroundThrottling: false } as const;

/**
 * Whether a page of the main window or a further window may be throttled in the background. A
 * meeting can run there too (an in-app link to the room, `/m/<slug>`): it then keeps full speed
 * like a meeting window. Measured with Electron 45 on Windows 11: a default window's timers drop
 * to one per second when it is minimised, hidden or merely covered by another window (native
 * occlusion), while a window with backgroundThrottling off stays at full speed and "visible" in
 * all three.
 */
export function mayThrottle(url: string, origin: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return true;
  }
  return !(u.origin === origin && isMeetingPath(u.pathname));
}

/** Longest `[media]` line kept in the log file. */
const MEDIA_LINE_MAX = 4000;

/**
 * A `[media]` line of the meeting page (web lib/meet/mediaWatch: network path, audio delay,
 * throttled timers) without its prefix, for the log file; null for any other console message.
 */
export function mediaLogLine(message: string): string | null {
  const prefix = '[media] ';
  if (!message.startsWith(prefix)) return null;
  return message.slice(prefix.length, prefix.length + MEDIA_LINE_MAX);
}

/** The note the meeting page leaves when it closes its own window (main/meeting-windows). */
export function closedItself(message: string): boolean {
  return message.startsWith('[meeting] page called window.close');
}

/**
 * Meetings open in their own window (like Teams). One window per meeting: the key is the
 * meeting's path on the server (query and hash do not matter), so opening the same meeting again
 * focuses the window that is already there.
 */
export function meetingKey(url: string, origin: string): string | null {
  let u: URL;
  try {
    u = new URL(url, origin);
  } catch {
    return null;
  }
  if (u.origin !== origin) return null;
  // The current form: the old Turkish address of a meeting is the same meeting.
  const path = currentPathname(u.pathname).replace(/\/+$/, '');
  return path || null;
}

/**
 * The meeting window's page left the meeting: it moved to another page of the server (the
 * meetings list, home…). Sign-in pages, the identity provider's site (SSO) and other meeting
 * pages do not count; the window then closes and tells the main window.
 */
export function leftMeeting(currentUrl: string, key: string, origin: string): boolean {
  let u: URL;
  try {
    u = new URL(currentUrl);
  } catch {
    return false;
  }
  if (u.origin !== origin) return false;
  const path = currentPathname(u.pathname).replace(/\/+$/, '') || '/';
  if (path === key || path.startsWith(`${key}/`)) return false;
  // Meeting pages (room, lobby, link join) and sign-in steps keep the window, in either form.
  return !isMeetingPath(path) && !isAuthPath(path);
}

/**
 * Saved bounds when they are still on a screen (monitors come and go), else centred on the
 * primary work area at the default size.
 */
export function fitBounds(
  saved: Rect | null,
  workAreas: readonly Rect[],
  size = { width: 1200, height: 760 },
): Rect {
  const primary = workAreas[0] ?? { x: 0, y: 0, width: size.width, height: size.height };
  if (saved) {
    // At least a 100 × 50 corner of the title bar must be on some screen to grab it.
    const visible = workAreas.some(
      (a) =>
        saved.x + saved.width - 100 >= a.x &&
        saved.x + 100 <= a.x + a.width &&
        saved.y >= a.y &&
        saved.y + 50 <= a.y + a.height,
    );
    if (visible) return saved;
  }
  const width = Math.min(size.width, primary.width);
  const height = Math.min(size.height, primary.height);
  return {
    x: Math.round(primary.x + (primary.width - width) / 2),
    y: Math.round(primary.y + (primary.height - height) / 2),
    width,
    height,
  };
}
