import { paths } from '@crewhall/shared';
import { desktopBridge } from '@/lib/desktop';
import { openExternal } from '@/lib/external';

/**
 * "Uygulamada aç": a phone browser hands the page to the Crewhall mobile app through its custom
 * scheme, since a self-hosted server cannot always set up universal links / app links.
 * The app reads `crewhall://open?url=<full web address, encoded>` (crewhall-mobile
 * `+native-intent.tsx`): it picks the server from the address and opens the matching screen
 * (invitations included), or home for a page it does not have.
 */

export type MobilePlatform = 'ios' | 'android';

/** The phone or tablet OS of this browser; null on desktop and inside the desktop app. */
export function mobilePlatform(
  ua: string = navigator.userAgent,
  touchPoints: number = navigator.maxTouchPoints,
): MobilePlatform | null {
  if (desktopBridge()) return null;
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  // iPadOS Safari asks for the desktop site and says "Macintosh"; only the touch screen tells.
  if (/Macintosh/i.test(ua) && touchPoints > 1) return 'ios';
  return null;
}

/** The app link of a web address of this server. */
export function appOpenUrl(href: string): string {
  return `crewhall://open?url=${encodeURIComponent(href)}`;
}

/**
 * Pages the app itself opens in the system browser (sign-in handoff, password reset, 2FA setup,
 * account security, vault setup), set-up and sign-in steps of other products, and public pages
 * meant for people without an account: no banner there. An invitation keeps it: the app accepts
 * it too.
 */
const NO_BANNER: readonly RegExp[] = [
  paths.mobileLogin(),
  paths.forgotPassword(),
  paths.resetPassword(),
  paths.twoFactorSetup(),
  paths.account('security'),
  paths.vault(),
  paths.setup(),
  '/oauth',
  '/sso',
  '/office',
  '/teams',
  '/vault-share',
  '/f',
  '/s',
  '/u',
].map((p) => new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:/|$)`));

export function bannerAllowedOn(pathname: string): boolean {
  return !NO_BANNER.some((re) => re.test(pathname));
}

/** How long the page waits for the app to take over before it opens the store instead. */
export const APP_LAUNCH_WAIT_MS = 1500;

/**
 * Opens `url` in the app; when the page is still in front after a moment (no app answered the
 * scheme), goes to `fallback` (the store or download page) if there is one.
 */
export function launchApp(url: string, fallback: string | null): void {
  let left = false;
  const leave = () => {
    left = true;
  };
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') left = true;
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', leave);
  window.addEventListener('blur', leave);
  openExternal(url);
  window.setTimeout(() => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', leave);
    window.removeEventListener('blur', leave);
    if (!left && fallback) openExternal(fallback);
  }, APP_LAUNCH_WAIT_MS);
}
