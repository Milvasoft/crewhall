import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Public link tokens are kept twice (H16): their sha256 to find the link from `/s/<token>`, and
 * encrypted (AES-256-GCM, key derived from AUTH_SECRET with HKDF) so the share dialog can show
 * and copy the address again later. Changing AUTH_SECRET makes stored tokens unreadable; the
 * links keep working, their addresses just can't be shown until regenerated.
 */

const keys = new Map<string, Buffer>();

function keyFor(secret: string) {
  let key = keys.get(secret);
  if (!key) {
    key = Buffer.from(hkdfSync('sha256', secret, 'crewhall', 'share-link-token', 32));
    keys.set(secret, key);
  }
  return key;
}

/** base64url(iv ‖ tag ‖ ciphertext) */
export function encryptShareToken(secret: string, token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(secret), iv);
  const ct = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url');
}

/** The token, or null when the value can't be decrypted (another AUTH_SECRET, tampering). */
export function decryptShareToken(secret: string, stored: string): string | null {
  try {
    const raw = Buffer.from(stored, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', keyFor(secret), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
