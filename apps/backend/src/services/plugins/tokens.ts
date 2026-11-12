import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  decodeProtectedHeader,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  importJWK,
  importPKCS8,
  jwtVerify,
  SignJWT,
  type CryptoKey,
} from 'jose';
import { pluginSigningKeys, type DbOrTx } from '@crewhall/db';
import { SESSION_TOKEN_TYPE } from '@crewhall/plugin-sdk/server';
import type { Env } from '../../env';
import { open, seal } from './crypto';

/**
 * Plugin session tokens (docs/contracts/eklentiler.md › Kimlik): EdDSA JWTs, 5 minutes,
 * `aud` = plugin id, `sub` = the person. Plugin servers verify them with our JWKS; the REST API
 * accepts them like personal tokens, limited to the installation's permissions.
 */

export const SESSION_TOKEN_SECONDS = 300;
const PURPOSE = 'plugin-session-key';

interface OrgKey {
  kid: string;
  publicJwk: Record<string, string>;
  privateKey: CryptoKey;
}

const cache = new Map<string, OrgKey>();

async function orgKey(db: DbOrTx, env: Env, orgId: string): Promise<OrgKey> {
  const hit = cache.get(orgId);
  if (hit) return hit;
  let [row] = await db.select().from(pluginSigningKeys).where(eq(pluginSigningKeys.orgId, orgId));
  if (!row) {
    const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const kid = randomUUID();
    const jwk = (await exportJWK(pair.publicKey)) as Record<string, string>;
    await db
      .insert(pluginSigningKeys)
      .values({
        orgId,
        kid,
        publicJwk: { ...jwk, kid, alg: 'EdDSA', use: 'sig' },
        privateKeyEnc: seal(env.AUTH_SECRET, PURPOSE, await exportPKCS8(pair.privateKey)),
      })
      .onConflictDoNothing();
    [row] = await db.select().from(pluginSigningKeys).where(eq(pluginSigningKeys.orgId, orgId));
  }
  const key: OrgKey = {
    kid: row!.kid,
    publicJwk: row!.publicJwk,
    privateKey: await importPKCS8(open(env.AUTH_SECRET, PURPOSE, row!.privateKeyEnc), 'EdDSA'),
  };
  cache.set(orgId, key);
  return key;
}

/** The issuer plugins check: the installation's API origin (same as the install request's apiUrl). */
export const issuerOf = (env: Env) => new URL(env.API_URL).origin;

export async function issueSessionToken(
  db: DbOrTx,
  env: Env,
  input: {
    orgId: string;
    installationId: string;
    pluginId: string;
    user: { id: string; name: string; email: string };
    scopes: string[];
  },
) {
  const key = await orgKey(db, env, input.orgId);
  const exp = Math.floor(Date.now() / 1000) + SESSION_TOKEN_SECONDS;
  const token = await new SignJWT({
    org: input.orgId,
    inst: input.installationId,
    name: input.user.name,
    email: input.user.email,
    scope: input.scopes.join(' '),
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: key.kid, typ: SESSION_TOKEN_TYPE })
    .setIssuer(issuerOf(env))
    .setAudience(input.pluginId)
    .setSubject(input.user.id)
    .setIssuedAt()
    .setExpirationTime(exp)
    .setJti(randomUUID())
    .sign(key.privateKey);
  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

/** Every org's public key (one installation usually has one org). */
export async function jwks(db: DbOrTx) {
  const rows = await db.select({ publicJwk: pluginSigningKeys.publicJwk }).from(pluginSigningKeys);
  return { keys: rows.map((r) => r.publicJwk) };
}

/** A JWT that looks like ours (three segments, our token type); anything else is not ours. */
export function looksLikeSessionToken(bearer: string): boolean {
  if (bearer.split('.').length !== 3) return false;
  try {
    return decodeProtectedHeader(bearer).typ === SESSION_TOKEN_TYPE;
  } catch {
    return false;
  }
}

export async function verifySessionToken(db: DbOrTx, env: Env, token: string) {
  const header = decodeProtectedHeader(token);
  const [row] = await db
    .select()
    .from(pluginSigningKeys)
    .where(eq(pluginSigningKeys.kid, String(header.kid ?? '')));
  if (!row) return null;
  try {
    const { payload } = await jwtVerify(token, await importJWK(row.publicJwk, 'EdDSA'), {
      issuer: issuerOf(env),
      typ: SESSION_TOKEN_TYPE,
      algorithms: ['EdDSA'],
    });
    if (payload.org !== row.orgId) return null;
    return payload as {
      sub: string;
      aud: string;
      org: string;
      inst: string;
      scope: string;
      exp: number;
      jti: string;
    };
  } catch {
    return null;
  }
}
