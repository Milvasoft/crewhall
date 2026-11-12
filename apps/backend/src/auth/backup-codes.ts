import { randomInt } from 'node:crypto';

/** Upper case and digits without look-alikes (0/O, 1/I/L), so codes read back reliably. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * Backup codes per design 01 · 1.4: 8 characters, stored normalised (no dash, upper case)
 * so `normalizeBackupCode(input)` matches them; clients show them as XXXX-XXXX.
 */
export function generateBackupCodes(amount = 10): string[] {
  return Array.from({ length: amount }, () =>
    Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(''),
  );
}
