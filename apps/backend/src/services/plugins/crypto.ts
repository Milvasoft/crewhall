import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM with a key derived from AUTH_SECRET (HKDF, one `purpose` per kind of secret):
 * installation secrets and the session-token key never sit in the database in the clear.
 */

const keys = new Map<string, Buffer>();

function keyFor(secret: string, purpose: string) {
  const k = `${purpose}\u0000${secret}`;
  let key = keys.get(k);
  if (!key) {
    key = Buffer.from(hkdfSync('sha256', secret, 'crewhall', purpose, 32));
    keys.set(k, key);
  }
  return key;
}

export function seal(secret: string, purpose: string, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(secret, purpose), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

export function open(secret: string, purpose: string, stored: string): string {
  const raw = Buffer.from(stored, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', keyFor(secret, purpose), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

export const newSecret = () => randomBytes(32).toString('base64url');
