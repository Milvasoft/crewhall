import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { z } from 'zod';

/**
 * The install's .env travels in a backup only encrypted: AES-256-GCM under a key derived
 * from CREWHALL_BACKUP_PASSPHRASE with scrypt. Without the passphrase the file is useless,
 * and a lost passphrase means the configuration must be written again by hand.
 */
const Sealed = z.object({
  v: z.literal(1),
  kdf: z.literal('scrypt'),
  N: z.number().int(),
  r: z.number().int(),
  p: z.number().int(),
  salt: z.string(),
  iv: z.string(),
  tag: z.string(),
  data: z.string(),
});

const PARAMS = { N: 1 << 15, r: 8, p: 1 };
const MIN_PASSPHRASE = 12;

function keyFor(passphrase: string, salt: Buffer, p: { N: number; r: number; p: number }) {
  return scryptSync(passphrase, salt, 32, { ...p, maxmem: 128 * p.N * p.r * 2 });
}

export function seal(plain: Buffer, passphrase: string): string {
  if (passphrase.length < MIN_PASSPHRASE) {
    throw new Error(`CREWHALL_BACKUP_PASSPHRASE must be at least ${MIN_PASSPHRASE} characters`);
  }
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(passphrase, salt, PARAMS), iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return JSON.stringify({
    v: 1,
    kdf: 'scrypt',
    ...PARAMS,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  });
}

export function unseal(sealed: string, passphrase: string): Buffer {
  const s = Sealed.parse(JSON.parse(sealed));
  const decipher = createDecipheriv(
    'aes-256-gcm',
    keyFor(passphrase, Buffer.from(s.salt, 'base64'), s),
    Buffer.from(s.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(s.tag, 'base64'));
  try {
    return Buffer.concat([decipher.update(Buffer.from(s.data, 'base64')), decipher.final()]);
  } catch {
    throw new Error('wrong passphrase or damaged config.enc');
  }
}
