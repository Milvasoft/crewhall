import { createPrivateKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { and, desc, eq, gt, isNull, lt, or } from 'drizzle-orm';
import { oidcSigningKeys, type DbOrTx } from '@crewhall/db';
import { exportJWK, importJWK, type JWK } from 'jose';
import type { Env } from '../../env';
import { decryptSecret, encryptSecret } from './crypto';

/**
 * RS256 signing keys of the OIDC provider (design 9.12 "İmza anahtarı RS256 · x gün önce
 * döndü"). The newest active key signs; a rotated key stays in JWKS for KEEP_MS so tokens
 * it signed can still be verified.
 */

const KEEP_MS = 2 * 24 * 60 * 60 * 1000;

type KeyRow = typeof oidcSigningKeys.$inferSelect;

async function createKey(db: DbOrTx, env: Env, orgId: string) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = randomBytes(12).toString('base64url');
  const jwk = await exportJWK(publicKey);
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const [row] = await db
    .insert(oidcSigningKeys)
    .values({
      orgId,
      kid,
      alg: 'RS256',
      publicJwk: { ...jwk, kid, alg: 'RS256', use: 'sig' },
      privateKeyEnc: encryptSecret(env.AUTH_SECRET, pem),
    })
    .returning();
  return row!;
}

export async function activeKey(db: DbOrTx, orgId: string) {
  const [row] = await db
    .select()
    .from(oidcSigningKeys)
    .where(and(eq(oidcSigningKeys.orgId, orgId), isNull(oidcSigningKeys.retiredAt)))
    .orderBy(desc(oidcSigningKeys.createdAt))
    .limit(1);
  return row ?? null;
}

export async function ensureKey(db: DbOrTx, env: Env, orgId: string): Promise<KeyRow> {
  return (await activeKey(db, orgId)) ?? createKey(db, env, orgId);
}

export async function rotateKey(db: DbOrTx, env: Env, orgId: string) {
  const now = new Date();
  await db
    .update(oidcSigningKeys)
    .set({ retiredAt: now, removeAt: new Date(now.getTime() + KEEP_MS) })
    .where(and(eq(oidcSigningKeys.orgId, orgId), isNull(oidcSigningKeys.retiredAt)));
  await db.delete(oidcSigningKeys).where(lt(oidcSigningKeys.removeAt, now));
  return createKey(db, env, orgId);
}

export function privateKeyOf(env: Env, row: KeyRow) {
  return createPrivateKey(decryptSecret(env.AUTH_SECRET, row.privateKeyEnc));
}

/** Public keys of every org on this issuer, including recently rotated ones. */
export async function jwks(db: DbOrTx) {
  const rows = await db
    .select()
    .from(oidcSigningKeys)
    .where(or(isNull(oidcSigningKeys.retiredAt), gt(oidcSigningKeys.removeAt, new Date())))
    .orderBy(desc(oidcSigningKeys.createdAt));
  return { keys: rows.map((r) => r.publicJwk as JWK) };
}

/** Key by kid, for verifying our own access tokens and id_token_hint. */
export async function publicKeyFor(db: DbOrTx, kid: string) {
  const [row] = await db.select().from(oidcSigningKeys).where(eq(oidcSigningKeys.kid, kid));
  if (!row) return null;
  if (row.retiredAt && row.removeAt && row.removeAt < new Date()) return null;
  return importJWK(row.publicJwk as JWK, 'RS256');
}
