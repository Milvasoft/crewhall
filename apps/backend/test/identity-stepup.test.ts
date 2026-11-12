import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLogs, mcpRateBuckets, mcpReauth, passkeys, sessions } from '@crewhall/db';
import {
  Client,
  createTestApp,
  PASSWORD,
  setupWithOwner,
  WEB_ORIGIN,
  type TestApp,
} from './helpers';

/**
 * Step-up without a password (passkey on web and desktop, biometric device key on mobile):
 * each opens the same 10-minute window as the password, is single use, rate limited and
 * audited; the password stays as the fallback.
 */

const b64url = (b: Buffer) => b.toString('base64url');

/** A software authenticator: one ES256 credential, signing like a platform passkey. */
function authenticator() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, new Uint8Array(Buffer.from(jwk.x!, 'base64url'))],
      [-3, new Uint8Array(Buffer.from(jwk.y!, 'base64url'))],
    ]),
  );
  const credentialId = randomBytes(16);
  let counter = 0;
  return {
    credentialId: b64url(credentialId),
    publicKeyBase64: Buffer.from(cose).toString('base64'),
    /** An assertion for the challenge; `uv` false leaves out user verification. */
    assert(challenge: string, opts: { uv?: boolean; key?: KeyObject; origin?: string } = {}) {
      counter++;
      const rpIdHash = createHash('sha256').update(new URL(WEB_ORIGIN).hostname).digest();
      const flags = Buffer.from([opts.uv === false ? 0x01 : 0x05]);
      const count = Buffer.alloc(4);
      count.writeUInt32BE(counter);
      const authData = Buffer.concat([rpIdHash, flags, count]);
      const clientData = Buffer.from(
        JSON.stringify({
          type: 'webauthn.get',
          challenge,
          origin: opts.origin ?? WEB_ORIGIN,
          crossOrigin: false,
        }),
      );
      const signed = Buffer.concat([authData, createHash('sha256').update(clientData).digest()]);
      const signature = sign('sha256', signed, opts.key ?? privateKey);
      return {
        id: b64url(credentialId),
        rawId: b64url(credentialId),
        type: 'public-key',
        response: {
          authenticatorData: b64url(authData),
          clientDataJSON: b64url(clientData),
          signature: b64url(signature),
        },
        clientExtensionResults: {},
      };
    },
  };
}

describe('step-up with a passkey or a device key', () => {
  let app: TestApp;
  let owner: Client;
  let ownerId: string;

  beforeAll(async () => {
    app = await createTestApp();
    ({ owner } = await setupWithOwner(app));
    ownerId = (await owner.api.call('me')).user.id;
  });
  afterAll(() => app.close());

  /** Sessions older than the window and no recent check: nothing counts as verified. */
  const ageSessions = async () => {
    await app.deps.db
      .update(sessions)
      .set({ createdAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(sessions.userId, ownerId));
    await app.deps.db.delete(mcpReauth).where(eq(mcpReauth.userId, ownerId));
    // Every method shares the re-verification budget (5 a minute); start each case with it full.
    await app.deps.db.delete(mcpRateBuckets);
  };
  const reauthAudits = async () =>
    (
      await app.deps.db
        .select({ meta: auditLogs.meta })
        .from(auditLogs)
        .where(and(eq(auditLogs.actorId, ownerId), eq(auditLogs.action, 'identity.reauth')))
    ).map((r) => (r.meta as { method?: string }).method ?? 'password');

  it('verifies with a passkey and opens the window for sensitive changes', async () => {
    const device = authenticator();
    await app.deps.db.insert(passkeys).values({
      userId: ownerId,
      name: 'Dizüstü',
      credentialID: device.credentialId,
      publicKey: device.publicKeyBase64,
      counter: 0,
      deviceType: 'singleDevice',
      backedUp: false,
      transports: 'internal',
    });
    await ageSessions();
    const before = await owner.api.call('getReauthMethods');
    expect(before).toMatchObject({ password: true, passkeys: 1, verifiedUntil: null });
    await expect(
      owner.api.call('updateSecurityPolicy', { body: { session: { hours: 8 } } as never }),
    ).rejects.toMatchObject({ code: 'identity_reauth_required' });

    const { challengeId, options } = await owner.api.call('reauthPasskeyOptions');
    expect(options).toMatchObject({ userVerification: 'required', rpId: 'localhost' });
    const done = await owner.api.call('reauthPasskeyVerify', {
      body: { challengeId, response: device.assert(String(options.challenge)) },
    });
    expect(Date.parse(done.verifiedUntil)).toBeGreaterThan(Date.now() + 9 * 60 * 1000);
    expect((await owner.api.call('getReauthMethods')).verifiedUntil).not.toBeNull();
    await expect(
      owner.api.call('updateSecurityPolicy', { body: { session: { hours: 8 } } as never }),
    ).resolves.toBeTruthy();
    expect(await reauthAudits()).toContain('passkey');

    // A challenge works once; no user verification, another origin or another key fail.
    await expect(
      owner.api.call('reauthPasskeyVerify', {
        body: { challengeId, response: device.assert(String(options.challenge)) },
      }),
    ).rejects.toMatchObject({ code: 'identity_reauth_failed' });
    for (const bad of [
      { uv: false },
      { origin: 'https://evil.example.com' },
      { key: generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey },
    ]) {
      const next = await owner.api.call('reauthPasskeyOptions');
      await expect(
        owner.api.call('reauthPasskeyVerify', {
          body: {
            challengeId: next.challengeId,
            response: device.assert(String(next.options.challenge), bad),
          },
        }),
      ).rejects.toMatchObject({ code: 'identity_reauth_failed' });
    }
  });

  it('registers a device key only after a check, then verifies with its signature', async () => {
    await ageSessions();
    // iOS hands out the raw 65-byte point; Android the SubjectPublicKeyInfo DER.
    const ios = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const rawPoint = Buffer.from(ios.publicKey.export({ format: 'der', type: 'spki' })).subarray(
      -65,
    );
    const body = {
      name: 'iPhone',
      platform: 'ios' as const,
      publicKey: rawPoint.toString('base64'),
    };
    await expect(owner.api.call('registerDeviceKey', { body })).rejects.toMatchObject({
      code: 'identity_reauth_required',
    });
    // Fallback: the password still opens the window.
    await owner.api.call('identityReauth', { body: { password: PASSWORD } });
    const key = await owner.api.call('registerDeviceKey', { body });
    const android = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const key2 = await owner.api.call('registerDeviceKey', {
      body: {
        name: 'Pixel',
        platform: 'android',
        publicKey: Buffer.from(android.publicKey.export({ format: 'der', type: 'spki' })).toString(
          'base64',
        ),
      },
    });
    expect((await owner.api.call('listDeviceKeys')).items.map((k) => k.name)).toEqual([
      'Pixel',
      'iPhone',
    ]);
    await expect(
      owner.api.call('registerDeviceKey', {
        body: { ...body, publicKey: Buffer.alloc(65, 7).toString('base64') },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });

    await ageSessions();
    const signWith = async (
      keyId: string,
      privateKey: KeyObject,
      encoding: 'der' | 'ieee-p1363',
    ) => {
      const opts = await owner.api.call('reauthDeviceOptions', { body: { keyId } });
      const signature = sign('sha256', Buffer.from(opts.challenge, 'base64url'), {
        key: privateKey,
        dsaEncoding: encoding,
      }).toString('base64');
      return { challengeId: opts.challengeId, keyId, signature };
    };
    // DER (Secure Enclave, Keystore) and raw r||s both verify.
    const viaIos = await owner.api.call('reauthDeviceVerify', {
      body: await signWith(key.id, ios.privateKey, 'der'),
    });
    expect(Date.parse(viaIos.verifiedUntil)).toBeGreaterThan(Date.now());
    await owner.api.call('reauthDeviceVerify', {
      body: await signWith(key2.id, android.privateKey, 'ieee-p1363'),
    });
    expect(await reauthAudits()).toEqual(expect.arrayContaining(['device', 'password']));

    // Another key's signature, or a revoked key, does not pass.
    await expect(
      owner.api.call('reauthDeviceVerify', {
        body: await signWith(key.id, android.privateKey, 'der'),
      }),
    ).rejects.toMatchObject({ code: 'identity_reauth_failed' });
    await owner.api.call('deleteDeviceKey', { params: { keyId: key2.id } });
    await expect(
      owner.api.call('reauthDeviceOptions', { body: { keyId: key2.id } }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rate limits failed attempts like the password', async () => {
    await ageSessions();
    const keys = (await owner.api.call('listDeviceKeys')).items;
    const wrong = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    const codes: string[] = [];
    for (let i = 0; i < 7; i++) {
      const opts = await owner.api.call('reauthDeviceOptions', { body: { keyId: keys[0]!.id } });
      const signature = sign('sha256', Buffer.from(opts.challenge, 'base64url'), wrong).toString(
        'base64',
      );
      await owner.api
        .call('reauthDeviceVerify', {
          body: { challengeId: opts.challengeId, keyId: keys[0]!.id, signature },
        })
        .catch((e: { code: string }) => codes.push(e.code));
    }
    expect(codes).toContain('rate_limited');
  });
});
