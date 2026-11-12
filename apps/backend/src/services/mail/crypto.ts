import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const keyCache = new Map<string, Buffer>();

function key(secret: string) {
  let k = keyCache.get(secret);
  if (!k) {
    k = Buffer.from(hkdfSync('sha256', secret, 'crewhall', 'mail-secrets-v1', 32));
    keyCache.set(secret, k);
  }
  return k;
}

/**
 * Mailbox passwords, OAuth tokens and the OAuth client secret: AES-256-GCM with a key derived
 * from AUTH_SECRET (its own HKDF label, so a leak of another module's key does not open these).
 * Format `v1.<iv>.<tag>.<ciphertext>`, base64url.
 */
export function sealSecret(authSecret: string, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(authSecret), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    body.toString('base64url'),
  ].join('.');
}

/** Null for a value that does not decrypt (wrong AUTH_SECRET, damaged row). */
export function openSecret(authSecret: string, value: string | null): string | null {
  if (!value) return null;
  const [v, iv, tag, body] = value.split('.');
  if (v !== 'v1' || !iv || !tag || body === undefined) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key(authSecret), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(body, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}
