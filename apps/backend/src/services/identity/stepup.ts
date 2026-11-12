import {
  createPublicKey,
  randomBytes,
  verify as verifySignature,
  type KeyObject,
} from 'node:crypto';
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
} from '@simplewebauthn/server';
import { and, count, desc, eq, gt, isNull } from 'drizzle-orm';
import {
  accounts,
  deviceKeys,
  mcpReauth,
  passkeys,
  reauthChallenges,
  type DbOrTx,
} from '@crewhall/db';
import type { DeviceKey, DeviceKeyPlatform, ReauthMethods } from '@crewhall/shared';
import type { Deps } from '../../deps';
import type { Env } from '../../env';
import { AppError } from '../../http/errors';
import type { AuthSession, RequestInfo } from '../../http/types';
import { take } from '../mcp/rate-limit';
import { REAUTH_WINDOW_MS, verifiedUntil } from '../mcp/reauth';
import { identityAudit } from './audit';

/**
 * Step-up without typing the password: a passkey assertion (web, desktop) or a signature
 * from a biometric-protected device key (mobile: Face ID, fingerprint). Both open the same
 * 10-minute window as the password (mcp_reauth row of the session), are rate limited like
 * it and audited as identity.reauth with the method.
 */

const CHALLENGE_TTL_MS = 2 * 60 * 1000;
const MAX_DEVICE_KEYS = 10;

export interface StepUpCtx {
  orgId: string;
  userId: string;
  session: AuthSession;
}

/** The same relying party and origins as better-auth's passkey plugin (auth/auth.ts). */
function relyingParty(env: Env) {
  return {
    rpID: new URL(env.HUB_URL).hostname,
    origins: [env.HUB_URL, ...env.WEB_ORIGINS].map((o) => new URL(o).origin),
  };
}

async function limit(db: DbOrTx, ctx: StepUpCtx) {
  const res = await take(db, ctx.userId, { kind: 'reauth', perMinute: 5 }, ctx.orgId);
  if (!res.allowed) throw new AppError('rate_limited', { retryAfter: res.retryAfter });
}

/** Opens the verification window for this session and audits the method. */
async function markVerified(
  db: DbOrTx,
  ctx: StepUpCtx,
  method: 'passkey' | 'device',
  req?: RequestInfo,
  meta: Record<string, unknown> = {},
) {
  const now = new Date();
  await db
    .insert(mcpReauth)
    .values({ sessionId: ctx.session.id, orgId: ctx.orgId, userId: ctx.userId, verifiedAt: now })
    .onConflictDoUpdate({ target: mcpReauth.sessionId, set: { verifiedAt: now } });
  await identityAudit(
    db,
    {
      orgId: ctx.orgId,
      actorId: ctx.userId,
      action: 'identity.reauth',
      targetType: 'session',
      targetId: ctx.session.id,
      meta: { method, ...meta },
    },
    req,
  );
  return { verifiedUntil: new Date(now.getTime() + REAUTH_WINDOW_MS).toISOString() };
}

/** A pending challenge of this person and session, used at most once. */
async function claimChallenge(
  db: DbOrTx,
  ctx: StepUpCtx,
  challengeId: string,
  kind: 'passkey' | 'device',
) {
  const [row] = await db
    .update(reauthChallenges)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(reauthChallenges.id, challengeId),
        eq(reauthChallenges.userId, ctx.userId),
        eq(reauthChallenges.sessionId, ctx.session.id),
        eq(reauthChallenges.kind, kind),
        isNull(reauthChallenges.usedAt),
        gt(reauthChallenges.expiresAt, new Date()),
      ),
    )
    .returning();
  if (!row) throw new AppError('identity_reauth_failed', { reason: 'challenge' });
  return row;
}

const toDeviceKey = (r: typeof deviceKeys.$inferSelect): DeviceKey => ({
  id: r.id,
  name: r.name,
  platform: r.platform as DeviceKeyPlatform,
  createdAt: r.createdAt.toISOString(),
  lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
});

async function activeDeviceKeys(db: DbOrTx, userId: string) {
  return db
    .select()
    .from(deviceKeys)
    .where(and(eq(deviceKeys.userId, userId), isNull(deviceKeys.revokedAt)))
    .orderBy(desc(deviceKeys.createdAt));
}

export async function reauthMethods(db: DbOrTx, ctx: StepUpCtx): Promise<ReauthMethods> {
  const [credential] = await db
    .select({ hash: accounts.password })
    .from(accounts)
    .where(and(eq(accounts.userId, ctx.userId), eq(accounts.providerId, 'credential')));
  const [pk] = await db
    .select({ n: count() })
    .from(passkeys)
    .where(eq(passkeys.userId, ctx.userId));
  const until = await verifiedUntil({ db }, ctx.session);
  return {
    password: Boolean(credential?.hash),
    passkeys: pk?.n ?? 0,
    deviceKeys: (await activeDeviceKeys(db, ctx.userId)).map(toDeviceKey),
    verifiedUntil: until > Date.now() ? new Date(until).toISOString() : null,
  };
}

// ---- passkey ---------------------------------------------------------------------------

export async function passkeyOptions(deps: Pick<Deps, 'db' | 'env'>, ctx: StepUpCtx) {
  const mine = await deps.db.select().from(passkeys).where(eq(passkeys.userId, ctx.userId));
  if (!mine.length) throw new AppError('not_found', { reason: 'no_passkey' });
  const { rpID } = relyingParty(deps.env);
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'required',
    timeout: CHALLENGE_TTL_MS,
    allowCredentials: mine.map((p) => ({
      id: p.credentialID,
      transports: p.transports
        ? (p.transports.split(',').filter(Boolean) as AuthenticatorTransportFuture[])
        : undefined,
    })),
  });
  const [row] = await deps.db
    .insert(reauthChallenges)
    .values({
      userId: ctx.userId,
      sessionId: ctx.session.id,
      kind: 'passkey',
      challenge: options.challenge,
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
    })
    .returning({ id: reauthChallenges.id });
  return { challengeId: row!.id, options: options as unknown as Record<string, unknown> };
}

export async function passkeyVerify(
  deps: Pick<Deps, 'db' | 'env'>,
  ctx: StepUpCtx,
  input: { challengeId: string; response: Record<string, unknown> },
  req?: RequestInfo,
) {
  await limit(deps.db, ctx);
  const challenge = await claimChallenge(deps.db, ctx, input.challengeId, 'passkey');
  const response = input.response as unknown as AuthenticationResponseJSON;
  const [passkey] = await deps.db
    .select()
    .from(passkeys)
    .where(and(eq(passkeys.userId, ctx.userId), eq(passkeys.credentialID, String(response.id))));
  if (!passkey) throw new AppError('identity_reauth_failed', { reason: 'passkey' });
  const { rpID, origins } = relyingParty(deps.env);
  let verified: boolean;
  let newCounter = passkey.counter;
  try {
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: origins,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: {
        id: passkey.credentialID,
        publicKey: new Uint8Array(Buffer.from(passkey.publicKey, 'base64')),
        counter: passkey.counter,
        transports: passkey.transports
          ? (passkey.transports.split(',').filter(Boolean) as AuthenticatorTransportFuture[])
          : undefined,
      },
    });
    verified = result.verified;
    newCounter = result.authenticationInfo.newCounter;
  } catch {
    verified = false;
  }
  if (!verified) throw new AppError('identity_reauth_failed', { reason: 'passkey' });
  await deps.db.update(passkeys).set({ counter: newCounter }).where(eq(passkeys.id, passkey.id));
  return markVerified(deps.db, ctx, 'passkey', req, { passkeyId: passkey.id });
}

// ---- device keys -----------------------------------------------------------------------

/** P-256 public key from SPKI DER or the 65-byte uncompressed point; SPKI DER base64 out. */
export function normalizeDeviceKey(base64: string): { key: KeyObject; spki: string } {
  const raw = Buffer.from(base64, 'base64');
  let key: KeyObject;
  try {
    key =
      raw.length === 65 && raw[0] === 0x04
        ? createPublicKey({
            key: {
              kty: 'EC',
              crv: 'P-256',
              x: raw.subarray(1, 33).toString('base64url'),
              y: raw.subarray(33, 65).toString('base64url'),
            },
            format: 'jwk',
          })
        : createPublicKey({ key: raw, format: 'der', type: 'spki' });
  } catch {
    throw new AppError('validation_failed', { field: 'publicKey', reason: 'not_a_key' });
  }
  const details = key.asymmetricKeyDetails;
  if (key.asymmetricKeyType !== 'ec' || details?.namedCurve !== 'prime256v1') {
    throw new AppError('validation_failed', { field: 'publicKey', reason: 'p256_only' });
  }
  return { key, spki: key.export({ format: 'der', type: 'spki' }).toString('base64') };
}

export async function registerDeviceKey(
  db: DbOrTx,
  ctx: StepUpCtx,
  input: { name: string; platform: DeviceKeyPlatform; publicKey: string },
  req?: RequestInfo,
) {
  // A new key is itself a way in: it needs a password or passkey check first.
  if ((await verifiedUntil({ db }, ctx.session)) <= Date.now()) {
    throw new AppError('identity_reauth_required');
  }
  const { spki } = normalizeDeviceKey(input.publicKey);
  const existing = await activeDeviceKeys(db, ctx.userId);
  if (existing.length >= MAX_DEVICE_KEYS)
    throw new AppError('conflict', { reason: 'too_many_keys' });
  const [row] = await db
    .insert(deviceKeys)
    .values({
      userId: ctx.userId,
      orgId: ctx.orgId,
      name: input.name,
      platform: input.platform,
      publicKey: spki,
    })
    .returning();
  await identityAudit(
    db,
    {
      orgId: ctx.orgId,
      actorId: ctx.userId,
      action: 'identity.device_key.create',
      targetType: 'device_key',
      targetId: row!.id,
      meta: { name: input.name, platform: input.platform },
    },
    req,
  );
  return toDeviceKey(row!);
}

export async function listDeviceKeys(db: DbOrTx, ctx: StepUpCtx) {
  return { items: (await activeDeviceKeys(db, ctx.userId)).map(toDeviceKey), nextCursor: null };
}

export async function deleteDeviceKey(
  db: DbOrTx,
  ctx: StepUpCtx,
  keyId: string,
  req?: RequestInfo,
) {
  const [row] = await db
    .update(deviceKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(deviceKeys.id, keyId),
        eq(deviceKeys.userId, ctx.userId),
        isNull(deviceKeys.revokedAt),
      ),
    )
    .returning({ id: deviceKeys.id });
  if (!row) throw new AppError('not_found');
  await identityAudit(
    db,
    {
      orgId: ctx.orgId,
      actorId: ctx.userId,
      action: 'identity.device_key.delete',
      targetType: 'device_key',
      targetId: keyId,
    },
    req,
  );
}

async function ownKey(db: DbOrTx, ctx: StepUpCtx, keyId: string) {
  const [key] = await db
    .select()
    .from(deviceKeys)
    .where(
      and(
        eq(deviceKeys.id, keyId),
        eq(deviceKeys.userId, ctx.userId),
        isNull(deviceKeys.revokedAt),
      ),
    );
  if (!key) throw new AppError('not_found');
  return key;
}

export async function deviceOptions(db: DbOrTx, ctx: StepUpCtx, keyId: string) {
  await ownKey(db, ctx, keyId);
  const challenge = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
  const [row] = await db
    .insert(reauthChallenges)
    .values({
      userId: ctx.userId,
      sessionId: ctx.session.id,
      kind: 'device',
      challenge,
      deviceKeyId: keyId,
      expiresAt,
    })
    .returning({ id: reauthChallenges.id });
  return { challengeId: row!.id, challenge, expiresAt: expiresAt.toISOString() };
}

/** ECDSA P-256 / SHA-256 over the challenge bytes; DER or raw r||s signatures. */
export function verifyDeviceSignature(spki: string, challenge: string, signature: string) {
  const key = createPublicKey({ key: Buffer.from(spki, 'base64'), format: 'der', type: 'spki' });
  const data = Buffer.from(challenge, 'base64url');
  const sig = Buffer.from(signature, 'base64');
  const encodings: ('der' | 'ieee-p1363')[] = sig.length === 64 ? ['ieee-p1363', 'der'] : ['der'];
  return encodings.some((dsaEncoding) => {
    try {
      return verifySignature('sha256', data, { key, dsaEncoding }, sig);
    } catch {
      return false;
    }
  });
}

export async function deviceVerify(
  db: DbOrTx,
  ctx: StepUpCtx,
  input: { challengeId: string; keyId: string; signature: string },
  req?: RequestInfo,
) {
  await limit(db, ctx);
  const challenge = await claimChallenge(db, ctx, input.challengeId, 'device');
  if (challenge.deviceKeyId !== input.keyId) {
    throw new AppError('identity_reauth_failed', { reason: 'challenge' });
  }
  const key = await ownKey(db, ctx, input.keyId);
  if (!verifyDeviceSignature(key.publicKey, challenge.challenge, input.signature)) {
    throw new AppError('identity_reauth_failed', { reason: 'signature' });
  }
  await db.update(deviceKeys).set({ lastUsedAt: new Date() }).where(eq(deviceKeys.id, key.id));
  return markVerified(db, ctx, 'device', req, { deviceKeyId: key.id });
}
