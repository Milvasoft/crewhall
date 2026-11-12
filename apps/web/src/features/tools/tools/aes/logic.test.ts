// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/aes/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { aesDecrypt, aesEncrypt } from './logic';

describe('aes', () => {
  it('round-trips text', async () => {
    const secret = 'the quick brown fox, 世界 😀';
    const blob = await aesEncrypt(secret, 'hunter2');
    expect(blob).not.toContain(secret);
    expect(await aesDecrypt(blob, 'hunter2')).toBe(secret);
  });

  it('produces different ciphertext each time (random salt/iv)', async () => {
    const a = await aesEncrypt('x', 'pw');
    const b = await aesEncrypt('x', 'pw');
    expect(a).not.toBe(b);
  });

  it('fails with the wrong passphrase', async () => {
    const blob = await aesEncrypt('secret', 'right');
    await expect(aesDecrypt(blob, 'wrong')).rejects.toThrow();
  });

  it('requires a passphrase', async () => {
    await expect(aesEncrypt('x', '')).rejects.toThrow();
  });

  it('requires a passphrase for decryption too', async () => {
    const blob = await aesEncrypt('x', 'pw');
    await expect(aesDecrypt(blob, '')).rejects.toThrow('A passphrase is required.');
  });

  it('round-trips an empty string', async () => {
    const blob = await aesEncrypt('', 'pw');
    expect(await aesDecrypt(blob, 'pw')).toBe('');
  });

  it('round-trips unicode with combining marks and emoji surrogate pairs', async () => {
    const secret = 'éé 👩‍👩‍👦'; // é (combining) é, family emoji ZWJ sequence
    const blob = await aesEncrypt(secret, 'pw');
    expect(await aesDecrypt(blob, 'pw')).toBe(secret);
  });

  it('rejects payloads shorter than salt+iv (28 bytes)', async () => {
    await expect(aesDecrypt(btoa('short'), 'pw')).rejects.toThrow(
      'Ciphertext is too short or malformed.',
    );
  });

  it('rejects an empty payload', async () => {
    await expect(aesDecrypt('', 'pw')).rejects.toThrow('Ciphertext is too short or malformed.');
  });

  it('rejects malformed base64 payloads', async () => {
    await expect(aesDecrypt('not-valid-base64!!!', 'pw')).rejects.toThrow();
  });

  it('fails when the ciphertext bytes are tampered with', async () => {
    const blob = await aesEncrypt('secret data', 'pw');
    const bytes = atob(blob);
    const tampered =
      bytes.slice(0, -1) + String.fromCharCode((bytes.charCodeAt(bytes.length - 1) ^ 0xff) & 0xff);
    const tamperedB64 = btoa(tampered);
    await expect(aesDecrypt(tamperedB64, 'pw')).rejects.toThrow(
      'Decryption failed, wrong passphrase or corrupted data.',
    );
  });
});
