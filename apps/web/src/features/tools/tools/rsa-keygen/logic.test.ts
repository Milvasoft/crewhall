// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/rsa-keygen/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { generateRsaKeyPair } from './logic';

describe('rsa-keygen', () => {
  it('generates a PEM key pair', async () => {
    const { publicKey, privateKey } = await generateRsaKeyPair(2048);
    expect(publicKey.startsWith('-----BEGIN PUBLIC KEY-----')).toBe(true);
    expect(publicKey.trimEnd().endsWith('-----END PUBLIC KEY-----')).toBe(true);
    expect(privateKey.startsWith('-----BEGIN PRIVATE KEY-----')).toBe(true);
    // Lines are wrapped at 64 chars.
    const body = publicKey.split('\n').slice(1, -1);
    expect(body.every((l) => l.length <= 64)).toBe(true);
  });

  it('produces distinct pairs', async () => {
    const a = await generateRsaKeyPair(2048);
    const b = await generateRsaKeyPair(2048);
    expect(a.privateKey).not.toBe(b.privateKey);
  });

  it('defaults to a 2048-bit key when no modulus length is given', async () => {
    const { publicKey } = await generateRsaKeyPair();
    const der = pemToArrayBuffer(publicKey);
    const key = await crypto.subtle.importKey(
      'spki',
      der,
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      true,
      ['encrypt'],
    );
    const algo = key.algorithm as RsaHashedKeyAlgorithm;
    expect(algo.modulusLength).toBe(2048);
  });

  it('produces PEM whose body is valid base64-encoded DER, re-importable by Web Crypto', async () => {
    const { publicKey, privateKey } = await generateRsaKeyPair(2048);

    const pubDer = pemToArrayBuffer(publicKey);
    const importedPub = await crypto.subtle.importKey(
      'spki',
      pubDer,
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      true,
      ['encrypt'],
    );
    expect(importedPub.type).toBe('public');

    const privDer = pemToArrayBuffer(privateKey);
    const importedPriv = await crypto.subtle.importKey(
      'pkcs8',
      privDer,
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      true,
      ['decrypt'],
    );
    expect(importedPriv.type).toBe('private');
  });
});

/** Strip PEM armor and decode the base64 body back to raw DER bytes. */
function pemToArrayBuffer(pem: string): ArrayBuffer {
  const base64 = pem
    .split('\n')
    .filter((line) => !line.startsWith('-----'))
    .join('');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
