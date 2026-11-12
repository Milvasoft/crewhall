import { createHash, randomBytes, sign, verify, type KeyObject } from 'node:crypto';

/**
 * HTTP Message Signatures (RFC 9421), the subset federation needs: one `sig1` signature with
 * Ed25519 over the method, target URI, Content-Digest (RFC 9530) and Content-Type, plus
 * `created`, `keyid` (the sender's domain) and a `nonce`. mTLS was not chosen: proxies in
 * front of installations terminate TLS (kararlar.md › Federasyon).
 */

export const COVERED = ['@method', '@target-uri', 'content-digest', 'content-type'] as const;
/** Seconds a signature is accepted either side of now. */
export const MAX_SKEW_SECONDS = 300;

export function contentDigest(body: string): string {
  return `sha-256=:${createHash('sha256').update(body, 'utf8').digest('base64')}:`;
}

function signatureParams(created: number, keyId: string, nonce: string) {
  const list = COVERED.map((c) => `"${c}"`).join(' ');
  return `(${list});created=${created};keyid="${keyId}";nonce="${nonce}";alg="ed25519"`;
}

function signatureBase(values: Record<(typeof COVERED)[number], string>, params: string): string {
  return [...COVERED.map((c) => `"${c}": ${values[c]}`), `"@signature-params": ${params}`].join(
    '\n',
  );
}

export interface SignInput {
  method: string;
  url: string;
  body: string;
  keyId: string;
  privateKey: KeyObject;
  now?: number;
}

/** Headers for a signed JSON request. */
export function signRequest(input: SignInput): Record<string, string> {
  const created = Math.floor((input.now ?? Date.now()) / 1000);
  const nonce = randomBytes(16).toString('base64url');
  const digest = contentDigest(input.body);
  const contentType = 'application/json';
  const params = signatureParams(created, input.keyId, nonce);
  const base = signatureBase(
    {
      '@method': input.method.toUpperCase(),
      '@target-uri': input.url,
      'content-digest': digest,
      'content-type': contentType,
    },
    params,
  );
  const signature = sign(null, Buffer.from(base, 'utf8'), input.privateKey).toString('base64');
  return {
    'Content-Type': contentType,
    'Content-Digest': digest,
    'Signature-Input': `sig1=${params}`,
    Signature: `sig1=:${signature}:`,
  };
}

export interface ParsedSignature {
  keyId: string;
  created: number;
  nonce: string;
  params: string;
  signature: Buffer;
}

export class SignatureError extends Error {}

/** Reads `sig1` from Signature-Input / Signature; checks the covered components and the clock. */
export function parseSignature(
  headers: { signatureInput?: string | null; signature?: string | null },
  now = Date.now(),
): ParsedSignature {
  const input = /^sig1=(\(.*\)(?:;[a-z]+=(?:"[^"]*"|\d+))*)$/.exec(headers.signatureInput ?? '');
  const sig = /^sig1=:([A-Za-z0-9+/=]+):$/.exec(headers.signature ?? '');
  if (!input || !sig) throw new SignatureError('missing signature');
  const params = input[1]!;
  const list = /^\(([^)]*)\)/.exec(params)![1]!.trim();
  if (list !== COVERED.map((c) => `"${c}"`).join(' ')) {
    throw new SignatureError('covered components');
  }
  const field = (name: string) => new RegExp(`;${name}=(?:"([^"]*)"|(\\d+))`).exec(params);
  const created = Number(field('created')?.[2]);
  const keyId = field('keyid')?.[1];
  const nonce = field('nonce')?.[1];
  const alg = field('alg')?.[1];
  if (!keyId || !nonce || alg !== 'ed25519' || !Number.isFinite(created)) {
    throw new SignatureError('parameters');
  }
  if (Math.abs(now / 1000 - created) > MAX_SKEW_SECONDS) throw new SignatureError('clock');
  return { keyId, created, nonce, params, signature: Buffer.from(sig[1]!, 'base64') };
}

export interface VerifyInput {
  parsed: ParsedSignature;
  method: string;
  /** The URI the sender addressed: this installation's public inbox URL. */
  url: string;
  body: string;
  contentType: string | null;
  contentDigest: string | null;
  publicKey: KeyObject;
}

export function verifyRequest(input: VerifyInput): void {
  const digest = contentDigest(input.body);
  if (input.contentDigest !== digest) throw new SignatureError('digest');
  const base = signatureBase(
    {
      '@method': input.method.toUpperCase(),
      '@target-uri': input.url,
      'content-digest': digest,
      'content-type': input.contentType ?? '',
    },
    input.parsed.params,
  );
  if (!verify(null, Buffer.from(base, 'utf8'), input.publicKey, input.parsed.signature)) {
    throw new SignatureError('signature');
  }
}
