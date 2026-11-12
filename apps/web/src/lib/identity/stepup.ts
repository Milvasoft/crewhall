import {
  startAuthentication,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { config } from '@/config';
import { api, isApiError } from '@/lib/api';
import { desktopBridge } from '@/lib/desktop';

/**
 * Step-up with a passkey (web and the desktop app, which has WebAuthn too): the server's
 * options go to the authenticator and the assertion back to the server, which opens the
 * same 10-minute verification window as the password. No new session is started.
 */
export type PasskeyStepUp =
  { ok: true; verifiedUntil: string } | { ok: false; kind: 'cancelled' | 'failed'; code?: string };

type ReauthOptions = Awaited<ReturnType<typeof fetchOptions>>;

const fetchOptions = () => api.call('reauthPasskeyOptions');
/** The server's challenge lives 2 minutes; one fetched in advance is used within 90 s. */
const PREFETCH_FRESH_MS = 90_000;
let prefetched: { at: number; options: Promise<ReauthOptions> } | null = null;

/**
 * Asks the server for the passkey options as soon as the dialog opens, so the system prompt
 * opens at once on click instead of after a round trip (sonraki-isler: Hello "çok yavaş").
 */
export function prefetchPasskeyOptions(): void {
  if (prefetched && Date.now() - prefetched.at < PREFETCH_FRESH_MS) return;
  const options = fetchOptions();
  options.catch(() => undefined);
  prefetched = { at: Date.now(), options };
}

function takeOptions(): Promise<ReauthOptions> {
  const p = prefetched;
  prefetched = null;
  return p && Date.now() - p.at < PREFETCH_FRESH_MS
    ? p.options.catch(() => fetchOptions())
    : fetchOptions();
}

/**
 * In the desktop app, when one of the person's passkeys lives on this computer (Windows Hello:
 * transport "internal"), ask only for those and hint the platform authenticator, so Windows
 * opens Hello directly instead of first offering a phone or a security key.
 */
export function forThisDevice(
  options: PublicKeyCredentialRequestOptionsJSON,
): PublicKeyCredentialRequestOptionsJSON {
  if (!desktopBridge()) return options;
  const own = (options.allowCredentials ?? []).filter((c) => c.transports?.includes('internal'));
  if (!own.length) return options;
  return { ...options, allowCredentials: own, hints: ['client-device'] };
}

export async function reauthWithPasskey(): Promise<PasskeyStepUp> {
  try {
    const t0 = performance.now();
    const { challengeId, options } = await takeOptions();
    const t1 = performance.now();
    // Mock mode has no authenticator; the MSW handler accepts a stub assertion.
    const response = config.mock
      ? { mock: true }
      : await startAuthentication({
          optionsJSON: forThisDevice(options as unknown as PublicKeyCredentialRequestOptionsJSON),
        });
    const t2 = performance.now();
    const res = await api.call('reauthPasskeyVerify', {
      body: { challengeId, response: response as unknown as Record<string, unknown> },
    });
    // Where the time goes, for reports from the field (options, system prompt, server check).
    console.info(
      `[passkey] step-up: options ${Math.round(t1 - t0)} ms, prompt ${Math.round(t2 - t1)} ms, verify ${Math.round(performance.now() - t2)} ms`,
    );
    return { ok: true, verifiedUntil: res.verifiedUntil };
  } catch (e) {
    // The person closed the system prompt or it timed out.
    if (e instanceof Error && (e.name === 'NotAllowedError' || e.name === 'AbortError')) {
      return { ok: false, kind: 'cancelled' };
    }
    return { ok: false, kind: 'failed', ...(isApiError(e) ? { code: e.code } : {}) };
  }
}

/**
 * This device's own lock by name, for "verify with … next time": Windows Hello, Touch ID or
 * Face ID; null where it has no common name (the caller then says "the device lock").
 */
export function deviceLockLabel(): string | null {
  if (typeof navigator === 'undefined') return null;
  const ua = navigator.userAgent;
  if (/iPhone|iPad/i.test(ua)) return 'Face ID';
  if (/Windows/i.test(ua)) return 'Windows Hello';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Touch ID';
  return null;
}

const offerKey = (userId: string) => `crewhall.stepup.deviceOffer.${userId}`;

/**
 * After a step-up with the password, offer this device's lock as a passkey for next time: only
 * where a user-verifying platform authenticator exists and the person did not say "not now".
 */
export async function shouldOfferDevicePasskey(userId: string): Promise<boolean> {
  try {
    if (localStorage.getItem(offerKey(userId)) === 'later') return false;
  } catch {
    // No storage: still offer.
  }
  if (typeof PublicKeyCredential === 'undefined') return false;
  return PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().catch(() => false);
}

export function declineDevicePasskey(userId: string): void {
  try {
    localStorage.setItem(offerKey(userId), 'later');
  } catch {
    // Private mode: asked again next time.
  }
}
