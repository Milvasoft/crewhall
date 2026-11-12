import { isMeetingPath } from './paths';

/**
 * When the desktop app may put a window in front of the person. Rule: a new window only on an
 * explicit action (joining a meeting, answering a call, opening something); background events
 * (messages, notifications, Drive changes, a ringing call) never open one: at most a native
 * notification, the badge or a flashing taskbar button.
 */

/** What a realtime event does in the app. There is deliberately no "window" effect. */
export type RealtimeEffect = 'badge' | 'notify' | 'sync' | 'ring' | 'ring-over' | 'catch-up';

export function realtimeEffects(type: string): RealtimeEffect[] {
  switch (type) {
    case 'ready':
      return ['badge', 'sync', 'catch-up'];
    case 'notification':
      return ['notify', 'badge'];
    case 'notifications.changed':
    case 'read':
    case 'message.created':
    case 'conversation.updated':
    case 'conversation.removed':
    case 'resync':
      return ['badge'];
    case 'node.updated':
      return ['sync'];
    case 'call.ringing':
      return ['ring'];
    case 'call.updated':
      return ['ring-over'];
    default:
      return [];
  }
}

/**
 * A ringing call raises the main window only when the person is already looking at it (visible,
 * not minimised, no meeting window open). From the tray or during a meeting: a notification and
 * a flashing taskbar button; answering opens the call.
 */
export function ringAction(s: {
  mainVisible: boolean;
  mainMinimized: boolean;
  meetingOpen: boolean;
}): 'raise' | 'notify' {
  return s.mainVisible && !s.mainMinimized && !s.meetingOpen ? 'raise' : 'notify';
}

/**
 * Whether a page's request for a new tab came from the person asking for one: Chromium says
 * `background-tab` for a middle or Ctrl click on a link. `window.open` and `target=_blank` say
 * `foreground-tab` or `new-window` and keep going where they went.
 */
export function asksForNewWindow(disposition: string): boolean {
  return disposition === 'background-tab';
}

/** Whether a window showing `currentUrl` already shows this path of the server. */
export function sameAppPage(currentUrl: string, path: string, origin: string): boolean {
  try {
    const current = new URL(currentUrl);
    const wanted = new URL(path, origin);
    return (
      current.origin === wanted.origin &&
      current.pathname === wanted.pathname &&
      current.search === wanted.search
    );
  } catch {
    return false;
  }
}

export type OpenDecision =
  /** A meeting of the server: its meeting window (focused when already open). */
  | { kind: 'meeting'; url: string }
  /** Another page of the server: shown in the main window, never a copy of the app. */
  | { kind: 'navigate'; path: string }
  /** A file from the server's API: downloaded. */
  | { kind: 'download'; url: string }
  /**
   * One of our files to look at (an image, PDF or video the page opens inline): the app's own
   * viewer window, not the browser.
   */
  | { kind: 'viewer'; url: string }
  /** Another site, mail or phone: the system browser or app. */
  | { kind: 'external'; url: string }
  | { kind: 'deny' };

/** A presigned storage link (S3 signature v4 query), as the server gives out for files. */
function isPresignedFile(u: URL): boolean {
  const keys = new Set([...u.searchParams.keys()].map((k) => k.toLowerCase()));
  return keys.has('x-amz-signature') && keys.has('x-amz-credential');
}

/** An API file link the page asked to show, not to save (`disposition=inline`). */
function opensInline(u: URL): boolean {
  const d = u.searchParams.get('disposition') ?? u.searchParams.get('response-content-disposition');
  return d !== null && d.toLowerCase().startsWith('inline');
}

/**
 * `window.open`, `target=_blank` and the like in the app's pages. Browsers block pop-ups without a
 * click; Electron does not, so nothing here creates a window: every case goes somewhere that
 * exists (or is the meeting window, which is one per meeting). Empty and about:blank pop-ups (the
 * web's "find my meeting tab" trick) are refused.
 */
export function windowOpenDecision(url: string, origin: string): OpenDecision {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { kind: 'deny' };
  }
  if (u.protocol === 'mailto:' || u.protocol === 'tel:') return { kind: 'external', url: u.href };
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { kind: 'deny' };
  // The org's storage hands files out as presigned links on its own host (S3_PUBLIC_ENDPOINT):
  // ours, so they open in the app. Anything else on another host is a real outside site.
  if (u.origin !== origin) {
    return isPresignedFile(u) ? { kind: 'viewer', url: u.href } : { kind: 'external', url: u.href };
  }
  if (u.pathname.startsWith('/api/')) {
    return opensInline(u) ? { kind: 'viewer', url: u.href } : { kind: 'download', url: u.href };
  }
  if (isMeetingPath(u.pathname)) return { kind: 'meeting', url: u.href };
  return { kind: 'navigate', path: `${u.pathname}${u.search}${u.hash}` };
}

/** A file name for the viewer: the download name the link asks for, else the last path part. */
export function fileNameOf(url: string): string {
  try {
    const u = new URL(url);
    const d = u.searchParams.get('response-content-disposition') ?? '';
    const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(d);
    if (m?.[1]) return decodeURIComponent(m[1]);
    return decodeURIComponent(u.pathname.split('/').filter(Boolean).at(-1) ?? '');
  } catch {
    return '';
  }
}
