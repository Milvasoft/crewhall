import type { ScreenAccess } from './ipc';

/**
 * Which web permissions the organization's pages get in the desktop app (main and meeting
 * windows share the default session, so one decision covers both).
 */

/** Camera and microphone (`media`), screen sharing, clipboard and the like. */
const ALLOWED = new Set([
  'media',
  'display-capture',
  'fullscreen',
  'clipboard-read',
  'clipboard-sanitized-write',
  'pointerLock',
  'speaker-selection',
]);

/** The origin of an address, or null. Electron hands origins as URLs with a trailing slash. */
function originOf(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.origin === 'null' ? null : u.origin;
  } catch {
    return null;
  }
}

/**
 * What a plugin's frame inside the server's page may use (eklentiler.md › Tarayıcı yetenekleri):
 * microphone/camera, location and writing to the clipboard. The admin granted them through the
 * plugin manifest, the web page gives the iframe the matching `allow`, and Chromium enforces
 * that delegation before asking here; the app only checks the frame sits in the server's page.
 */
const PLUGIN_FRAME = new Set(['media', 'geolocation', 'clipboard-sanitized-write']);

/** Where a permission is asked from: the window's own page, or a frame inside it. */
export interface FrameContext {
  /** The top page's URL (or the embedding origin for checks). */
  topUrl?: string | null;
  /** False for a subframe (an iframe in the page). */
  isMainFrame?: boolean;
}

/** A plugin frame: a subframe of the server's page asking for one of PLUGIN_FRAME. */
function pluginFrame(permission: string, ctx: FrameContext, serverOrigin: string): boolean {
  return (
    ctx.isMainFrame === false &&
    originOf(ctx.topUrl) === originOf(serverOrigin) &&
    PLUGIN_FRAME.has(permission)
  );
}

/**
 * Permission checks (`setPermissionCheckHandler`): Chromium asks these before it shows device
 * names and ids in `enumerateDevices`, and for `navigator.permissions.query`. Electron passes
 * `requestingOrigin` as `https://host/` (trailing slash), so origins are compared parsed.
 * HTML notifications stay off: the app shows native ones itself (no duplicates).
 */
export function allowPermissionCheck(
  permission: string,
  requestingOrigin: string | undefined,
  serverOrigin: string,
  ctx: FrameContext = {},
): boolean {
  if (permission === 'notifications') return false;
  if (originOf(requestingOrigin) === originOf(serverOrigin) && ALLOWED.has(permission)) return true;
  return pluginFrame(permission, ctx, serverOrigin);
}

/** Permission requests (`setPermissionRequestHandler`), e.g. getUserMedia from the meeting. */
export function allowPermissionRequest(
  permission: string,
  requestingUrl: string | undefined,
  serverOrigin: string,
  ctx: FrameContext = {},
): boolean {
  if (permission === 'notifications') return false;
  if (originOf(requestingUrl) === originOf(serverOrigin) && ALLOWED.has(permission)) return true;
  return pluginFrame(permission, ctx, serverOrigin);
}

/** macOS asks the person once per device type; which ones a media request needs. */
export function macMediaAccess(
  mediaTypes: readonly string[] | undefined,
): Array<'camera' | 'microphone'> {
  const out: Array<'camera' | 'microphone'> = [];
  if (!mediaTypes || mediaTypes.includes('video')) out.push('camera');
  if (!mediaTypes || mediaTypes.includes('audio')) out.push('microphone');
  return out;
}

/**
 * Screen recording: macOS keeps it in System Settings (`getMediaAccessStatus('screen')`), and
 * the app cannot ask for it; Windows and Linux let the picker share directly.
 */
export function screenAccessFor(platform: string, macStatus: string | null): ScreenAccess {
  if (platform !== 'darwin') return { needsSystemGrant: false, granted: true };
  return { needsSystemGrant: true, granted: macStatus === 'granted' };
}

/**
 * Whether the picker shows the macOS steps instead of the list: no grant yet, or an empty list
 * (an old grant from another build of the app does not count for this one).
 */
export function showMacScreenGrant(access: ScreenAccess, sourceCount: number): boolean {
  return access.needsSystemGrant && (!access.granted || sourceCount === 0);
}
