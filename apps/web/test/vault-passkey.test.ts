import { secretUnlockMaterial, toB64, toB64Url } from '@crewhall/crypto';
import { type VaultUnlockMethod } from '@crewhall/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { passkeyUnlock } from '@/lib/vault/passkey';

/**
 * Passkey unlock with several vault passkeys (one in the browser's password manager, one in
 * Windows Hello on the desktop app...): all are offered, each with its own PRF salt, and the
 * one the authenticator used picks the unlock method.
 */

const bytes = (n: number, fill: number) => new Uint8Array(n).fill(fill);

function method(id: string, credential: Uint8Array, salt: Uint8Array): VaultUnlockMethod {
  return {
    id,
    method: 'passkey_prf',
    label: id,
    credentialId: toB64Url(credential),
    prfSalt: toB64(salt),
    createdAt: '2026-10-01T00:00:00.000Z',
    lastUsedAt: null,
  } as VaultUnlockMethod;
}

// Credential ids with "+" / "/" in base64 so the base64url spelling matters.
const browserCred = bytes(16, 0xfb);
const desktopCred = bytes(16, 0xfe);
const methods = [
  method('browser', browserCred, bytes(32, 1)),
  method('desktop', desktopCred, bytes(32, 2)),
];

function stubGet(impl: (o: CredentialRequestOptions) => Promise<unknown>) {
  const get = vi.fn(impl);
  vi.stubGlobal('navigator', { ...navigator, credentials: { get } });
  return get;
}

const answer = (rawId: Uint8Array, prf?: Uint8Array) => ({
  rawId: rawId.slice().buffer,
  getClientExtensionResults: () => (prf ? { prf: { results: { first: prf.slice().buffer } } } : {}),
});

afterEach(() => vi.unstubAllGlobals());

describe('vault passkey unlock', () => {
  it('offers every passkey with its own salt and unlocks with the one on this device', async () => {
    const secret = bytes(32, 7);
    const get = stubGet(async () => answer(desktopCred, secret));
    const { method: used, material } = await passkeyUnlock(methods);

    const pk = get.mock.calls[0]![0].publicKey!;
    expect(pk.allowCredentials!.map((c) => new Uint8Array(c.id as ArrayBuffer))).toEqual([
      browserCred,
      desktopCred,
    ]);
    const evalBy = (
      pk.extensions as { prf: { evalByCredential: Record<string, { first: ArrayBuffer }> } }
    ).prf.evalByCredential;
    expect(Object.keys(evalBy)).toEqual([toB64Url(browserCred), toB64Url(desktopCred)]);
    expect(new Uint8Array(evalBy[toB64Url(desktopCred)]!.first)).toEqual(bytes(32, 2));

    expect(used.id).toBe('desktop');
    expect(material.verifier).toEqual(secretUnlockMaterial(bytes(32, 7)).verifier);
  });

  it('reports a missing passkey apart from a missing PRF', async () => {
    stubGet(async () => {
      throw new DOMException('no credential', 'NotAllowedError');
    });
    await expect(passkeyUnlock(methods)).rejects.toThrow('no_passkey');

    stubGet(async () => answer(bytes(16, 9), bytes(32, 7)));
    await expect(passkeyUnlock(methods)).rejects.toThrow('no_passkey');

    stubGet(async () => answer(browserCred));
    await expect(passkeyUnlock(methods)).rejects.toThrow('prf_unsupported');

    await expect(passkeyUnlock([])).rejects.toThrow('no_passkey');
  });
});
