import { useEffect, useState } from 'react';
import { isSameBuild, readBuildInfo, type BuildInfo } from '@/lib/buildInfo';

/**
 * "Yeni sürüm hazır · Yenile": the server's web app changed while this page stayed open (the
 * desktop app can sit in the tray for days). The built index.html names the main bundle by its
 * content hash and carries the build's number; when the server now serves another bundle or
 * another build than the one running here, there is a new version (a build can leave the bundle
 * as it was, and Hakkında would go on naming the old one). Checked when the page comes back to
 * the front and every 10 minutes.
 *
 * Not compared with the server's commit (getCompat): the api and web images come from separate
 * pipelines that run on their own paths, so the two differ most of the time and a reload would
 * not change that.
 */

export const CHECK_EVERY_MS = 10 * 60_000;
/** Not more often than this, however often focus comes and goes. */
const MIN_GAP_MS = 60_000;

const MAIN_SCRIPT = /<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["']/i;

/** The main module script of an index.html, or null (dev server pages have no hashed bundle). */
export function mainBundle(html: string): string | null {
  const src = MAIN_SCRIPT.exec(html)?.[1] ?? null;
  return src && src.includes('/assets/') ? src : null;
}

/** The bundle this page runs. */
export function runningBundle(doc: Document = document): string | null {
  const el = doc.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]');
  return el?.getAttribute('src') ?? null;
}

/** Whether the server now serves another main bundle than `current`. Network errors: no. */
export async function hasNewVersion(
  current: string | null,
  fetcher: typeof fetch = fetch,
  running: BuildInfo | null = readBuildInfo(),
): Promise<boolean> {
  if (!current) return false;
  try {
    const res = await fetcher(`/?v=${Date.now()}`, {
      cache: 'no-store',
      headers: { accept: 'text/html' },
      credentials: 'same-origin',
    });
    if (!res.ok) return false;
    const html = await res.text();
    const next = mainBundle(html);
    if (next === null) return false;
    if (next !== current) return true;
    const served = readBuildInfo(new DOMParser().parseFromString(html, 'text/html'));
    return running !== null && served !== null && !isSameBuild(running, served);
  } catch {
    return false;
  }
}

/** True once the server has a newer web app than the one running (stays true until reload). */
export function useNewVersion(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (ready) return;
    const current = runningBundle();
    if (!current) return;
    let last = 0;
    let stopped = false;
    const check = () => {
      if (document.visibilityState !== 'visible' || Date.now() - last < MIN_GAP_MS) return;
      last = Date.now();
      void hasNewVersion(current).then((yes) => {
        if (yes && !stopped) setReady(true);
      });
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    const timer = window.setInterval(check, CHECK_EVERY_MS);
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [ready]);
  return ready;
}
