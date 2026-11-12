import { sha256 } from '@noble/hashes/sha2.js';
import { afterAll, describe, expect, it } from 'vitest';
import {
  configureArgon2id,
  decryptAttachment,
  decryptItem,
  decryptItemPlaintext,
  deriveMasterKey,
  encryptAttachment,
  encryptItemPlaintext,
  fingerprint,
  formatFingerprint,
  formatRecoveryKey,
  fromB64,
  fromBase32,
  fromHex,
  fromUtf8,
  generateEd25519SshKey,
  generateKeyPair,
  jsArgon2,
  openEnvelope,
  openSealed,
  parseRecoveryKey,
  sealEnvelope,
  sealTo,
  splitMasterKey,
  splitRecoveryKey,
  splitUnlockSecret,
  toB64,
  toHex,
  totpAt,
  utf8,
  verifierHash,
  wasmArgon2,
  type ItemType,
  type KdfParams,
  type UnlockMethod,
} from '../src/index';
import { det } from './det';
import vectors from './vectors.json';

/**
 * Cross-platform vectors (doc 17 §3 "Test"): mobile runs the same checks against the same
 * file. Every value must be reproduced exactly; a failure here means ciphertexts written by
 * one client would not open on the other.
 */

const hex = toHex;

afterAll(() => configureArgon2id(null));

describe('test vectors', () => {
  it('Argon2id + HKDF split (hash-wasm)', async () => {
    configureArgon2id(wasmArgon2);
    for (const v of vectors.argon2id) {
      const master = await deriveMasterKey(v.password, v.kdf as KdfParams);
      expect(hex(master)).toBe(v.masterKey);
      const pair = splitMasterKey(master);
      expect(hex(pair.kek)).toBe(v.kek);
      expect(hex(pair.verifier)).toBe(v.verifier);
      expect(hex(verifierHash(pair.verifier))).toBe(v.verifierHash);
    }
  });

  it('pure-JS Argon2id (the Hermes fallback) gives the same master key', async () => {
    const v = vectors.argon2id[1]!;
    configureArgon2id(jsArgon2);
    expect(hex(await deriveMasterKey(v.password, v.kdf as KdfParams))).toBe(v.masterKey);
    configureArgon2id(null);
  }, 120_000);

  it('recovery key formatting and derivation', () => {
    for (const v of vectors.recovery) {
      expect(formatRecoveryKey(fromHex(v.key))).toBe(v.formatted);
      expect(hex(parseRecoveryKey(v.formatted))).toBe(v.key);
      const pair = splitRecoveryKey(fromHex(v.key));
      expect(hex(pair.kek)).toBe(v.kek);
      expect(hex(pair.verifier)).toBe(v.verifier);
    }
  });

  it('unlock secret (passkey PRF / device) derivation', () => {
    for (const v of vectors.unlockSecrets) {
      const pair = splitUnlockSecret(fromHex(v.secret));
      expect(hex(pair.kek)).toBe(v.kek);
      expect(hex(pair.verifier)).toBe(v.verifier);
    }
  });

  it('X25519 public keys and fingerprints', () => {
    for (const v of vectors.x25519) {
      const pair = generateKeyPair(fromHex(v.privateKey));
      expect(hex(pair.publicKey)).toBe(v.publicKey);
      expect(fingerprint(pair.publicKey)).toBe(v.fingerprint);
      expect(formatFingerprint(v.fingerprint)).toBe(v.short);
    }
  });

  it('private key wraps', () => {
    for (const v of vectors.privateKeyWraps) {
      const wrapped = sealEnvelope(
        fromHex(v.kek),
        fromHex(v.privateKey),
        v.context,
        fromHex(v.nonce),
      );
      expect(toB64(wrapped)).toBe(v.wrapped);
      expect(hex(openEnvelope(fromHex(v.kek), fromB64(v.wrapped), v.context))).toBe(v.privateKey);
      expect(v.context).toBe(
        `crewhall/vault/v1/private-key|${v.userId}|${v.method as UnlockMethod}`,
      );
    }
  });

  it('vault key sealed boxes', () => {
    for (const v of vectors.vaultKeyWraps) {
      const sealed = sealTo(fromHex(v.recipientPublicKey), fromHex(v.vaultKey), v.context, {
        ephemeralPrivateKey: fromHex(v.ephemeralPrivateKey),
        nonce: fromHex(v.nonce),
      });
      expect(toB64(sealed)).toBe(v.wrapped);
      expect(hex(openSealed(fromHex(v.recipientPrivateKey), fromB64(v.wrapped), v.context))).toBe(
        v.vaultKey,
      );
    }
  });

  it('items: ciphertext, wrapped item key and decryption', () => {
    for (const v of vectors.items) {
      const ctx = {
        vaultId: v.vaultId,
        itemId: v.itemId,
        revision: v.revision,
        keyVersion: v.keyVersion,
        type: v.type as ItemType,
      };
      const enc = encryptItemPlaintext(fromHex(v.vaultKey), ctx, utf8(v.plaintext), {
        itemKey: fromHex(v.itemKey),
        nonce: fromHex(v.nonce),
        wrapNonce: fromHex(v.wrapNonce),
      });
      expect(enc).toEqual(v.encrypted);
      expect(enc.nonce).toBe(toB64(fromHex(v.nonce)));
      expect(fromUtf8(decryptItemPlaintext(fromHex(v.vaultKey), ctx, enc))).toBe(v.plaintext);
      expect(decryptItem(fromHex(v.vaultKey), ctx, enc)).toMatchObject(JSON.parse(v.plaintext));
    }
  });

  it('attachments', () => {
    for (const v of vectors.attachments) {
      const data = det(v.dataLabel, v.size);
      const enc = encryptAttachment(
        fromHex(v.fileKey),
        v.attachmentId,
        data,
        fromHex(v.noncePrefix),
      );
      expect(enc.length).toBe(v.encryptedSize);
      expect(hex(sha256(enc))).toBe(v.encryptedSha256);
      expect(hex(decryptAttachment(fromHex(v.fileKey), v.attachmentId, enc))).toBe(hex(data));
    }
  });

  it('TOTP matches RFC 6238 appendix B', () => {
    const rfc: Record<string, string[]> = {
      SHA1: ['94287082', '07081804', '14050471', '89005924', '69279037', '65353130'],
      SHA256: ['46119246', '68084774', '67062674', '91819424', '90698825', '77737706'],
      SHA512: ['90693936', '25091201', '99943326', '93441116', '38618901', '47863826'],
    };
    const seen: Record<string, string[]> = { SHA1: [], SHA256: [], SHA512: [] };
    for (const v of vectors.totp) {
      const cfg = {
        secret: fromBase32(v.secretBase32),
        algorithm: v.algorithm as 'SHA1',
        digits: v.digits,
        period: v.period,
      };
      const code = totpAt(cfg, v.time * 1000).code;
      expect(code).toBe(v.code);
      seen[v.algorithm]!.push(code);
    }
    expect(seen).toEqual(rfc);
  });

  it('SSH ed25519 key from a seed', () => {
    const k = generateEd25519SshKey(vectors.ssh.comment, fromHex(vectors.ssh.seed));
    expect(k.publicKey).toBe(vectors.ssh.publicKey);
    expect(k.fingerprint).toBe(vectors.ssh.fingerprint);
  });
});
