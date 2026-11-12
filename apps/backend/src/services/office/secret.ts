import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const keyCache = new Map<string, Buffer>();

function key(secret: string) {
  let k = keyCache.get(secret);
  if (!k) {
    k = Buffer.from(hkdfSync('sha256', secret, 'crewhall', 'office-secrets-v1', 32));
    keyCache.set(secret, k);
  }
  return k;
}

/**
 * The document server's JWT secret at rest: AES-256-GCM with a key derived from AUTH_SECRET
 * (its own HKDF label), bound to the org. Format `v1.<iv>.<tag>.<ciphertext>`, base64url.
 */
export function sealOfficeSecret(authSecret: string, orgId: string, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(authSecret), iv);
  cipher.setAAD(Buffer.from(orgId));
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), body]
    .map((x) => (typeof x === 'string' ? x : x.toString('base64url')))
    .join('.');
}

/** Null for a value that does not open (another AUTH_SECRET or org, damaged row). */
export function openOfficeSecret(authSecret: string, orgId: string, value: string | null) {
  if (!value) return null;
  const [v, iv, tag, body] = value.split('.');
  if (v !== 'v1' || !iv || !tag || body === undefined) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key(authSecret), Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(orgId));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(body, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}
