/**
 * Each organization runs its own server version, and desktop apps update on their own. Two ways
 * they stay compatible without comparing versions in the web app:
 * - the bridge lists what it can do (`crewhallDesktop.features`); the web asks for a feature;
 * - every request to the organization's server says which app sent it (`X-Crewhall-Client`), so
 *   the server can answer 426 to an app that is too old; the app then offers its update.
 */

/** The web page asks for one of its links in a new window (`crewhallDesktop.openWindow`). */
export const OPEN_WINDOW_CHANNEL = 'window:open';

/** What `window.crewhallDesktop` offers. Add a name when the bridge learns something new. */
export const DESKTOP_FEATURES = [
  'openMeeting',
  'meetingClosed',
  'windowKind',
  'remoteControl',
  'titleBar',
  'systemLock',
  'openFile',
  'openWindow',
  'notifySound',
] as const;
export type DesktopFeature = (typeof DESKTOP_FEATURES)[number] | 'webauthn' | 'vaultDevice';

/**
 * The features of this build on this platform. `webauthn`: platform passkeys (Windows Hello;
 * Touch ID only in a signed mac build with a keychain group, see common/webauthn).
 */
export function desktopFeatures(platform: string, macKeychainGroup: string): DesktopFeature[] {
  const out: DesktopFeature[] = [...DESKTOP_FEATURES];
  // Platform passkeys, and with them the vault unlock with Windows Hello / Touch ID.
  if (platform === 'win32' || (platform === 'darwin' && macKeychainGroup))
    out.push('webauthn', 'vaultDevice');
  return out;
}

export const CLIENT_HEADER = 'X-Crewhall-Client';

export function clientHeaderValue(version: string): string {
  return `desktop/${version}`;
}

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/**
 * Request headers with the app's name and version, for the organization's server only: other
 * sites (the identity provider, link previews, the update feed elsewhere) learn nothing.
 */
export function withClientHeader(
  url: string,
  origin: string | null,
  headers: Record<string, string>,
  version: string,
): Record<string, string> {
  if (!origin || !sameOrigin(url, origin)) return headers;
  return { ...headers, [CLIENT_HEADER]: clientHeaderValue(version) };
}

/** The organization's server says this app is too old to work with it. */
export function isOutdatedAnswer(url: string, origin: string | null, status: number): boolean {
  return status === 426 && !!origin && sameOrigin(url, origin);
}
