import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

export {
  newSecret,
  pkceMatches,
  randomBase62,
  safeEqual,
  sha256,
  signValue,
  verifySigned,
} from '../mcp/crypto';

/** Prefixes of the OIDC provider's opaque values (readable in logs, like the MCP ones). */
export const OIDC_PREFIX = {
  secret: 'mhs_',
  code: 'mhoc_',
  refresh: 'mhor_',
} as const;

const keyCache = new Map<string, Buffer>();

function key(secret: string) {
  let k = keyCache.get(secret);
  if (!k) {
    k = Buffer.from(hkdfSync('sha256', secret, 'crewhall', 'identity-secrets-v1', 32));
    keyCache.set(secret, k);
  }
  return k;
}

/**
 * Secrets Crewhall must use later (IdP client secret, LDAP bind password, signing keys):
 * AES-256-GCM with a key derived from AUTH_SECRET. Format `v1.<iv>.<tag>.<ciphertext>`.
 */
export function encryptSecret(authSecret: string, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(authSecret), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    'v1',
    iv.toString('base64url'),
    tag.toString('base64url'),
    body.toString('base64url'),
  ].join('.');
}

export function decryptSecret(authSecret: string, value: string): string {
  const [v, iv, tag, body] = value.split('.');
  if (v !== 'v1' || !iv || !tag || body === undefined) throw new Error('bad secret format');
  const decipher = createDecipheriv('aes-256-gcm', key(authSecret), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(body, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
