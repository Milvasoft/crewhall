import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * The org's model API key: AES-256-GCM with a key derived from AUTH_SECRET (HKDF), the org id as
 * associated data so a value copied to another org's row does not decrypt. Format
 * `v1.<iv>.<tag>.<ciphertext>` (base64url). The plain key lives only in memory while a request
 * runs and is never returned to a client.
 */

const keys = new Map<string, Buffer>();

function keyFor(secret: string) {
  let k = keys.get(secret);
  if (!k) {
    k = Buffer.from(hkdfSync('sha256', secret, 'crewhall', 'ai-provider-key-v1', 32));
    keys.set(secret, k);
  }
  return k;
}

export function encryptApiKey(secret: string, orgId: string, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(secret), iv);
  cipher.setAAD(Buffer.from(orgId, 'utf8'));
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    body.toString('base64url'),
  ].join('.');
}

/** The key, or null when it cannot be read (another AUTH_SECRET, another org, tampering). */
export function decryptApiKey(secret: string, orgId: string, value: string): string | null {
  const [v, iv, tag, body] = value.split('.');
  if (v !== 'v1' || !iv || !tag || body === undefined) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyFor(secret), Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(orgId, 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(body, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}

/** "abcd" of "sk-ant-…abcd"; keys shorter than 12 characters show nothing. */
export const keyHint = (plain: string) => (plain.length >= 12 ? plain.slice(-4) : null);
