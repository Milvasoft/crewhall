// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/bcrypt-tool/logic.ts. See THIRD_PARTY.md.
import bcrypt from 'bcryptjs';

/**
 * bcrypt hashing and verification via bcryptjs (pure JS, runs in the browser).
 * The password never leaves the device.
 */

/** Hash a password with the given cost factor (rounds, 4–15 is sensible). */
export async function hashPassword(password: string, cost: number): Promise<string> {
  return bcrypt.hash(password, cost);
}

/** Check a password against an existing bcrypt hash. */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
}

/** Read the cost factor encoded in a bcrypt hash, or null if it isn't one. */
export function detectCost(hash: string): number | null {
  const m = /^\$2[abxy]?\$(\d{2})\$/.exec(hash.trim());
  return m ? Number(m[1]) : null;
}
