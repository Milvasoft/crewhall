import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  configureRandom,
  createAccountKeys,
  CryptoError,
  decryptAttachment,
  decryptItem,
  acceptSettings,
  decryptSettings,
  emptyItem,
  encryptAttachment,
  encryptBitwardenExport,
  encryptItem,
  encryptSettings,
  nextSettingsRevision,
  openSettings,
  encryptedSize,
  formatRecoveryKey,
  fromB64,
  fromUtf8,
  generateEd25519SshKey,
  generatePassphrase,
  generatePassword,
  ImportError,
  ItemPayload,
  newId,
  newKdfParams,
  newRecovery,
  newVaultKey,
  noteToApiKey,
  openPrivateKey,
  parseBitwardenExport,
  parseCsv,
  parseRecoveryKey,
  parseTotp,
  passphraseEntropyBits,
  passwordEntropyBits,
  passwordUnlockMaterial,
  randomInt,
  recoveryUnlockMaterial,
  RevisionGuard,
  rewrapItemKey,
  secretUnlockMaterial,
  sniffBitwardenFile,
  sshFingerprint,
  toB64,
  toBitwardenJson,
  totpForCopy,
  unwrapVaultKey,
  utf8,
  vaultHealth,
  healthFacts,
  healthReport,
  hostOf,
  itemSummary,
  secretDigest,
  withHistory,
  WORDLISTS,
  wrapForPassword,
  wrapForSecret,
  wrapVaultKey,
  generateKeyPair,
  fromBase32,
  toBase32,
  deriveMasterKey,
  type ItemPayload as Payload,
} from '../src/index';
import { measureStrength, vaultPasswordChecks } from '../src/strength';
import { det } from './det';

const USER = '0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
/** Fast-but-valid KDF parameters for tests (the floor the client accepts). */
const FAST = { m: 32768, t: 2, p: 1 };

afterEach(() => configureRandom(null));

describe('encoding', () => {
  it('utf8 and base64 round trip without platform globals', () => {
    const text = 'Çok güçlü şifre İı 🔐 \u0000';
    expect(fromUtf8(utf8(text))).toBe(text);
    expect(Buffer.from(utf8(text)).toString('utf8')).toBe(text);
    for (const n of [0, 1, 2, 3, 31, 32, 33]) {
      const b = det(`b64:${n}`, n);
      expect(toB64(b)).toBe(Buffer.from(b).toString('base64'));
      expect([...fromB64(toB64(b))]).toEqual([...b]);
    }
    expect(() => fromUtf8(Uint8Array.of(0xc3))).toThrow(CryptoError);
  });

  it('base32 round trip and look-alike digits', () => {
    const b = det('b32', 21);
    expect([...fromBase32(toBase32(b))]).toEqual([...b]);
    expect([...fromBase32('MZXW6===')]).toEqual([...utf8('foo')]);
  });
});

describe('randomness', () => {
  it('uses the injected source and rejects a broken one', () => {
    configureRandom((out) => out.fill(7));
    expect(newVaultKey().every((b) => b === 7)).toBe(true);
    configureRandom((out) => out.fill(0));
    expect(() => newVaultKey()).toThrow(/zeros/);
  });

  it('randomInt is unbiased enough over a small range', () => {
    const counts = [0, 0, 0];
    for (let i = 0; i < 3000; i++) counts[randomInt(3)]!++;
    for (const c of counts) expect(c).toBeGreaterThan(850);
  });

  it('ids are UUID v7', () => {
    expect(newId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('account keys', () => {
  it('sets up, unlocks with the password and with the recovery key', async () => {
    const setup = await createAccountKeys({
      userId: USER,
      password: 'correct horse battery staple',
      kdf: FAST,
    });
    const { upload } = setup;
    expect(setup.recoveryKey.split(' ')).toHaveLength(14);

    const pw = await passwordUnlockMaterial('correct horse battery staple', upload.kdf);
    expect(toB64(pw.verifier)).toBe(upload.passwordVerifier);
    const pk = openPrivateKey({
      kek: pw.kek,
      wrapped: upload.encryptedPrivateKey,
      userId: USER,
      method: 'password',
      publicKey: upload.publicKey,
    });
    expect(toB64(pk)).toBe(toB64(setup.privateKey));

    const rec = recoveryUnlockMaterial(setup.recoveryKey.toLowerCase().replace(/ /g, '-'));
    expect(toB64(rec.verifier)).toBe(upload.recoveryVerifier);
    expect(
      toB64(
        openPrivateKey({
          kek: rec.kek,
          wrapped: upload.recoveryWrappedKey,
          userId: USER,
          method: 'recovery',
          publicKey: upload.publicKey,
        }),
      ),
    ).toBe(toB64(pk));
  });

  it('a wrong password, another user id or a swapped method does not open the key', async () => {
    const setup = await createAccountKeys({
      userId: USER,
      password: 'correct horse battery staple',
      kdf: FAST,
    });
    const wrong = await passwordUnlockMaterial('correct horse battery stapler', setup.upload.kdf);
    expect(toB64(wrong.verifier)).not.toBe(setup.upload.passwordVerifier);
    expect(() =>
      openPrivateKey({
        kek: wrong.kek,
        wrapped: setup.upload.encryptedPrivateKey,
        userId: USER,
        method: 'password',
        publicKey: setup.upload.publicKey,
      }),
    ).toThrow(CryptoError);
    const right = await passwordUnlockMaterial('correct horse battery staple', setup.upload.kdf);
    expect(() =>
      openPrivateKey({
        kek: right.kek,
        wrapped: setup.upload.encryptedPrivateKey,
        userId: newId(),
        method: 'password',
        publicKey: setup.upload.publicKey,
      }),
    ).toThrow(CryptoError);
    expect(() =>
      openPrivateKey({
        kek: right.kek,
        wrapped: setup.upload.encryptedPrivateKey,
        userId: USER,
        method: 'recovery',
        publicKey: setup.upload.publicKey,
      }),
    ).toThrow(CryptoError);
  });

  it('password change and recovery key rotation keep the same private key', async () => {
    const setup = await createAccountKeys({
      userId: USER,
      password: 'first long password!',
      kdf: FAST,
    });
    const changed = await wrapForPassword(
      setup.privateKey,
      USER,
      'second long password!',
      newKdfParams(FAST),
    );
    expect(changed.kdf.salt).not.toBe(setup.upload.kdf.salt);
    const pw = await passwordUnlockMaterial('second long password!', changed.kdf);
    expect(
      toB64(
        openPrivateKey({
          kek: pw.kek,
          wrapped: changed.encryptedPrivateKey,
          userId: USER,
          method: 'password',
          publicKey: setup.upload.publicKey,
        }),
      ),
    ).toBe(toB64(setup.privateKey));

    const again = newRecovery(setup.privateKey, USER);
    expect(again.recoveryKey).not.toBe(setup.recoveryKey);
    const rec = recoveryUnlockMaterial(again.recoveryKey);
    expect(toB64(rec.verifier)).toBe(again.recoveryVerifier);
  });

  it('passkey PRF / device secrets wrap the key', () => {
    const pair = generateKeyPair();
    const secret = det('prf', 32);
    const w = wrapForSecret(pair.privateKey, USER, 'passkey_prf', secret);
    const m = secretUnlockMaterial(secret);
    expect(toB64(m.verifier)).toBe(w.verifier);
    expect(
      toB64(
        openPrivateKey({
          kek: m.kek,
          wrapped: w.wrappedPrivateKey,
          userId: USER,
          method: 'passkey_prf',
          publicKey: toB64(pair.publicKey),
        }),
      ),
    ).toBe(toB64(pair.privateKey));
  });

  it('refuses KDF parameters a malicious server could lower', async () => {
    const salt = toB64(det('salt', 16));
    for (const kdf of [
      { alg: 'argon2id' as const, m: 8, t: 3, p: 1, salt },
      { alg: 'argon2id' as const, m: 65536, t: 1, p: 4, salt },
      { alg: 'argon2id' as const, m: 65536, t: 3, p: 4, salt: toB64(det('s', 8)) },
    ]) {
      await expect(deriveMasterKey('x', kdf)).rejects.toMatchObject({ code: 'weak_kdf' });
    }
  });

  it('recovery key typos are caught by the checksum', () => {
    const text = formatRecoveryKey(det('rk', 32));
    const typo = (text[0] === 'A' ? 'B' : 'A') + text.slice(1);
    expect(() => parseRecoveryKey(typo)).toThrow(/invalid_recovery_key/);
    expect(() => parseRecoveryKey(text.slice(0, -4))).toThrow(/invalid_recovery_key/);
    expect(() => parseRecoveryKey('not base32 !')).toThrow(/invalid_recovery_key/);
  });

  it('settings are encrypted and bound to the user', () => {
    const pair = generateKeyPair();
    const blob = encryptSettings(pair.privateKey, USER, { autoLockMinutes: 5, pins: { a: 'b' } });
    expect(decryptSettings(pair.privateKey, USER, blob)).toEqual({
      autoLockMinutes: 5,
      pins: { a: 'b' },
    });
    expect(() => decryptSettings(pair.privateKey, newId(), blob)).toThrow(CryptoError);
    // What the server can do with them, and what a device that remembers a revision can tell.
    const open = (b: string | null, floor: number) => openSettings(pair.privateKey, USER, b, floor);
    const at = (revision: number) => encryptSettings(pair.privateKey, USER, { revision });
    expect(open(at(20), 20)).toMatchObject({ state: 'ok', revision: 20 });
    expect(open(at(30), 20)).toMatchObject({ state: 'ok', revision: 30 });
    expect(open(at(10), 20)).toMatchObject({ state: 'rolled_back', revision: 10 });
    expect(open(null, 20)).toMatchObject({ state: 'rolled_back', revision: 0 });
    expect(open(null, 0)).toMatchObject({ state: 'ok', revision: 0 });
    // Blobs from before revisions open as they are, and count as 0.
    expect(open(blob, 0)).toMatchObject({ state: 'ok', revision: 0 });
    expect(open(blob, 20)).toMatchObject({ state: 'rolled_back', revision: 0 });
    expect(open('AAAA', 0).state).toBe('unreadable');
    expect(open(encryptSettings(pair.privateKey, USER, 'x'), 0).state).toBe('unreadable');
    expect(open(encryptSettings(pair.privateKey, newId(), {}), 0).state).toBe('unreadable');
    // A later save stays above the floor, also with a clock behind it.
    expect(nextSettingsRevision(20, 1000)).toBe(1000);
    expect(nextSettingsRevision(2000, 1000)).toBe(2001);
    // Accepting what the server holds: newest for every device, and unpinned keys get confirmed.
    expect(acceptSettings({ revision: 10, pins: { a: 'b' } }, 20, 15)).toEqual({
      revision: 21,
      pins: { a: 'b' },
      confirmNewKeys: true,
    });
    expect(open(at(acceptSettings({}, 20, 15).revision), 20).state).toBe('ok');
  });
});

describe('vault and items', () => {
  const vaultId = newId();
  const itemId = newId();
  const login = ItemPayload.parse({
    v: 1,
    type: 'login',
    name: 'Docker Hub',
    username: 'crewhall',
    password: 's3cret!',
    uris: ['https://hub.docker.com'],
  });

  it('only the recipient opens a sealed vault key, and only in its context', () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const key = newVaultKey();
    const wrapped = wrapVaultKey(key, bob.publicKey, { vaultId, keyVersion: 1, userId: 'bob' });
    expect(
      toB64(unwrapVaultKey(bob.privateKey, wrapped, { vaultId, keyVersion: 1, userId: 'bob' })),
    ).toBe(toB64(key));
    expect(() =>
      unwrapVaultKey(alice.privateKey, wrapped, { vaultId, keyVersion: 1, userId: 'bob' }),
    ).toThrow(CryptoError);
    expect(() =>
      unwrapVaultKey(bob.privateKey, wrapped, { vaultId, keyVersion: 2, userId: 'bob' }),
    ).toThrow(CryptoError);
    expect(() =>
      unwrapVaultKey(bob.privateKey, wrapped, { vaultId: newId(), keyVersion: 1, userId: 'bob' }),
    ).toThrow(CryptoError);
  });

  it('a low-order public key is refused', () => {
    expect(() =>
      wrapVaultKey(newVaultKey(), new Uint8Array(32), { vaultId, keyVersion: 1, userId: 'x' }),
    ).toThrow(CryptoError);
  });

  it('items round trip; swapping ids, revision or type breaks decryption (AAD)', () => {
    const key = newVaultKey();
    const ctx = { vaultId, itemId, revision: 3, keyVersion: 1, type: 'login' as const };
    const enc = encryptItem(key, ctx, login);
    expect(decryptItem(key, ctx, enc)).toEqual(login);
    // Nothing secret is visible in the ciphertext.
    expect(fromB64(enc.ciphertext).toString()).not.toContain('crewhall');
    for (const bad of [
      { ...ctx, itemId: newId() },
      { ...ctx, vaultId: newId() },
      { ...ctx, revision: 2 },
      { ...ctx, keyVersion: 2 },
      { ...ctx, type: 'note' as const },
    ]) {
      expect(() => decryptItem(key, bad, enc)).toThrow(CryptoError);
    }
    const tampered = fromB64(enc.ciphertext);
    tampered[0] = (tampered[0] as number) ^ 1;
    expect(() => decryptItem(key, ctx, { ...enc, ciphertext: toB64(tampered) })).toThrow(
      CryptoError,
    );
    expect(() => encryptItem(key, { ...ctx, type: 'note' }, login)).toThrow(CryptoError);
  });

  it('rotation re-wraps old revision keys under the new vault key', () => {
    const oldKey = newVaultKey();
    const newKey = newVaultKey();
    const ctx = { vaultId, itemId, revision: 1, keyVersion: 1, type: 'login' as const };
    const enc = encryptItem(oldKey, ctx, login);
    const rewrapped = rewrapItemKey(
      oldKey,
      newKey,
      { vaultId, itemId, revision: 1, oldKeyVersion: 1, newKeyVersion: 2 },
      enc.itemKeyWrapped,
    );
    expect(
      decryptItem(newKey, { ...ctx, keyVersion: 2 }, { ...enc, itemKeyWrapped: rewrapped }),
    ).toEqual(login);
    expect(() => decryptItem(oldKey, ctx, { ...enc, itemKeyWrapped: rewrapped })).toThrow(
      CryptoError,
    );
  });

  it('the revision guard refuses rollbacks', () => {
    const g = new RevisionGuard();
    expect(g.check('a', 3)).toBe(true);
    expect(g.check('a', 3)).toBe(true);
    expect(g.check('a', 2)).toBe(false);
    expect(g.check('a', 4)).toBe(true);
  });

  it('password history keeps the previous secret, newest first, at most 10', () => {
    let item: Payload = login;
    for (let i = 0; i < 12; i++) {
      item = withHistory(
        item,
        { ...item, password: `pw-${i}` } as Payload,
        new Date(2026, 0, i + 1),
      );
    }
    expect(item.passwordHistory).toHaveLength(10);
    expect(item.passwordHistory[0]?.password).toBe('pw-10');
    const same = withHistory(item, { ...item, name: 'renamed' } as Payload);
    expect(same.passwordHistory).toEqual(item.passwordHistory);
  });

  it('unknown fields from newer clients survive parsing', () => {
    const parsed = ItemPayload.parse({ ...login, futureField: { x: 1 } });
    expect((parsed as Record<string, unknown>).futureField).toEqual({ x: 1 });
  });

  it('every type has an empty template', () => {
    for (const t of ['login', 'note', 'card', 'api_key', 'ssh_key', 'identity'] as const) {
      expect(emptyItem(t, 'x')).toMatchObject({ type: t, name: 'x', v: 1 });
    }
  });
});

describe('attachments', () => {
  it('chunked encryption detects truncation, reordering and a wrong id', () => {
    const key = det('fk', 32);
    const data = det('data', 2 * 1024 * 1024 + 10);
    const enc = encryptAttachment(key, 'a1', data);
    expect(enc.length).toBe(encryptedSize(data.length));
    expect(Buffer.from(decryptAttachment(key, 'a1', enc)).equals(Buffer.from(data))).toBe(true);
    expect(() => decryptAttachment(key, 'a2', enc)).toThrow(CryptoError);
    const truncated = enc.subarray(0, 9 + (1024 * 1024 + 16));
    expect(() => decryptAttachment(key, 'a1', truncated)).toThrow(CryptoError);
  });
});

describe('TOTP', () => {
  it('parses otpauth URIs and bare secrets', () => {
    const cfg = parseTotp(
      'otpauth://totp/Docker:crewhall?secret=JBSWY3DPEHPK3PXP&issuer=Docker&digits=6&period=30',
    );
    expect(cfg).toMatchObject({
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      issuer: 'Docker',
      account: 'crewhall',
    });
    expect(parseTotp('jbsw y3dp ehpk 3pxp')).toMatchObject({ digits: 6 });
    expect(parseTotp('otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP')).toBeNull();
    expect(parseTotp('not a secret!')).toBeNull();
    expect(parseTotp('')).toBeNull();
  });

  it('copies the next code when fewer than 5 seconds are left', () => {
    const cfg = parseTotp('JBSWY3DPEHPK3PXP')!;
    const t = 1_700_000_000_000 - (1_700_000_000_000 % 30_000) + 27_000;
    const next = totpForCopy(cfg, t + 3000);
    expect(totpForCopy(cfg, t)).toBe(next);
  });
});

describe('generator', () => {
  it('passwords honour length and include every chosen class', () => {
    for (let i = 0; i < 50; i++) {
      const pw = generatePassword({
        length: 12,
        symbols: true,
        digits: true,
        upper: true,
        lower: true,
      });
      expect(pw).toHaveLength(12);
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/[0-9]/);
      expect(pw).toMatch(/[!@#$%^&*]/);
    }
    const noAmb = generatePassword({ length: 64, avoidAmbiguous: true });
    expect(noAmb).not.toMatch(/[l1IO0o]/);
    expect(
      generatePassword({ length: 20, upper: false, lower: false, digits: true, symbols: false }),
    ).toMatch(/^\d{20}$/);
    expect(() =>
      generatePassword({ upper: false, lower: false, digits: false, symbols: false }),
    ).toThrow();
    expect(passwordEntropyBits({ length: 22 })).toBe(Math.floor(22 * Math.log2(70)));
  });

  it('passphrases come from the word lists', () => {
    expect(WORDLISTS.en.length).toBeGreaterThan(700);
    expect(WORDLISTS.tr.length).toBeGreaterThan(500);
    const p = generatePassphrase({
      words: 6,
      separator: '.',
      capitalize: false,
      includeNumber: false,
      lang: 'tr',
    });
    const words = p.split('.');
    expect(words).toHaveLength(6);
    for (const w of words) expect(WORDLISTS.tr).toContain(w);
    expect(generatePassphrase({ words: 4, lang: 'tr', capitalize: true })).toMatch(/^[A-ZÇĞİÖŞÜ]/);
    expect(passphraseEntropyBits({ words: 6, includeNumber: false, lang: 'en' })).toBeGreaterThan(
      55,
    );
  });
});

describe('strength', () => {
  it('rates passwords and flags leaked ones and personal info', () => {
    expect(measureStrength('password').level).toBe('weak');
    expect(measureStrength('password').leaked).toBe(true);
    expect(measureStrength('vR9#pLx4$Kd8zT7!qWm2bN').level).toBe('very_strong');
    const r = vaultPasswordChecks('bugra-kosen-2026!', [
      'bugra@milvasoft.com',
      'Ahmet Buğra Kösen',
    ]);
    expect(r.checks.noPersonalInfo).toBe(false);
    expect(r.ok).toBe(false);
    expect(vaultPasswordChecks('kayısı-pusula-fener-yelken-41').ok).toBe(true);
    expect(vaultPasswordChecks('Short1!').checks.length).toBe(false);
  });
});

describe('ssh', () => {
  it('generates an OpenSSH ed25519 key and fingerprints public keys', () => {
    const k = generateEd25519SshKey('deploy@ci');
    expect(k.privateKey).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----\n/);
    expect(k.publicKey).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 ?/);
    expect(sshFingerprint(k.publicKey)).toBe(k.fingerprint);
    // Well-known key from the OpenSSH test suite would need the binary; check shape instead.
    expect(k.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(sshFingerprint('garbage')).toBeNull();
  });
});

describe('Bitwarden import', () => {
  const fixture = readFileSync(new URL('./fixtures/bitwarden.json', import.meta.url), 'utf8');

  it('counts rows it cannot read, in plain and password-protected files', async () => {
    const good = { type: 2, name: 'Not' };
    const deleted = { ...good, deletedDate: '2026-01-01T00:00:00Z' };
    // Not an object, no type, a wrong field type, an unknown type.
    const bad = ['x', { name: 'Tipsiz' }, { type: 1, name: 5 }, { type: 99, name: 'Yeni tür' }];
    const plain = JSON.stringify({ encrypted: false, items: [good, deleted, ...bad] });

    const r = await parseBitwardenExport(plain);
    expect(r.stats).toMatchObject({ total: 1, skippedDeleted: 1, failed: 4 });

    const file = await encryptBitwardenExport(plain, 'dosya-sifresi', { iterations: 5000 });
    const protectedFile = await parseBitwardenExport(file, { password: 'dosya-sifresi' });
    expect(protectedFile.format).toBe('encrypted_json');
    expect(protectedFile.stats).toMatchObject({ total: 1, skippedDeleted: 1, failed: 4 });
  });

  it('maps every type, groups by folder / collection and reports warnings', async () => {
    expect(sniffBitwardenFile(fixture)).toBe('json');
    const r = await parseBitwardenExport(fixture);
    expect(r.stats).toMatchObject({
      total: 6,
      folders: 2,
      collections: 1,
      withTotp: 1,
      skippedDeleted: 1,
      failed: 0,
    });
    expect(r.stats.byType).toEqual({ login: 2, card: 1, note: 1, identity: 1, ssh_key: 1 });
    expect(r.groups.map((g) => [g.kind, g.name, g.count])).toEqual([
      ['none', '', 3],
      ['folder', 'Bankacılık', 1],
      ['collection', 'Sunucular', 1],
      ['folder', 'Sosyal medya', 1],
    ]);
    const docker = r.items.find((i) => i.payload.name === 'Docker Hub')!;
    expect(docker.payload).toMatchObject({
      type: 'login',
      favorite: true,
      username: 'crewhall',
      password: 'T7#qWm2!vR9pLx4$Kd8z',
      uris: ['https://hub.docker.com', 'https://login.docker.com'],
      passwordHistory: [{ password: 'old-password-1', changedAt: '2026-09-03T10:00:00.000Z' }],
      importedFrom: 'bitwarden',
    });
    expect(docker.payload.fields.map((f) => [f.type, f.label, f.value])).toEqual([
      ['text', 'Organizasyon', 'crewhall (Team)'],
      ['hidden', 'Kurtarma kodu', 'ABCD-EFGH-IJKL'],
      ['boolean', '2FA açık', 'true'],
    ]);
    expect(docker.warnings).toEqual(['linked_field_dropped']);
    expect(docker.createdAt).toBe('2025-01-10T08:30:00.000Z');

    const card = r.items.find((i) => i.payload.type === 'card')!;
    expect(card.payload).toMatchObject({
      expMonth: '',
      expYear: '2027',
      number: '4111111111111111',
    });
    expect(card.warnings).toEqual(['invalid_expiry']);

    const play = r.items.find((i) => i.payload.name === 'Google Play Console')!;
    expect(play.warnings.sort()).toEqual(['attachments_missing', 'passkey_not_migrated']);

    const seq = r.items.find((i) => i.payload.name === 'Seq API key')!;
    expect(seq.apiKeyLike).toBe(true);
    expect(noteToApiKey(seq.payload)).toMatchObject({
      type: 'api_key',
      key: 'seq_9fJ2kLm3QzX7',
      notes: '',
    });
    expect(ItemPayload.safeParse(noteToApiKey(seq.payload)).success).toBe(true);

    const id = r.items.find((i) => i.payload.type === 'identity')!;
    expect(id.payload).toMatchObject({
      firstName: 'Ahmet',
      nationalId: '12345678901',
      passport: 'U1234567',
      city: 'İstanbul',
    });
  });

  it('reads password-protected exports (PBKDF2 and Argon2id) and rejects a wrong password', async () => {
    const pbkdf2 = await encryptBitwardenExport(fixture, 'export-pass', { iterations: 5000 });
    expect(sniffBitwardenFile(pbkdf2)).toBe('encrypted_json');
    await expect(parseBitwardenExport(pbkdf2)).rejects.toMatchObject({ code: 'password_required' });
    await expect(parseBitwardenExport(pbkdf2, { password: 'nope' })).rejects.toBeInstanceOf(
      ImportError,
    );
    expect((await parseBitwardenExport(pbkdf2, { password: 'export-pass' })).stats.total).toBe(6);

    const argon = await encryptBitwardenExport(fixture, 'export-pass', {
      argon2: { iterations: 3, memory: 16, parallelism: 1 },
    });
    const r = await parseBitwardenExport(argon, { password: 'export-pass' });
    expect(r.format).toBe('encrypted_json');
    expect(r.stats.total).toBe(6);
  }, 60_000);

  it('refuses account-restricted encrypted exports', async () => {
    const doc = JSON.stringify({
      encrypted: true,
      encKeyValidation_DO_NOT_EDIT: '2.a|b|c',
      folders: [],
      items: [],
    });
    expect(sniffBitwardenFile(doc)).toBe('account_encrypted');
    await expect(parseBitwardenExport(doc)).rejects.toMatchObject({ code: 'account_encrypted' });
  });

  it('reads the CSV export', async () => {
    const csv = [
      'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp',
      'Sosyal medya,1,login,"Twitter, X","line1\nline2","PIN: 1234",0,https://x.com,user,"p""w",JBSWY3DPEHPK3PXP',
      ',,note,Ofis Wi-Fi,secret note,,0,,,,',
    ].join('\r\n');
    expect(parseCsv(csv)[1]).toHaveLength(11);
    const r = await parseBitwardenExport(csv);
    expect(r.format).toBe('csv');
    expect(r.items[0]?.payload).toMatchObject({
      type: 'login',
      name: 'Twitter, X',
      notes: 'line1\nline2',
      password: 'p"w',
      favorite: true,
    });
    expect(r.items[0]?.payload.fields[0]).toMatchObject({ label: 'PIN', value: '1234' });
    expect(r.items[1]?.payload).toMatchObject({ type: 'note', notes: 'secret note' });
    expect(r.groups.map((g) => g.name)).toEqual(['', 'Sosyal medya']);
  });

  it('exports back to Bitwarden JSON that the importer reads', async () => {
    const items = (await parseBitwardenExport(fixture)).items.map((i) => ({
      payload: i.payload,
      folder: 'Taşınan',
    }));
    const apiKey = {
      payload: ItemPayload.parse({
        v: 1,
        type: 'api_key',
        name: 'NuGet',
        key: 'k-123',
        scope: 'push',
      }),
      folder: null,
    };
    const again = await parseBitwardenExport(toBitwardenJson([...items, apiKey]));
    expect(again.stats.total).toBe(7);
    expect(again.items.find((i) => i.payload.name === 'NuGet')?.payload).toMatchObject({
      type: 'login',
      password: 'k-123',
    });
  });
});

describe('health', () => {
  it('finds expired, expiring, reused and old secrets', () => {
    const now = new Date('2026-10-19T09:00:00Z');
    const mk = (id: string, p: Record<string, unknown>, updatedAt = '2026-10-01T00:00:00Z') => ({
      id,
      vaultId: 'v',
      payload: ItemPayload.parse({ v: 1, name: id, ...p }),
      updatedAt,
    });
    const report = vaultHealth(
      [
        mk('cf', { type: 'api_key', key: 'x', expiresAt: '2026-10-12' }),
        mk('azdo', { type: 'api_key', key: 'y', expiresAt: '2026-10-28' }),
        mk('redis', { type: 'login', password: 'same-password' }),
        mk('pg', { type: 'login', password: 'same-password' }),
        mk('ccp', { type: 'login', password: 'unique-one' }, '2024-07-14T00:00:00Z'),
        mk('ok', { type: 'login', password: 'fine-and-unique' }),
        mk('note', { type: 'note' }),
      ],
      now,
      (pw) => (pw === 'same-password' ? 1 : 4),
    );
    expect(report.checked).toBe(6);
    expect(report.counts).toEqual({
      expired: 1,
      breached: 0,
      expiring: 1,
      reused: 2,
      weak: 2,
      old: 1,
    });
    expect(report.rows.map((r) => r.id)).toEqual(['cf', 'azdo', 'redis', 'pg', 'ccp']);
    expect(report.rows[1]?.issues[0]).toEqual({ kind: 'expiring', date: '2026-10-28', days: 9 });
    expect(report.score).toBe(17);
  });
});

describe('list summaries and health facts (H13)', () => {
  it('summaries carry list fields only, never secrets', () => {
    const login = ItemPayload.parse({
      v: 1,
      type: 'login',
      name: 'Docker Hub',
      username: 'crewhall',
      password: 'T7#qWm2!vR9pLx4$Kd8z',
      totp: 'JBSWY3DPEHPK3PXP',
      uris: ['https://hub.docker.com/login?next=1'],
      notes: 'secret note',
      env: 'prod',
    });
    const s = itemSummary(login);
    expect(s).toMatchObject({
      type: 'login',
      name: 'Docker Hub',
      username: 'crewhall',
      host: 'hub.docker.com',
      env: 'prod',
      hasTotp: true,
    });
    expect(JSON.stringify(s)).not.toMatch(/T7#qWm2|JBSWY3|secret note/);
    const card = itemSummary(
      ItemPayload.parse({
        v: 1,
        type: 'card',
        name: 'Kart',
        number: '4111 1111 1111 1234',
        cvv: '123',
      }),
    );
    expect(card.cardLast4).toBe('1234');
    expect(JSON.stringify(card)).not.toMatch(/4111|"123"/);
    expect(hostOf('hub.docker.com/x')).toBe('hub.docker.com');
    expect(hostOf('ssh://git@example.com:22')).toBe('example.com');
  });

  it('the report over digests matches the one over payloads', () => {
    const now = new Date('2026-10-19T09:00:00Z');
    const items = [
      ['a', { type: 'login', password: 'same-password' }],
      ['b', { type: 'login', password: 'same-password' }],
      ['c', { type: 'api_key', key: 'k', expiresAt: '2026-10-25' }],
    ] as const;
    const parsed = items.map(([id, p]) => ({
      id,
      vaultId: 'v',
      payload: ItemPayload.parse({ v: 1, name: id, ...p }),
      updatedAt: '2026-10-01T00:00:00Z',
    }));
    const measure = (pw: string) => (pw === 'same-password' ? 1 : 4);
    const facts = parsed.map((i) => {
      const f = healthFacts(i.id, i.vaultId, i.payload, i.updatedAt, secretDigest);
      return { ...f, score: i.payload.type === 'login' ? measure(i.payload.password) : undefined };
    });
    expect(JSON.stringify(facts)).not.toContain('same-password');
    expect(healthReport(facts, now)).toEqual(vaultHealth(parsed, now, measure));
  });

  it('measures a password within the per-item budget', () => {
    const passwords = Array.from({ length: 20 }, (_, i) => `Gizli-${i}-Xq9!pass-k4l3m-${i * 7}`);
    measureStrength('warm-up-the-dictionaries');
    const started = performance.now();
    for (const pw of passwords) measureStrength(pw);
    const each = (performance.now() - started) / passwords.length;
    // Was 230-520 ms per password with Levenshtein on; now ~5-10 ms. 1000 items fit in seconds.
    // The CI agent (arm64, under parallel load) measured ~90 ms, so the bound stays below the
    // Levenshtein range instead of near the local figure: it catches that regression, not noise.
    expect(each).toBeLessThan(200);
  });
});
