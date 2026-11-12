/**
 * Writes test/vectors.json: fixed inputs and the outputs this implementation produces.
 * Web (vitest) and mobile both check they reproduce every value byte for byte
 * (doc 17 §14 Faz 5: "Web ve mobil aynı test vektörlerinden aynı sonucu üretiyor").
 *
 * Run: pnpm --filter @crewhall/crypto vectors. Only regenerate on purpose: a changed vector
 * means existing ciphertexts no longer open.
 */
import { writeFileSync } from 'node:fs';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  aad,
  configureArgon2id,
  deriveMasterKey,
  encryptAttachment,
  encryptItemPlaintext,
  fingerprint,
  formatFingerprint,
  formatRecoveryKey,
  generateEd25519SshKey,
  generateKeyPair,
  info,
  PROTOCOL,
  sealEnvelope,
  sealTo,
  splitMasterKey,
  splitRecoveryKey,
  splitUnlockSecret,
  toB64,
  toBase32,
  toHex,
  totpAt,
  utf8,
  verifierHash,
  wasmArgon2,
  type KdfParams,
} from '../src/index';
import { det } from '../test/det';

const hex = toHex;

async function main() {
  configureArgon2id(wasmArgon2);

  const argon2id = [];
  for (const [password, m, t, p] of [
    ['correct horse battery staple', 65536, 3, 4],
    ['Çok-güçlü şifre İı 🔐', 32768, 2, 1],
  ] as const) {
    const kdf: KdfParams = { alg: 'argon2id', m, t, p, salt: toB64(det(`salt:${password}`, 16)) };
    const master = await deriveMasterKey(password, kdf);
    const pair = splitMasterKey(master);
    argon2id.push({
      password,
      kdf,
      masterKey: hex(master),
      kek: hex(pair.kek),
      verifier: hex(pair.verifier),
      verifierHash: hex(verifierHash(pair.verifier)),
    });
  }

  const recoveryKeyBytes = det('recovery', 32);
  const rec = splitRecoveryKey(recoveryKeyBytes);
  const recovery = [
    {
      key: hex(recoveryKeyBytes),
      formatted: formatRecoveryKey(recoveryKeyBytes),
      kek: hex(rec.kek),
      verifier: hex(rec.verifier),
    },
  ];

  const unlockSecret = det('prf-output', 32);
  const sec = splitUnlockSecret(unlockSecret);
  const unlockSecrets = [
    { secret: hex(unlockSecret), kek: hex(sec.kek), verifier: hex(sec.verifier) },
  ];

  const alice = generateKeyPair(det('alice', 32));
  const bob = generateKeyPair(det('bob', 32));
  const x25519 = [alice, bob].map((k, i) => ({
    name: i ? 'bob' : 'alice',
    privateKey: hex(k.privateKey),
    publicKey: hex(k.publicKey),
    fingerprint: fingerprint(k.publicKey),
    short: formatFingerprint(fingerprint(k.publicKey)),
  }));

  const userId = '0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
  const vaultId = '0192a1b2-c3d4-7e5f-8a9b-111111111111';
  const itemId = '0192a1b2-c3d4-7e5f-8a9b-222222222222';

  const privateKeyWraps = (['password', 'recovery', 'passkey_prf'] as const).map((method) => {
    const kek =
      method === 'password' ? splitMasterKey(det('master', 32)).kek : det(`kek:${method}`, 32);
    const nonce = det(`nonce:pk:${method}`, 12);
    return {
      userId,
      method,
      kek: hex(kek),
      nonce: hex(nonce),
      privateKey: hex(alice.privateKey),
      context: aad.privateKey(userId, method),
      wrapped: toB64(sealEnvelope(kek, alice.privateKey, aad.privateKey(userId, method), nonce)),
    };
  });

  const vaultKey = det('vault-key', 32);
  const vaultKeyWraps = [1, 2].map((keyVersion) => {
    const eph = det(`eph:${keyVersion}`, 32);
    const nonce = det(`nonce:vk:${keyVersion}`, 12);
    return {
      vaultId,
      keyVersion,
      userId,
      vaultKey: hex(vaultKey),
      recipientPrivateKey: hex(bob.privateKey),
      recipientPublicKey: hex(bob.publicKey),
      ephemeralPrivateKey: hex(eph),
      nonce: hex(nonce),
      context: aad.vaultKey(vaultId, keyVersion, userId),
      wrapped: toB64(
        sealTo(bob.publicKey, vaultKey, aad.vaultKey(vaultId, keyVersion, userId), {
          ephemeralPrivateKey: eph,
          nonce,
        }),
      ),
    };
  });

  const plaintexts = [
    {
      type: 'login' as const,
      json: JSON.stringify({
        v: 1,
        type: 'login',
        name: 'Docker Hub',
        favorite: true,
        notes: 'Yalnız organizasyon yönetimi için.',
        tags: [],
        env: null,
        fields: [{ id: 'f1', type: 'hidden', label: 'Kurtarma kodu', value: 'ABCD-EFGH' }],
        attachments: [],
        passwordHistory: [],
        importWarnings: [],
        username: 'crewhall',
        password: 'T7#qWm2!vR9pLx4$Kd8z',
        totp: 'otpauth://totp/Docker:crewhall?secret=JBSWY3DPEHPK3PXP&issuer=Docker',
        uris: ['https://hub.docker.com'],
      }),
    },
    {
      type: 'note' as const,
      json: JSON.stringify({
        v: 1,
        type: 'note',
        name: 'Ofis Wi-Fi',
        favorite: false,
        notes: 'SSID: ofis · şifre: güneş-çiçek-42',
        tags: [],
        env: null,
        fields: [],
        attachments: [],
        passwordHistory: [],
        importWarnings: [],
      }),
    },
  ];
  const items = plaintexts.map((pt, i) => {
    const revision = i + 1;
    const keyVersion = 1;
    const itemKey = det(`item-key:${i}`, 32);
    const nonce = det(`nonce:item:${i}`, 12);
    const wrapNonce = det(`nonce:ik:${i}`, 12);
    const enc = encryptItemPlaintext(
      vaultKey,
      { vaultId, itemId, revision, keyVersion, type: pt.type },
      utf8(pt.json),
      { itemKey, nonce, wrapNonce },
    );
    return {
      vaultId,
      itemId,
      revision,
      keyVersion,
      type: pt.type,
      vaultKey: hex(vaultKey),
      itemKey: hex(itemKey),
      nonce: hex(nonce),
      wrapNonce: hex(wrapNonce),
      itemContext: aad.item(vaultId, itemId, revision, pt.type),
      itemKeyContext: aad.itemKey(vaultId, itemId, revision, keyVersion),
      plaintext: pt.json,
      encrypted: enc,
    };
  });

  const attachmentId = '0192a1b2-c3d4-7e5f-8a9b-333333333333';
  const attachments = [0, 13, 1024 * 1024, 1024 * 1024 + 5].map((size) => {
    const data = det(`file:${size}`, size);
    const fileKey = det('file-key', 32);
    const noncePrefix = det(`prefix:${size}`, 8);
    const enc = encryptAttachment(fileKey, attachmentId, data, noncePrefix);
    return {
      attachmentId,
      size,
      dataLabel: `file:${size}`,
      fileKey: hex(fileKey),
      noncePrefix: hex(noncePrefix),
      encryptedSize: enc.length,
      encryptedSha256: hex(sha256(enc)),
    };
  });

  const totpSecrets = {
    SHA1: utf8('12345678901234567890'),
    SHA256: utf8('12345678901234567890123456789012'),
    SHA512: utf8('1234567890123456789012345678901234567890123456789012345678901234'),
  };
  const totp = [];
  for (const algorithm of ['SHA1', 'SHA256', 'SHA512'] as const) {
    for (const time of [59, 1111111109, 1111111111, 1234567890, 2000000000, 20000000000]) {
      totp.push({
        secretBase32: toBase32(totpSecrets[algorithm]),
        algorithm,
        digits: 8,
        period: 30,
        time,
        code: totpAt(
          { secret: totpSecrets[algorithm], algorithm, digits: 8, period: 30 },
          time * 1000,
        ).code,
      });
    }
  }

  const ssh = generateEd25519SshKey('root@milva-01', det('ssh-seed', 32));

  const vectors = {
    protocol: PROTOCOL,
    info,
    encoding: 'hex for raw bytes, base64 (standard, padded) for wire values',
    argon2id,
    recovery,
    unlockSecrets,
    x25519,
    privateKeyWraps,
    vaultKeyWraps,
    items,
    attachments,
    totp,
    ssh: {
      seed: hex(det('ssh-seed', 32)),
      comment: 'root@milva-01',
      publicKey: ssh.publicKey,
      fingerprint: ssh.fingerprint,
    },
  };
  writeFileSync(
    new URL('../test/vectors.json', import.meta.url),
    `${JSON.stringify(vectors, null, 2)}\n`,
  );
  console.log('wrote test/vectors.json');
}

void main();
