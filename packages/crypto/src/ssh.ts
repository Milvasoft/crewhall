import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concat, CryptoError, fromB64, toB64, u32be, utf8 } from './bytes';
import { randomBytes } from './random';

/** SSH keys for the ssh_key item type (design 8.7: "Yapıştır ya da Ed25519 üret"). */

const sshString = (bytes: Uint8Array) => concat(u32be(bytes.length), bytes);

export interface GeneratedSshKey {
  privateKey: string;
  publicKey: string;
  fingerprint: string;
}

/** Unencrypted OpenSSH ed25519 key pair (the item itself is the encryption). */
export function generateEd25519SshKey(
  comment = '',
  seed: Uint8Array = randomBytes(32),
): GeneratedSshKey {
  if (seed.length !== 32) throw new CryptoError('invalid_input', 'ed25519 seed must be 32 bytes');
  const pk = ed25519.getPublicKey(seed);
  const keyType = utf8('ssh-ed25519');
  const pubBlob = concat(sshString(keyType), sshString(pk));
  const check = randomBytes(4);
  let priv = concat(
    check,
    check,
    sshString(keyType),
    sshString(pk),
    sshString(concat(seed, pk)),
    sshString(utf8(comment)),
  );
  const pad = (8 - (priv.length % 8)) % 8;
  priv = concat(
    priv,
    Uint8Array.from({ length: pad }, (_, i) => i + 1),
  );
  const body = concat(
    utf8('openssh-key-v1\0'),
    sshString(utf8('none')),
    sshString(utf8('none')),
    sshString(new Uint8Array(0)),
    u32be(1),
    sshString(pubBlob),
    sshString(priv),
  );
  const b64 = toB64(body);
  const lines = b64.match(/.{1,70}/g) ?? [];
  return {
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`,
    publicKey: `ssh-ed25519 ${toB64(pubBlob)}${comment ? ` ${comment}` : ''}`,
    fingerprint: fingerprintOfBlob(pubBlob),
  };
}

function fingerprintOfBlob(blob: Uint8Array) {
  return `SHA256:${toB64(sha256(blob)).replace(/=+$/, '')}`;
}

/** `SHA256:…` fingerprint of an OpenSSH public key line, or null when it does not parse. */
export function sshFingerprint(publicKeyLine: string): string | null {
  const parts = publicKeyLine.trim().split(/\s+/);
  if (parts.length < 2 || !/^(ssh-|ecdsa-|sk-)/.test(parts[0] ?? '')) return null;
  try {
    return fingerprintOfBlob(fromB64(parts[1] ?? ''));
  } catch {
    return null;
  }
}
