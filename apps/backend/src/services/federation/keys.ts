import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import { eq } from 'drizzle-orm';
import { federationKeys, type DbOrTx } from '@crewhall/db';
import { isDemoMode } from '../demo-flag';

/**
 * The installation's Ed25519 key (docs/contracts/federasyon.md › Kimlik). The private half is
 * stored AES-256-GCM encrypted with a key derived from AUTH_SECRET, so the database alone
 * cannot sign for the organization.
 */

function wrapKey(secret: string) {
  return Buffer.from(hkdfSync('sha256', secret, 'crewhall', 'federation-private-key', 32));
}

function seal(secret: string, plain: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', wrapKey(secret), iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

function open(secret: string, stored: string): Buffer {
  const raw = Buffer.from(stored, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', wrapKey(secret), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
}

export interface InstanceKey {
  /** SPKI DER, base64 (the discovery document's `publicKey`). */
  publicKey: string;
  privateKey: KeyObject;
}

const cache = new Map<string, InstanceKey>();

/** PKCS#8 DER header of an Ed25519 private key; the 32-byte seed follows. */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/**
 * The live demo's key: derived from AUTH_SECRET so it survives the hourly reset and peers
 * (the test server) keep trusting it (kararlar.md 2026-10-29). Never used outside DEMO_MODE.
 */
export function demoKeyPair(secret: string) {
  const seed = Buffer.from(hkdfSync('sha256', secret, 'crewhall', 'federation-demo-key', 32));
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

export async function instanceKey(
  db: DbOrTx,
  secret: string,
  orgId: string,
  create = true,
): Promise<InstanceKey | null> {
  const hit = cache.get(orgId);
  if (hit) return hit;
  let [row] = await db.select().from(federationKeys).where(eq(federationKeys.orgId, orgId));
  if (!row) {
    if (!create) return null;
    const pair = isDemoMode() ? demoKeyPair(secret) : generateKeyPairSync('ed25519');
    const publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const privateDer = pair.privateKey.export({ type: 'pkcs8', format: 'der' });
    await db
      .insert(federationKeys)
      .values({ orgId, publicKey, privateKeyEnc: seal(secret, privateDer) })
      .onConflictDoNothing();
    [row] = await db.select().from(federationKeys).where(eq(federationKeys.orgId, orgId));
  }
  const key: InstanceKey = {
    publicKey: row!.publicKey,
    privateKey: createPrivateKey({
      key: open(secret, row!.privateKeyEnc),
      format: 'der',
      type: 'pkcs8',
    }),
  };
  cache.set(orgId, key);
  return key;
}

export function publicKeyObject(spkiBase64: string): KeyObject {
  return createPublicKey({ key: Buffer.from(spkiBase64, 'base64'), format: 'der', type: 'spki' });
}

/** SHA-256 of the SPKI key, hex in groups of four: compared aloud between two admins. */
export function fingerprint(spkiBase64: string): string {
  const hex = createHash('sha256').update(Buffer.from(spkiBase64, 'base64')).digest('hex');
  return hex.slice(0, 32).toUpperCase().match(/.{4}/g)!.join(' ');
}
