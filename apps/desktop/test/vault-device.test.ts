import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEVICE_UNLOCK_DAYS,
  DeviceCheckError,
  b64url,
  deviceUsable,
  vaultStamp,
  verifyAssertion,
  verifyRegistration,
} from '../src/common/vault-device';

const origin = 'https://go.crewhall.app';
const rpId = 'go.crewhall.app';
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest();
const credId = Buffer.from('hello-credential-0001');

function authData(flags: number, counter: number, credential?: Buffer, host = rpId): Buffer {
  const head = Buffer.alloc(37);
  sha(host).copy(head, 0);
  head[32] = flags;
  head.writeUInt32BE(counter, 33);
  if (!credential) return head;
  const len = Buffer.alloc(2);
  len.writeUInt16BE(credential.length);
  return Buffer.concat([head, Buffer.alloc(16), len, credential, Buffer.from([0xa0])]);
}

function clientData(type: string, challenge: string, o = origin): Buffer {
  return Buffer.from(JSON.stringify({ type, challenge, origin: o, crossOrigin: false }));
}

function keys(kind: 'ec' | 'rsa') {
  const pair =
    kind === 'ec'
      ? generateKeyPairSync('ec', { namedCurve: 'P-256' })
      : generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spki = pair.publicKey.export({ type: 'spki', format: 'der' });
  return { privateKey: pair.privateKey, spki, alg: kind === 'ec' ? -7 : -257 };
}

function registration(k: ReturnType<typeof keys>, challenge: string, flags = 0x45) {
  return {
    credentialId: b64url(credId),
    clientDataJSON: b64url(clientData('webauthn.create', challenge)),
    authenticatorData: b64url(authData(flags, 0, credId)),
    publicKey: b64url(k.spki),
    alg: k.alg,
  };
}

function assertion(
  privateKey: KeyObject,
  challenge: string,
  { flags = 0x05, counter = 1, o = origin, host = rpId } = {},
) {
  const ad = authData(flags, counter, undefined, host);
  const cd = clientData('webauthn.get', challenge, o);
  const signature = sign('sha256', Buffer.concat([ad, sha(cd)]), privateKey);
  return {
    credentialId: b64url(credId),
    clientDataJSON: b64url(cd),
    authenticatorData: b64url(ad),
    signature: b64url(signature),
  };
}

const challenge = b64url(Buffer.alloc(32, 7));
const expected = { challenge, origin, rpId };
const other32 = (n: number) => b64url(Buffer.alloc(32, n));

/** The check that failed, or "passed". */
function reason(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof DeviceCheckError ? e.reason : String(e);
  }
  return 'passed';
}

describe('Windows Hello registration', () => {
  it('keeps the public key of a user-verified platform credential', () => {
    const k = keys('ec');
    const kept = verifyRegistration(registration(k, challenge), expected);
    expect(kept).toMatchObject({ credentialId: b64url(credId), alg: -7, signCount: 0 });
    expect(Buffer.from(kept.publicKey, 'base64').equals(k.spki)).toBe(true);
  });

  it('refuses one without user verification, for another site, challenge or credential', () => {
    const k = keys('ec');
    const ok = registration(k, challenge);
    const check = (r: typeof ok, e = expected) => reason(() => verifyRegistration(r, e));
    expect(check(registration(k, challenge, 0x41))).toBe('not_verified');
    expect(check(ok, { ...expected, origin: 'https://evil.io' })).toBe('origin');
    expect(check(registration(k, other32(1)))).toBe('challenge');
    expect(check(ok, { ...expected, rpId: 'evil.io' })).toBe('rp_id');
    expect(check({ ...ok, alg: -999 })).toBe('alg');
    expect(check({ ...ok, credentialId: b64url(Buffer.from('other')) })).toBe('credential_id');
    expect(check({ ...ok, publicKey: b64url(Buffer.from('not a key')) })).toBe('public_key');
  });
});

describe('Windows Hello unlock', () => {
  for (const kind of ['ec', 'rsa'] as const) {
    it(`accepts a fresh, verified, signed assertion (${kind})`, () => {
      const k = keys(kind);
      const stored = verifyRegistration(registration(k, challenge), expected);
      const a = assertion(k.privateKey, challenge, { counter: 3 });
      expect(verifyAssertion(a, stored, expected)).toBe(3);
    });
  }

  it('refuses tampering, other keys, replays and unverified users', () => {
    const k = keys('ec');
    const other = keys('ec');
    const stored = { ...verifyRegistration(registration(k, challenge), expected), signCount: 5 };
    const check = (a: ReturnType<typeof assertion>) =>
      reason(() => verifyAssertion(a, stored, expected));
    const good = assertion(k.privateKey, challenge, { counter: 6 });
    expect(check(good)).toBe('passed');
    expect(check(assertion(other.privateKey, challenge, { counter: 6 }))).toBe('signature');
    expect(check({ ...good, authenticatorData: b64url(authData(0x05, 9)) })).toBe('signature');
    expect(check(assertion(k.privateKey, challenge, { counter: 5 }))).toBe('counter');
    expect(check(assertion(k.privateKey, challenge, { flags: 0x01, counter: 7 }))).toBe(
      'not_verified',
    );
    expect(check(assertion(k.privateKey, other32(2), { counter: 7 }))).toBe('challenge');
    expect(check(assertion(k.privateKey, challenge, { o: 'https://evil.io', counter: 7 }))).toBe(
      'origin',
    );
    expect(check(assertion(k.privateKey, challenge, { host: 'evil.io', counter: 7 }))).toBe(
      'rp_id',
    );
    expect(check({ ...good, credentialId: b64url(Buffer.from('x')) })).toBe('credential_id');
  });

  it('accepts authenticators that keep no counter (always 0)', () => {
    const k = keys('ec');
    const stored = verifyRegistration(registration(k, challenge), expected);
    expect(
      verifyAssertion(assertion(k.privateKey, challenge, { counter: 0 }), stored, expected),
    ).toBe(0);
  });
});

describe('device window', () => {
  const day = 86_400_000;
  const stamp = vaultStamp(1, '2026-10-01T00:00:00.000Z');

  it('lasts 14 days after the last unlock with the vault password', () => {
    expect(DEVICE_UNLOCK_DAYS).toBe(14);
    expect(deviceUsable({ passwordAt: 0, stamp }, stamp, 13 * day)).toBe('ok');
    expect(deviceUsable({ passwordAt: 0, stamp }, stamp, 14 * day)).toBe('expired');
  });

  it('ends with a new vault password or a key rotation', () => {
    const changed = vaultStamp(1, '2026-10-20T00:00:00.000Z');
    expect(deviceUsable({ passwordAt: 0, stamp }, changed, 1)).toBe('stale');
    expect(
      deviceUsable({ passwordAt: 0, stamp }, vaultStamp(2, '2026-10-01T00:00:00.000Z'), 1),
    ).toBe('stale');
  });
});
