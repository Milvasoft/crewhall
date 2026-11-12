// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/base64/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { decodeBase64, encodeBase64 } from './logic';

describe('base64', () => {
  it('encodes ASCII', () => {
    expect(encodeBase64('hello')).toBe('aGVsbG8=');
  });

  it('round-trips Unicode', () => {
    const s = 'héllo 😀 世界';
    expect(decodeBase64(encodeBase64(s))).toBe(s);
  });

  it('supports URL-safe alphabet without padding', () => {
    const out = encodeBase64('<<???>>', { urlSafe: true, noPadding: true });
    expect(out).not.toMatch(/[+/=]/);
    expect(decodeBase64(out)).toBe('<<???>>');
  });

  it('decodes URL-safe input and restores padding', () => {
    const url = encodeBase64('any carnal pleasure', { urlSafe: true, noPadding: true });
    expect(decodeBase64(url)).toBe('any carnal pleasure');
  });

  it('throws on invalid characters', () => {
    expect(() => decodeBase64('not*base*64')).toThrow();
  });

  it('round-trips an empty string', () => {
    expect(encodeBase64('')).toBe('');
    expect(decodeBase64('')).toBe('');
  });

  it('produces the standard padding lengths for 1, 2 and 3 input bytes', () => {
    expect(encodeBase64('f')).toBe('Zg==');
    expect(encodeBase64('fo')).toBe('Zm8=');
    expect(encodeBase64('foo')).toBe('Zm9v');
  });

  it('strips embedded whitespace/newlines before decoding', () => {
    expect(decodeBase64('aGVs\n bG8=')).toBe('hello');
  });

  it('throws a specific error for an invalid (mod-4 == 1) length', () => {
    expect(() => decodeBase64('abcde')).toThrow(/length is not valid/i);
  });

  it('supports URL-safe alphabet while keeping padding', () => {
    const out = encodeBase64('<<???>>', { urlSafe: true });
    expect(out).toBe('PDw_Pz8-Pg==');
    expect(decodeBase64(out)).toBe('<<???>>');
  });

  it('round-trips a combining-mark sequence byte-for-byte', () => {
    const s = 'é'; // "e" + combining acute accent, two code points
    const encoded = encodeBase64(s);
    expect(decodeBase64(encoded)).toBe(s);
    expect(encoded).not.toBe(encodeBase64('é')); // precomposed vs. decomposed differ
  });
});
