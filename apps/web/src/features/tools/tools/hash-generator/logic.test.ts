// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/hash-generator/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { HASH_ALGOS, hash, hmac } from './logic';

describe('hash-generator', () => {
  it("computes known SHA-256 of 'abc'", async () => {
    expect(await hash('abc', 'SHA-256')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it("computes known SHA-1 of 'abc'", async () => {
    expect(await hash('abc', 'SHA-1')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
  });

  it('computes a known HMAC-SHA256', async () => {
    // HMAC-SHA256(key="key", msg="The quick brown fox jumps over the lazy dog")
    expect(await hmac('The quick brown fox jumps over the lazy dog', 'key', 'SHA-256')).toBe(
      'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
    );
  });

  it('produces different digests per algorithm', async () => {
    const a = await hash('x', 'SHA-256');
    const b = await hash('x', 'SHA-512');
    expect(a).not.toBe(b);
    expect(b).toHaveLength(128);
  });

  it('computes the known SHA-256 of the empty string', async () => {
    expect(await hash('', 'SHA-256')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it("computes known SHA-384 and SHA-512 of 'abc'", async () => {
    expect(await hash('abc', 'SHA-384')).toBe(
      'cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7',
    );
    expect(await hash('abc', 'SHA-512')).toBe(
      'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f',
    );
  });

  it('hashes unicode text (multi-byte, emoji) using UTF-8 byte length, not char length', async () => {
    const digest = await hash('héllo 世界 😀', 'SHA-256');
    expect(digest).toBe('18e9cb691e303ac25bc5d374955bf4239a9f7ce6ca7895230613908612e84d78');
    expect(digest).toHaveLength(64);
  });

  it('computes a known HMAC-SHA1', async () => {
    expect(await hmac('The quick brown fox jumps over the lazy dog', 'key', 'SHA-1')).toBe(
      'de7c9b85b8b78aa6bc8a7a36f70a90701c9db4d9',
    );
  });

  it('computes HMAC with unicode key and message', async () => {
    expect(await hmac('héllo 世界 😀', 'pässwörd \u{1F511}', 'SHA-256')).toBe(
      '11b7fa753ed99a1029f7118cfb982025b771fc05d45b79a8e3b7ce13ed24ebf2',
    );
  });

  it('rejects an empty HMAC key (WebCrypto does not support zero-length keys)', async () => {
    await expect(hmac('message', '', 'SHA-256')).rejects.toThrow();
  });

  it('exposes the supported algorithm list', () => {
    expect(HASH_ALGOS).toEqual(['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512']);
  });
});
