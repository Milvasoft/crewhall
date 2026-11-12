import { eq, sql } from 'drizzle-orm';
import { authLockouts, type DbOrTx } from '@crewhall/db';
import { AUTH_LOCK } from '@crewhall/shared';

export type LockoutRow = typeof authLockouts.$inferSelect;

/** Locks starting within this window after the previous one ended count as consecutive. */
const CONSECUTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

const normalize = (email: string) => email.trim().toLowerCase();

export async function getLockout(db: DbOrTx, email: string) {
  const [row] = await db
    .select()
    .from(authLockouts)
    .where(eq(authLockouts.email, normalize(email)));
  return row ?? null;
}

export function activeLockUntil(row: LockoutRow | null, now = new Date()): Date | null {
  return row?.lockedUntil && row.lockedUntil.getTime() > now.getTime() ? row.lockedUntil : null;
}

export interface FailureResult {
  row: LockoutRow;
  /** True when this failure started a lock. */
  locked: boolean;
  remainingAttempts: number;
}

/**
 * Counts one failed password, TOTP or backup code (shared counter, design 1.4/1.16).
 * The fifth failure locks for 15 minutes; a lock starting within 24 hours of the
 * previous one ending doubles, up to 60 minutes.
 */
export async function recordFailure(
  db: DbOrTx,
  email: string,
  ip: string | null,
  now = new Date(),
): Promise<FailureResult> {
  const key = normalize(email);
  const [counted] = await db
    .insert(authLockouts)
    .values({ email: key, failedCount: 1, lastFailedAt: now, lastFailedIp: ip })
    .onConflictDoUpdate({
      target: authLockouts.email,
      set: {
        failedCount: sql`${authLockouts.failedCount} + 1`,
        lastFailedAt: now,
        lastFailedIp: ip,
      },
    })
    .returning();
  if (!counted) throw new Error('lockout upsert returned nothing');

  if (counted.failedCount < AUTH_LOCK.maxFailures) {
    return {
      row: counted,
      locked: false,
      remainingAttempts: AUTH_LOCK.maxFailures - counted.failedCount,
    };
  }

  const previousEnd = counted.lockedUntil;
  const consecutive =
    previousEnd !== null && now.getTime() - previousEnd.getTime() <= CONSECUTIVE_WINDOW_MS;
  const level = consecutive ? Math.min(counted.lockLevel + 1, AUTH_LOCK.lockMinutes.length - 1) : 0;
  const minutes = AUTH_LOCK.lockMinutes[level] ?? AUTH_LOCK.lockMinutes[0];
  const [locked] = await db
    .update(authLockouts)
    .set({
      failedCount: 0,
      lockLevel: level,
      lockedUntil: new Date(now.getTime() + minutes * 60_000),
    })
    .where(eq(authLockouts.email, key))
    .returning();
  if (!locked) throw new Error('lockout update returned nothing');
  return { row: locked, locked: true, remainingAttempts: 0 };
}

/** A completed sign-in clears the failure count; the lock history stays for doubling. */
export async function recordSuccess(db: DbOrTx, email: string) {
  await db
    .update(authLockouts)
    .set({ failedCount: 0 })
    .where(eq(authLockouts.email, normalize(email)));
}

/** Password reset or an admin unlock lifts the lock and forgets the history. */
export async function clearLockout(db: DbOrTx, email: string) {
  await db
    .update(authLockouts)
    .set({ failedCount: 0, lockedUntil: null, lockLevel: 0 })
    .where(eq(authLockouts.email, normalize(email)));
}
