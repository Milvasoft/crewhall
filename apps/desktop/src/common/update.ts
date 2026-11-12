import { desktopFeedUrl, type DesktopPlatform } from '@crewhall/shared';

/** Release folder of this OS on the server; null where no desktop build exists (Linux). */
export function updatePlatform(nodePlatform: string): DesktopPlatform | null {
  if (nodePlatform === 'win32') return 'win';
  if (nodePlatform === 'darwin') return 'mac';
  return null;
}

/**
 * Where electron-updater looks for releases: always the organization's own server
 * (`/api/v1/desktop/updates/<platform>/`), so the feed follows the server the app is connected
 * to. `override` (settings.updateUrl) exists only for developers.
 */
export function feedUrlFor(
  origin: string | null,
  nodePlatform: string,
  override?: string | null,
): string | null {
  if (override) return override;
  const platform = updatePlatform(nodePlatform);
  if (!origin || !platform) return null;
  return desktopFeedUrl(origin, platform);
}

/** A 404 from the feed means the server hosts no release yet: that is "no update", not an error. */
export function isNoRelease(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const status = (err as { statusCode?: unknown }).statusCode;
  if (status === 404) return true;
  const message = err instanceof Error ? err.message : '';
  return /\b404\b/.test(message);
}
