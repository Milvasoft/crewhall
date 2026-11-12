import { z } from 'zod';
import { LocalizedText, PluginManifest } from './manifest';

/**
 * A signed plugin package (docs/contracts/eklentiler.md › İmza): the manifest plus the
 * marketplace's review, signed with the marketplace's Ed25519 key over their canonical JSON.
 * Crewhall installations verify it on install and on every update. Web Crypto only, so the same
 * code runs in Node (Crewhall, the marketplace, plugin servers) and in browsers.
 */

export const RiskLevel = z.enum(['official', 'verified', 'unofficial']);
export type RiskLevel = z.infer<typeof RiskLevel>;

export const PluginReview = z.object({
  /**
   * `official`: by the Crewhall team; `verified`: reviewed third party; `unofficial`: works
   * against a service that does not allow it (e.g. WhatsApp): shown with `riskNote`.
   */
  risk: RiskLevel,
  riskNote: LocalizedText.nullable().default(null),
  reviewedAt: z.string().max(40),
  /** null: every installation; otherwise only these installation domains (in-house plugins). */
  audience: z.array(z.string().max(255)).max(100).nullable().default(null),
});
export type PluginReview = z.infer<typeof PluginReview>;

export const PackageSignature = z.object({
  alg: z.literal('ed25519'),
  keyId: z.string().min(1).max(64),
  /** base64 */
  value: z.string().min(1).max(200),
});

export const PluginPackage = z.object({
  manifest: PluginManifest,
  review: PluginReview,
  signature: PackageSignature,
});
export type PluginPackage = z.infer<typeof PluginPackage>;

/** A public key of the marketplace: SPKI DER, base64. */
export interface MarketplaceKey {
  keyId: string;
  publicKey: string;
}

// ---- canonical JSON (RFC 8785 style: sorted keys, no whitespace) ----

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('not finite');
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

// ---- base64 without Buffer ----

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const utf8 = (s: string) => new TextEncoder().encode(s);

/** The bytes the signature covers. */
export function signedPayload(manifest: unknown, review: unknown): Uint8Array<ArrayBuffer> {
  return utf8(canonicalJson({ manifest, review }));
}

// ---- keys and signatures ----

export async function generateSigningKey(): Promise<{ privateKey: string; publicKey: string }> {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  if (!('privateKey' in pair)) throw new Error('Ed25519 key generation failed');
  const priv = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const pub = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  return { privateKey: toBase64(priv), publicKey: toBase64(pub) };
}

/** The SPKI public key of a PKCS#8 private key (both base64). */
export async function publicKeyOf(privateKey: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    fromBase64(privateKey),
    { name: 'Ed25519' },
    true,
    ['sign'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', key);
  const pub = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x },
    { name: 'Ed25519' },
    true,
    ['verify'],
  );
  return toBase64(new Uint8Array(await crypto.subtle.exportKey('spki', pub)));
}

/** Marketplace side: sign a reviewed manifest. */
export async function signPackage(
  manifest: PluginManifest,
  review: PluginReview,
  key: { keyId: string; privateKey: string },
): Promise<PluginPackage> {
  const k = await crypto.subtle.importKey(
    'pkcs8',
    fromBase64(key.privateKey),
    { name: 'Ed25519' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: 'Ed25519' }, k, signedPayload(manifest, review)),
  );
  return {
    manifest,
    review,
    signature: { alg: 'ed25519', keyId: key.keyId, value: toBase64(sig) },
  };
}

export class PackageError extends Error {
  constructor(
    readonly reason: 'shape' | 'unknown_key' | 'signature',
    message?: string,
  ) {
    super(message ?? reason);
    this.name = 'PackageError';
  }
}

/**
 * Installation side: parse and verify a package against the trusted marketplace keys.
 * The manifest is re-validated after the signature (the signed bytes are the input as sent).
 */
export async function verifyPackage(
  input: unknown,
  keys: MarketplaceKey[],
): Promise<PluginPackage> {
  const raw = z
    .object({ manifest: z.unknown(), review: z.unknown(), signature: PackageSignature })
    .safeParse(input);
  if (!raw.success) throw new PackageError('shape', raw.error.message);
  const key = keys.find((k) => k.keyId === raw.data.signature.keyId);
  if (!key) throw new PackageError('unknown_key', raw.data.signature.keyId);
  const pub = await crypto.subtle.importKey(
    'spki',
    fromBase64(key.publicKey),
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
  const ok = await crypto.subtle.verify(
    { name: 'Ed25519' },
    pub,
    fromBase64(raw.data.signature.value),
    signedPayload(raw.data.manifest, raw.data.review),
  );
  if (!ok) throw new PackageError('signature');
  const parsed = PluginPackage.safeParse(input);
  if (!parsed.success) throw new PackageError('shape', parsed.error.message);
  return parsed.data;
}

/**
 * Why a self-hosted copy's manifest is not the signed one, or null when it is: it must be a
 * valid manifest on exactly `origin`, and equal to the signed manifest in everything else
 * (id, version, permissions, entry points, every field: the same digest once the origin is
 * put back).
 */
export function selfHostedMismatch(
  signed: PluginManifest,
  served: unknown,
  origin: string,
): 'shape' | 'origin' | 'id' | 'version' | 'permissions' | 'manifest' | null {
  const parsed = PluginManifest.safeParse(served);
  if (!parsed.success) return 'shape';
  const m = parsed.data;
  if (m.origin !== origin) return 'origin';
  if (m.id !== signed.id) return 'id';
  if (m.version !== signed.version) return 'version';
  if (canonicalJson(m.permissions) !== canonicalJson(signed.permissions)) return 'permissions';
  const normalized = canonicalJson(PluginManifest.parse(signed));
  return canonicalJson({ ...m, origin: signed.origin }) === normalized ? null : 'manifest';
}

/** SHA-256 of the canonical manifest, hex: the version's fingerprint in catalogs and audits. */
export async function manifestDigest(manifest: unknown): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(canonicalJson(manifest))));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}
