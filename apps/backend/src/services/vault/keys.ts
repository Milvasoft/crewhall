import { and, eq, sql } from 'drizzle-orm';
import { userKeys, userKeyUnlocks, vaultMembers, vaultVaults, type DbOrTx } from '@crewhall/db';
import type {
  VaultKeyStatus,
  VaultPublicKey,
  VaultSetupKeys,
  VaultUnlockBundle,
  VaultUnlockMethod,
  VaultUnlockRequest,
} from '@crewhall/shared';
import type { z } from 'zod';
import type {
  VaultAddUnlockMethod,
  VaultChangePassword,
  VaultProof,
  VaultRotateRecovery,
} from '@crewhall/shared';
import { AppError } from '../../http/errors';
import {
  auditVault,
  iso,
  isoOrNull,
  logEvent,
  sha256,
  toB64,
  toBytes,
  vaultCapableMember,
  verifierMatches,
  type VaultActor,
} from './common';

/**
 * Account keys (doc 17 §7 "Kurulum", design 8.1-8.3, 8.16). The server keeps the private key
 * only in wrapped form and releases a wrapped copy when the client proves it derived the right
 * key: a 32-byte verifier (HKDF of the Argon2id output, the recovery key or the PRF output)
 * whose SHA-256 is stored. Wrong verifiers count towards a 5-try / 30-second wait enforced
 * here, not in the client.
 */

export const MAX_FAILED_UNLOCKS = 5;
export const UNLOCK_WAIT_MS = 30_000;

type KeysRow = typeof userKeys.$inferSelect;
type UnlockRow = typeof userKeyUnlocks.$inferSelect;

async function keysOf(db: DbOrTx, userId: string, forUpdate = false) {
  const q = db.select().from(userKeys).where(eq(userKeys.userId, userId));
  const [row] = forUpdate ? await q.for('update') : await q;
  return row ?? null;
}

export async function requireKeys(db: DbOrTx, userId: string, forUpdate = false) {
  const row = await keysOf(db, userId, forUpdate);
  if (!row) throw new AppError('vault_setup_required');
  return row;
}

const toMethod = (u: UnlockRow): VaultUnlockMethod => ({
  id: u.id,
  method: u.method,
  label: u.label,
  credentialId: u.credentialId,
  prfSalt: u.prfSalt ? toB64(u.prfSalt) : null,
  createdAt: iso(u.createdAt),
  lastUsedAt: isoOrNull(u.lastUsedAt),
});

export async function keyStatus(db: DbOrTx, userId: string): Promise<VaultKeyStatus> {
  const row = await keysOf(db, userId);
  if (!row) {
    return {
      setUp: false,
      publicKey: null,
      fingerprint: null,
      kdf: null,
      keyVersion: 0,
      unlockMethods: [],
      recoveryCreatedAt: null,
      passwordChangedAt: null,
      failedAttempts: 0,
      lockedUntil: null,
    };
  }
  const unlocks = await db
    .select()
    .from(userKeyUnlocks)
    .where(eq(userKeyUnlocks.userId, userId))
    .orderBy(userKeyUnlocks.createdAt);
  const locked = row.lockedUntil && row.lockedUntil.getTime() > Date.now() ? row.lockedUntil : null;
  return {
    setUp: true,
    publicKey: toB64(row.publicKey),
    fingerprint: row.fingerprint,
    kdf: row.kdf,
    keyVersion: row.keyVersion,
    unlockMethods: unlocks.map(toMethod),
    recoveryCreatedAt: iso(row.recoveryCreatedAt),
    passwordChangedAt: iso(row.passwordChangedAt),
    failedAttempts: row.failedAttempts,
    lockedUntil: isoOrNull(locked),
  };
}

/** Setup (design 8.1-8.2): keys and the personal vault in one transaction. */
export async function setupKeys(db: DbOrTx, a: VaultActor, input: VaultSetupKeys) {
  if (await keysOf(db, a.userId)) throw new AppError('vault_already_set_up');
  await db.insert(userKeys).values({
    userId: a.userId,
    publicKey: toBytes(input.publicKey),
    fingerprint: input.fingerprint,
    encryptedPrivateKey: toBytes(input.encryptedPrivateKey),
    kdf: input.kdf,
    passwordVerifierHash: sha256(toBytes(input.passwordVerifier)),
    recoveryWrappedKey: toBytes(input.recoveryWrappedKey),
    recoveryVerifierHash: sha256(toBytes(input.recoveryVerifier)),
  });
  const [existing] = await db
    .select({ id: vaultVaults.id })
    .from(vaultVaults)
    .where(
      and(
        eq(vaultVaults.orgId, a.org.id),
        eq(vaultVaults.ownerUserId, a.userId),
        eq(vaultVaults.kind, 'personal'),
      ),
    );
  if (!existing) await createPersonalVault(db, a, input.personalVault);
  await logEvent(db, a, { action: 'keys.setup' });
  await auditVault(db, a, 'vault.keys.setup', { type: 'user', id: a.userId });
  return keyStatus(db, a.userId);
}

export async function createPersonalVault(
  db: DbOrTx,
  a: VaultActor,
  input: { id: string; wrappedKey: string },
) {
  try {
    await db.insert(vaultVaults).values({
      id: input.id,
      orgId: a.org.id,
      kind: 'personal',
      ownerUserId: a.userId,
      createdBy: a.userId,
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError('conflict', { reason: 'personal_vault_exists' });
    throw err;
  }
  await db.insert(vaultMembers).values({
    vaultId: input.id,
    userId: a.userId,
    orgId: a.org.id,
    role: 'manage',
    wrappedKey: toBytes(input.wrappedKey),
    keyVersion: 1,
    grantedBy: a.userId,
  });
  await logEvent(db, a, { action: 'vault.create', vaultId: input.id, meta: { kind: 'personal' } });
}

export function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; i < 3 && e; i++) {
    if ((e as { code?: string }).code === '23505') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Counts a wrong verifier; at MAX_FAILED_UNLOCKS the account waits UNLOCK_WAIT_MS.
 * Runs outside the caller's transaction so a later rollback cannot erase the count.
 */
async function recordFailure(db: DbOrTx, a: VaultActor, method: string): Promise<never> {
  const [row] = await db
    .update(userKeys)
    .set({
      failedAttempts: sql`case when ${userKeys.failedAttempts} + 1 >= ${MAX_FAILED_UNLOCKS} then 0 else ${userKeys.failedAttempts} + 1 end`,
      lockedUntil: sql`case when ${userKeys.failedAttempts} + 1 >= ${MAX_FAILED_UNLOCKS} then now() + make_interval(secs => ${UNLOCK_WAIT_MS / 1000}) else ${userKeys.lockedUntil} end`,
    })
    .where(eq(userKeys.userId, a.userId))
    .returning({ failed: userKeys.failedAttempts, lockedUntil: userKeys.lockedUntil });
  const lockedNow = !!row?.lockedUntil && row.lockedUntil.getTime() > Date.now();
  await logEvent(db, a, {
    action: 'unlock_failed',
    field: method,
    meta: { attempts: lockedNow ? MAX_FAILED_UNLOCKS : (row?.failed ?? 0) },
  });
  if (lockedNow) {
    throw new AppError('vault_unlock_locked', { retryAfter: Math.ceil(UNLOCK_WAIT_MS / 1000) });
  }
  throw new AppError('vault_unlock_failed', {
    remaining: MAX_FAILED_UNLOCKS - (row?.failed ?? 0),
  });
}

function assertNotLocked(row: KeysRow) {
  if (row.lockedUntil && row.lockedUntil.getTime() > Date.now()) {
    throw new AppError('vault_unlock_locked', {
      retryAfter: Math.ceil((row.lockedUntil.getTime() - Date.now()) / 1000),
    });
  }
}

async function clearFailures(db: DbOrTx, row: KeysRow) {
  if (row.failedAttempts || row.lockedUntil) {
    await db
      .update(userKeys)
      .set({ failedAttempts: 0, lockedUntil: null })
      .where(eq(userKeys.userId, row.userId));
  }
}

/** Releases the wrapped private key for a correct verifier (design 8.3). */
export async function unlock(
  db: DbOrTx,
  a: VaultActor,
  input: VaultUnlockRequest,
): Promise<VaultUnlockBundle> {
  const row = await requireKeys(db, a.userId);
  assertNotLocked(row);
  let wrapped: Buffer;
  let ok: boolean;
  let unlockRow: UnlockRow | undefined;
  if (input.method === 'password') {
    ok = verifierMatches(input.verifier, row.passwordVerifierHash);
    wrapped = row.encryptedPrivateKey;
  } else if (input.method === 'recovery') {
    ok = verifierMatches(input.verifier, row.recoveryVerifierHash);
    wrapped = row.recoveryWrappedKey;
  } else {
    if (!input.unlockId) throw new AppError('validation_failed', { field: 'unlockId' });
    [unlockRow] = await db
      .select()
      .from(userKeyUnlocks)
      .where(
        and(
          eq(userKeyUnlocks.id, input.unlockId),
          eq(userKeyUnlocks.userId, a.userId),
          eq(userKeyUnlocks.method, input.method),
        ),
      );
    if (!unlockRow) throw new AppError('not_found');
    ok = verifierMatches(input.verifier, unlockRow.verifierHash);
    wrapped = unlockRow.wrappedPrivateKey;
  }
  if (!ok) return recordFailure(db, a, input.method);
  await clearFailures(db, row);
  if (unlockRow) {
    await db
      .update(userKeyUnlocks)
      .set({ lastUsedAt: new Date() })
      .where(eq(userKeyUnlocks.id, unlockRow.id));
  }
  await logEvent(db, a, { action: 'unlock', field: input.method });
  return {
    method: input.method,
    publicKey: toB64(row.publicKey),
    wrappedPrivateKey: toB64(wrapped),
    keyVersion: row.keyVersion,
    settings: row.settings ? toB64(row.settings) : null,
  };
}

/** Sudo check for key changes: the current password (or recovery key) verifier. */
async function requireProof(db: DbOrTx, a: VaultActor, proof: z.infer<typeof VaultProof>) {
  const row = await requireKeys(db, a.userId);
  assertNotLocked(row);
  const hash = proof.method === 'password' ? row.passwordVerifierHash : row.recoveryVerifierHash;
  if (!verifierMatches(proof.verifier, hash)) return recordFailure(db, a, proof.method);
  await clearFailures(db, row);
  return row;
}

/** New vault password; after a recovery the proof is the recovery verifier (doc 17 §7). */
export async function changePassword(
  db: DbOrTx,
  a: VaultActor,
  input: z.infer<typeof VaultChangePassword>,
) {
  await requireProof(db, a, input.proof);
  await db
    .update(userKeys)
    .set({
      kdf: input.kdf,
      encryptedPrivateKey: toBytes(input.encryptedPrivateKey),
      passwordVerifierHash: sha256(toBytes(input.passwordVerifier)),
      passwordChangedAt: new Date(),
    })
    .where(eq(userKeys.userId, a.userId));
  await logEvent(db, a, { action: 'keys.password', field: input.proof.method });
  await auditVault(
    db,
    a,
    'vault.keys.password',
    { type: 'user', id: a.userId },
    {
      via: input.proof.method,
    },
  );
  return keyStatus(db, a.userId);
}

/** New recovery key; the previous wrap and verifier are overwritten (design 8.16). */
export async function rotateRecovery(
  db: DbOrTx,
  a: VaultActor,
  input: z.infer<typeof VaultRotateRecovery>,
) {
  await requireProof(db, a, input.proof);
  await db
    .update(userKeys)
    .set({
      recoveryWrappedKey: toBytes(input.recoveryWrappedKey),
      recoveryVerifierHash: sha256(toBytes(input.recoveryVerifier)),
      recoveryCreatedAt: new Date(),
    })
    .where(eq(userKeys.userId, a.userId));
  await logEvent(db, a, { action: 'keys.recovery' });
  await auditVault(db, a, 'vault.keys.recovery', { type: 'user', id: a.userId });
  return keyStatus(db, a.userId);
}

export async function addUnlockMethod(
  db: DbOrTx,
  a: VaultActor,
  input: z.infer<typeof VaultAddUnlockMethod>,
) {
  await requireProof(db, a, input.proof);
  if (input.method === 'passkey_prf' && (!input.credentialId || !input.prfSalt)) {
    throw new AppError('validation_failed', { field: 'credentialId' });
  }
  const [row] = await db
    .insert(userKeyUnlocks)
    .values({
      userId: a.userId,
      method: input.method,
      label: input.label,
      credentialId: input.credentialId ?? null,
      prfSalt: input.prfSalt ? toBytes(input.prfSalt) : null,
      wrappedPrivateKey: toBytes(input.wrappedPrivateKey),
      verifierHash: sha256(toBytes(input.verifier)),
    })
    .returning();
  await logEvent(db, a, {
    action: 'keys.unlock_method',
    field: input.method,
    meta: { added: true },
  });
  return toMethod(row!);
}

export async function removeUnlockMethod(db: DbOrTx, a: VaultActor, unlockId: string) {
  const deleted = await db
    .delete(userKeyUnlocks)
    .where(and(eq(userKeyUnlocks.id, unlockId), eq(userKeyUnlocks.userId, a.userId)))
    .returning({ method: userKeyUnlocks.method });
  if (!deleted.length) throw new AppError('not_found');
  await logEvent(db, a, {
    action: 'keys.unlock_method',
    field: deleted[0]!.method,
    meta: { removed: true },
  });
}

export async function getSettings(db: DbOrTx, a: VaultActor) {
  const row = await requireKeys(db, a.userId);
  return { settings: row.settings ? toB64(row.settings) : null };
}

export async function updateSettings(db: DbOrTx, a: VaultActor, settings: string) {
  await requireKeys(db, a.userId);
  await db
    .update(userKeys)
    .set({ settings: toBytes(settings) })
    .where(eq(userKeys.userId, a.userId));
}

/** A colleague's public key (same org, able to hold vault keys). */
export async function publicKeyOf(
  db: DbOrTx,
  a: VaultActor,
  userId: string,
): Promise<VaultPublicKey> {
  if (!(await vaultCapableMember(db, a.org.id, userId))) throw new AppError('not_found');
  const row = await keysOf(db, userId);
  if (!row) throw new AppError('vault_member_without_keys');
  return {
    userId,
    publicKey: toB64(row.publicKey),
    fingerprint: row.fingerprint,
    keyVersion: row.keyVersion,
  };
}
