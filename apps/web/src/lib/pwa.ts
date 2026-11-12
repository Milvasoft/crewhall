import { config } from '@/config';
import { desktopBridge } from '@/lib/desktop';

/** Running as an installed app (home screen, app window), not in a browser tab. */
export function isStandalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches ?? false;
}

/**
 * Installable web app: public/sw.js keeps the build files and the HTML shell, nothing else. Off in
 * development and the mock (its own worker owns the same scope) and inside the desktop app.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || config.mock || desktopBridge()) return;
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      /* a browser that refuses it (private mode, policy) just keeps working online */
    });
  });
}
