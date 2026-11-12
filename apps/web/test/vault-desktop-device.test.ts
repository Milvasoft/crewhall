import { type VaultKeyStatus } from '@crewhall/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ApiModule from '@/lib/api';
import { ApiError } from '@/lib/api';
import { deviceState, enrolDevice, unlockWithDevice, vaultStamp } from '@/lib/vault/desktop-device';

const call = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof ApiModule>();
  return { ...real, api: { ...real.api, call } };
});
const unlockWithSecret = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/lib/vault/api', () => ({ unlockWithSecret }));
vi.mock('@/lib/vault/session', () => ({
  requireUnlocked: () => ({ userId: 'u1', privateKey: new Uint8Array(32).fill(3) }),
}));

const status = {
  keyVersion: 1,
  passwordChangedAt: '2026-10-01T00:00:00.000Z',
  unlockMethods: [{ id: 'dev-1', method: 'device', label: 'Windows Hello' }],
} as unknown as VaultKeyStatus;

const bridge = {
  status: vi.fn(),
  challenge: vi.fn(),
  enrol: vi.fn(),
  unlock: vi.fn(),
  passwordUnlocked: vi.fn(async () => undefined),
  forget: vi.fn(async () => ({ unlockId: 'dev-1' })),
};

const ab = (...b: number[]) => new Uint8Array(b).buffer;

beforeEach(() => {
  vi.clearAllMocks();
  window.crewhallDesktop = {
    isDesktop: true,
    platform: 'win32',
    features: ['vaultDevice'],
    vaultDevice: bridge,
  };
  vi.stubGlobal('PublicKeyCredential', {
    isUserVerifyingPlatformAuthenticatorAvailable: async () => true,
  });
});
afterEach(() => {
  delete window.crewhallDesktop;
  vi.unstubAllGlobals();
});

describe('Hello unlock state', () => {
  it('is unavailable in a browser and without a platform authenticator', async () => {
    delete window.crewhallDesktop;
    expect(await deviceState('u1', status)).toBe('unavailable');
    window.crewhallDesktop = {
      isDesktop: true,
      platform: 'win32',
      features: [],
      vaultDevice: bridge,
    };
    expect(await deviceState('u1', status)).toBe('unavailable');
  });

  it('is ready within the window, expired after it', async () => {
    bridge.status.mockResolvedValue({
      available: true,
      enrolled: true,
      usable: true,
      unlockId: 'dev-1',
    });
    expect(await deviceState('u1', status)).toBe('ready');
    expect(bridge.status).toHaveBeenCalledWith('u1', vaultStamp(status));
    bridge.status.mockResolvedValue({
      available: true,
      enrolled: true,
      usable: false,
      unlockId: 'dev-1',
    });
    expect(await deviceState('u1', status)).toBe('expired');
  });

  it('forgets a device the server no longer knows, and removes a stale one there', async () => {
    bridge.status.mockResolvedValue({
      available: true,
      enrolled: true,
      usable: true,
      unlockId: 'gone',
    });
    expect(await deviceState('u1', status)).toBe('off');

    // A new vault password made it stale: its server method goes too.
    bridge.status.mockResolvedValue({ available: true, enrolled: false, stale: 'dev-0' });
    call.mockResolvedValue(undefined);
    expect(await deviceState('u1', status)).toBe('off');
    expect(call).toHaveBeenCalledWith('vaultRemoveUnlockMethod', { params: { unlockId: 'dev-0' } });
  });
});

describe('Hello unlock', () => {
  function stubGet() {
    const get = vi.fn(async () => ({
      rawId: ab(1, 2, 3),
      response: { clientDataJSON: ab(4), authenticatorData: ab(5), signature: ab(6) },
    }));
    vi.stubGlobal('navigator', { ...navigator, credentials: { get } });
    return get;
  }

  it('asks Windows Hello for the app challenge and opens with the released secret', async () => {
    const get = stubGet();
    bridge.challenge.mockResolvedValue({
      challenge: 'AAEC',
      rpId: 'go.crewhall.app',
      credentialId: 'AQID',
    });
    bridge.unlock.mockResolvedValue({ unlockId: 'dev-1', secret: btoa('x'.repeat(32)) });
    expect(await unlockWithDevice('u1')).toBe(true);
    const options = (get.mock.calls[0] as unknown as [CredentialRequestOptions])[0].publicKey!;
    expect(options.userVerification).toBe('required');
    expect(options.rpId).toBe('go.crewhall.app');
    expect(bridge.unlock).toHaveBeenCalledWith('u1', {
      credentialId: 'AQID',
      clientDataJSON: 'BA',
      authenticatorData: 'BQ',
      signature: 'Bg',
    });
    expect(unlockWithSecret).toHaveBeenCalledWith('u1', 'device', 'dev-1', expect.anything());
  });

  it('falls back to the password when the server forgot this device', async () => {
    stubGet();
    bridge.challenge.mockResolvedValue({
      challenge: 'AAEC',
      rpId: 'go.crewhall.app',
      credentialId: 'AQID',
    });
    bridge.unlock.mockResolvedValue({ unlockId: 'dev-1', secret: btoa('x'.repeat(32)) });
    unlockWithSecret.mockRejectedValueOnce(new ApiError(403, 'vault_unlock_failed', ''));
    expect(await unlockWithDevice('u1')).toBe(false);
    expect(bridge.forget).toHaveBeenCalledWith('u1');
  });
});

describe('Hello set-up', () => {
  function stubCreate() {
    const create = vi.fn(async () => ({
      rawId: ab(9, 9),
      response: {
        clientDataJSON: ab(1),
        getAuthenticatorData: () => ab(2),
        getPublicKey: () => ab(3),
        getPublicKeyAlgorithm: () => -7,
      },
    }));
    vi.stubGlobal('navigator', { ...navigator, credentials: { create } });
    return create;
  }

  it('creates a user-verifying platform credential and hands the app its key and the secret', async () => {
    const create = stubCreate();
    bridge.challenge.mockResolvedValue({ challenge: 'AAEC', rpId: 'go.crewhall.app' });
    bridge.enrol.mockResolvedValue({ replaced: 'old-dev' });
    call.mockImplementation(async (name: string) =>
      name === 'vaultAddUnlockMethod' ? { id: 'dev-2' } : undefined,
    );
    await enrolDevice(status, 'Windows Hello · masaüstü uygulaması', new Uint8Array(32).fill(1));
    const sel = (create.mock.calls[0] as unknown as [CredentialCreationOptions])[0].publicKey!
      .authenticatorSelection!;
    expect(sel).toMatchObject({
      authenticatorAttachment: 'platform',
      userVerification: 'required',
    });
    expect(call).toHaveBeenCalledWith(
      'vaultAddUnlockMethod',
      expect.objectContaining({ body: expect.objectContaining({ method: 'device' }) }),
    );
    const [, input] = bridge.enrol.mock.calls[0] as [
      string,
      { unlockId: string; secret: string; stamp: string; credential: object },
    ];
    expect(input.unlockId).toBe('dev-2');
    expect(atob(input.secret)).toHaveLength(32);
    expect(input.stamp).toBe(vaultStamp(status));
    expect(input.credential).toEqual({
      credentialId: 'CQk',
      clientDataJSON: 'AQ',
      authenticatorData: 'Ag',
      publicKey: 'Aw',
      alg: -7,
    });
    // The device it replaced is removed on the server.
    expect(call).toHaveBeenCalledWith('vaultRemoveUnlockMethod', {
      params: { unlockId: 'old-dev' },
    });
  });

  it('removes the new server method when the app refuses the credential', async () => {
    stubCreate();
    bridge.challenge.mockResolvedValue({ challenge: 'AAEC', rpId: 'go.crewhall.app' });
    bridge.enrol.mockRejectedValue(new Error('vault device: not_verified'));
    call.mockImplementation(async (name: string) =>
      name === 'vaultAddUnlockMethod' ? { id: 'dev-3' } : undefined,
    );
    await expect(enrolDevice(status, 'x', new Uint8Array(32))).rejects.toThrow('not_verified');
    expect(call).toHaveBeenCalledWith('vaultRemoveUnlockMethod', { params: { unlockId: 'dev-3' } });
  });
});
