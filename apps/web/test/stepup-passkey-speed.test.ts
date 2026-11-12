import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ApiModule from '@/lib/api';
import { forThisDevice, prefetchPasskeyOptions, reauthWithPasskey } from '@/lib/identity/stepup';

const call = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof ApiModule>();
  return { ...real, api: { ...real.api, call } };
});

// jsdom has no authenticator: the browser library answers like a platform passkey would.
const startAuthentication = vi.hoisted(() => vi.fn(async () => ({ id: 'hello' })));
vi.mock('@simplewebauthn/browser', () => ({ startAuthentication }));

/** Passkey step-up speed (sonraki-isler: Windows Hello "çok yavaş"). */

const options = {
  challenge: 'AAEC',
  rpId: 'go.crewhall.app',
  userVerification: 'required' as const,
  allowCredentials: [
    { id: 'phone', type: 'public-key' as const, transports: ['hybrid' as const] },
    { id: 'hello', type: 'public-key' as const, transports: ['internal' as const] },
  ],
};

beforeEach(() => {
  call.mockReset();
  call.mockImplementation(async (name: string) =>
    name === 'reauthPasskeyOptions'
      ? { challengeId: 'c1', options }
      : { verifiedUntil: '2026-10-29T10:10:00.000Z' },
  );
});
afterEach(() => delete window.crewhallDesktop);

describe('forThisDevice', () => {
  it('changes nothing in a browser', () => {
    expect(forThisDevice(options)).toBe(options);
  });

  it('asks only for this computer’s Hello passkey in the desktop app, with a platform hint', () => {
    window.crewhallDesktop = { isDesktop: true, platform: 'win32', features: [] };
    expect(forThisDevice(options)).toEqual({
      ...options,
      allowCredentials: [options.allowCredentials[1]],
      hints: ['client-device'],
    });
  });

  it('keeps every passkey when none lives on this computer', () => {
    window.crewhallDesktop = { isDesktop: true, platform: 'win32', features: [] };
    const elsewhere = { ...options, allowCredentials: [options.allowCredentials[0]!] };
    expect(forThisDevice(elsewhere)).toBe(elsewhere);
  });
});

describe('prefetch', () => {
  it('uses the options fetched when the dialog opened: one round trip less on click', async () => {
    prefetchPasskeyOptions();
    prefetchPasskeyOptions();
    expect(call).toHaveBeenCalledTimes(1);
    const res = await reauthWithPasskey();
    expect(res).toEqual({ ok: true, verifiedUntil: '2026-10-29T10:10:00.000Z' });
    // Options once (prefetched), verify once.
    expect(call.mock.calls.map((c) => c[0])).toEqual([
      'reauthPasskeyOptions',
      'reauthPasskeyVerify',
    ]);
  });

  it('fetches fresh options when nothing was prefetched', async () => {
    await reauthWithPasskey();
    expect(call.mock.calls.map((c) => c[0])).toEqual([
      'reauthPasskeyOptions',
      'reauthPasskeyVerify',
    ]);
  });
});
