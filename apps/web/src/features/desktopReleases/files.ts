import {
  DESKTOP_UPLOAD_MAX_BYTES,
  DesktopFileName,
  type DesktopFileKind,
  type DesktopPlatform,
} from '@crewhall/shared';

/**
 * What a dropped file is, from its name: Windows takes the installer (.exe) and its .blockmap,
 * macOS the update .zip (and its .blockmap) and the .dmg people download. Anything else, or a
 * name the server would refuse, is turned away before it is uploaded.
 */
export function fileKind(name: string, platform: DesktopPlatform): DesktopFileKind | null {
  if (!DesktopFileName.safeParse(name).success) return null;
  const n = name.toLowerCase();
  if (n.endsWith('.blockmap')) {
    const base = n.slice(0, -'.blockmap'.length);
    return (platform === 'win' && base.endsWith('.exe')) ||
      (platform === 'mac' && base.endsWith('.zip'))
      ? 'blockmap'
      : null;
  }
  if (platform === 'win') return n.endsWith('.exe') ? 'installer' : null;
  if (n.endsWith('.zip')) return 'update_zip';
  if (n.endsWith('.dmg')) return 'dmg';
  return null;
}

export const tooLarge = (size: number) => size > DESKTOP_UPLOAD_MAX_BYTES;

/** Cloudflare's request limit on its Free and Pro plans. */
const PROXY_LIMIT_BYTES = 100 * 1000 * 1000;

/**
 * A failed PUT that a proxy's request size limit explains: a 413, or a "network error" for a
 * request over 100 MB (the 413 page lacks CORS headers, so the browser hides its status).
 */
export function refusedForSize(e: unknown, bytes: number): boolean {
  return (
    e instanceof UploadHttpError &&
    (e.status === 413 || (e.status === 0 && bytes > PROXY_LIMIT_BYTES))
  );
}

/** File picker filter per platform. */
export const ACCEPT: Record<DesktopPlatform, string> = {
  win: '.exe,.blockmap',
  mac: '.zip,.dmg,.blockmap',
};

/**
 * "Crewhall-Setup-0.2.5.exe" → "0.2.5", "Crewhall-1.0.0-beta.2-mac.zip" → "1.0.0-beta.2": the
 * version is what is left at the end once the extension and an architecture suffix are gone.
 */
export function versionOf(name: string): string | null {
  const stem = name
    .replace(/\.blockmap$/i, '')
    .replace(/\.(exe|zip|dmg)$/i, '')
    .replace(/-(mac|x64|arm64|universal)$/i, '');
  return /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/.exec(stem)?.[1] ?? null;
}

export const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

/** What a release is published by: Windows the installer, macOS the update zip. */
export const MAIN_KIND: Record<DesktopPlatform, DesktopFileKind> = {
  win: 'installer',
  mac: 'update_zip',
};

/**
 * The store (or a proxy in front of it) answered a PUT with an error status; 0 when the browser
 * hides it (a proxy's error page has no CORS headers, so it reads as a network error).
 */
export class UploadHttpError extends Error {
  constructor(readonly status: number) {
    super(`upload failed (${status})`);
  }
}
