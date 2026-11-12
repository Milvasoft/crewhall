import { describe, expect, it } from 'vitest';
import {
  checkPwned,
  CryptoError,
  decryptShare,
  encryptShare,
  isPwnedPrefix,
  itemSummary,
  ItemPayload,
  newShareKey,
  pwnedCount,
  pwnedQuery,
  shareFragment,
  shareKeyFromFragment,
  sharePayloadOf,
  totpSourceOf,
  vaultHealth,
} from '../src/index';

/** Roadmap 20: leaked password check, TOTP sources and one-time share links. */

describe('leaked password check (k-anonymity)', () => {
  it('splits SHA-1 into the 5-digit prefix that is sent and the suffix that is not', () => {
    // SHA-1("password") = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
    expect(pwnedQuery('password')).toEqual({
      prefix: '5BAA6',
      suffix: '1E4C9B93F3F0682250B6CF8331B7EE68FD8',
    });
    expect(isPwnedPrefix('5BAA6')).toBe(true);
    expect(isPwnedPrefix('5baa6')).toBe(false);
    expect(isPwnedPrefix('5BAA61')).toBe(false);
  });

  it('hashes UTF-8 bytes as typed', () => {
    const q = pwnedQuery('şifre');
    expect(q.prefix + q.suffix).toMatch(/^[0-9A-F]{40}$/);
    expect(pwnedQuery('şifre')).toEqual(q);
    expect(pwnedQuery('sifre')).not.toEqual(q);
  });

  it('reads counts and ignores padding lines', () => {
    const range = [
      '0018A45C4D1DEF81644B54AB7F969B88D65:10',
      '1E4C9B93F3F0682250B6CF8331B7EE68FD8:9545824\r',
      '1E4C9B93F3F0682250B6CF8331B7EE68FD9:0',
      'garbage',
    ].join('\n');
    expect(pwnedCount(range, '1E4C9B93F3F0682250B6CF8331B7EE68FD8')).toBe(9545824);
    expect(pwnedCount(range, '1e4c9b93f3f0682250b6cf8331b7ee68fd8')).toBe(9545824);
    expect(pwnedCount(range, '1E4C9B93F3F0682250B6CF8331B7EE68FD9')).toBe(0);
    expect(pwnedCount(range, 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF')).toBe(0);
  });

  it('never hands the password or the full hash to the fetcher', async () => {
    const seen: string[] = [];
    const n = await checkPwned('password', async (prefix) => {
      seen.push(prefix);
      return '1E4C9B93F3F0682250B6CF8331B7EE68FD8:42';
    });
    expect(n).toBe(42);
    expect(seen).toEqual(['5BAA6']);
    expect(await checkPwned('', async () => 'x')).toBe(0);
  });

  it('puts breached passwords into the health report, ahead of reuse', () => {
    const mk = (id: string, password: string) => ({
      id,
      vaultId: 'v',
      payload: ItemPayload.parse({ v: 1, type: 'login', name: id, password }),
      updatedAt: '2026-10-01T00:00:00Z',
    });
    const report = vaultHealth(
      [mk('a', 'password'), mk('b', 'Unique-long-0ne!'), mk('c', 'Unique-long-0ne!')],
      new Date('2026-10-20T00:00:00Z'),
      () => 4,
      (pw) => (pw === 'password' ? 9545824 : 0),
    );
    expect(report.counts.breached).toBe(1);
    expect(report.rows[0]).toEqual({
      id: 'a',
      vaultId: 'v',
      issues: [{ kind: 'breached', count: 9545824 }],
    });
    expect(report.rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('TOTP source', () => {
  it("uses a login's own field first, then otpauth or labelled custom fields", () => {
    const login = ItemPayload.parse({ v: 1, type: 'login', name: 'x', totp: 'JBSWY3DPEHPK3PXP' });
    expect(totpSourceOf(login)).toBe('JBSWY3DPEHPK3PXP');
    const uri = 'otpauth://totp/AWS:root?secret=JBSWY3DPEHPK3PXP&issuer=AWS';
    const apiKey = ItemPayload.parse({
      v: 1,
      type: 'api_key',
      name: 'AWS',
      fields: [
        { id: '1', type: 'text', label: 'Region', value: 'eu-central-1' },
        { id: '2', type: 'hidden', label: 'MFA', value: uri },
      ],
    });
    expect(totpSourceOf(apiKey)).toBe(uri);
    expect(itemSummary(apiKey).hasTotp).toBe(true);
    const labelled = ItemPayload.parse({
      v: 1,
      type: 'note',
      name: 'n',
      fields: [{ id: '1', type: 'hidden', label: '2FA kodu', value: 'JBSW Y3DP EHPK 3PXP' }],
    });
    expect(totpSourceOf(labelled)).toBe('JBSW Y3DP EHPK 3PXP');
    const none = ItemPayload.parse({
      v: 1,
      type: 'note',
      name: 'n',
      fields: [{ id: '1', type: 'text', label: 'Not', value: 'JBSWY3DPEHPK3PXP' }],
    });
    expect(totpSourceOf(none)).toBe('');
    expect(itemSummary(none).hasTotp).toBe(false);
  });
});

describe('one-time share links', () => {
  const item = ItemPayload.parse({
    v: 1,
    type: 'login',
    name: 'Docker Hub',
    username: 'crewhall',
    password: 'T7#qWm2!vR9pLx4$Kd8z',
    totp: 'JBSWY3DPEHPK3PXP',
    notes: 'deploy user',
    favorite: true,
    tags: ['infra'],
    passwordHistory: [{ password: 'old-one', changedAt: '2026-01-01T00:00:00Z' }],
    attachments: [
      {
        id: '0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
        name: 'a.txt',
        size: 1,
        mime: null,
        key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      },
    ],
    importedFrom: 'bitwarden',
  });

  it('strips history, attachments and (by default) the TOTP secret', () => {
    const p = sharePayloadOf(item);
    expect(p).toMatchObject({ name: 'Docker Hub', password: 'T7#qWm2!vR9pLx4$Kd8z', totp: '' });
    expect(p.passwordHistory).toEqual([]);
    expect(p.attachments).toEqual([]);
    expect(p.tags).toEqual([]);
    expect(p.favorite).toBe(false);
    expect(p.importedFrom).toBeUndefined();
    expect(JSON.stringify(p)).not.toMatch(/old-one|JBSWY3/);
    expect(sharePayloadOf(item, { includeTotp: true })).toMatchObject({ totp: 'JBSWY3DPEHPK3PXP' });
    expect(sharePayloadOf(item, { includeNotes: false }).notes).toBe('');
  });

  it('round-trips through the fragment key; the ciphertext holds no plaintext', () => {
    const key = newShareKey();
    const fragment = shareFragment(key);
    expect(fragment).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const enc = encryptShare(key, sharePayloadOf(item));
    expect(Buffer.from(enc.ciphertext, 'base64').toString('latin1')).not.toMatch(
      /Docker|crewhall/,
    );
    const back = shareKeyFromFragment(`#${fragment}`);
    expect(back).not.toBeNull();
    expect(decryptShare(back!, enc)).toMatchObject({ name: 'Docker Hub', username: 'crewhall' });
  });

  it('rejects a wrong key, a tampered ciphertext and a malformed fragment', () => {
    const key = newShareKey();
    const enc = encryptShare(key, sharePayloadOf(item));
    expect(() => decryptShare(newShareKey(), enc)).toThrow(CryptoError);
    const bytes = Buffer.from(enc.ciphertext, 'base64');
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    expect(() => decryptShare(key, { ...enc, ciphertext: bytes.toString('base64') })).toThrow(
      CryptoError,
    );
    expect(shareKeyFromFragment('')).toBeNull();
    expect(shareKeyFromFragment('#short')).toBeNull();
    expect(shareKeyFromFragment(`#${'A'.repeat(44)}`)).toBeNull();
  });
});
