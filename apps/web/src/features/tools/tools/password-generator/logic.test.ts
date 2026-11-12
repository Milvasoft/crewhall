// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/password-generator/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { estimateEntropyBits, generateKey, generatePassword } from './logic';

const base = {
  length: 20,
  lowercase: true,
  uppercase: true,
  digits: true,
  symbols: false,
  avoidAmbiguous: false,
};

describe('password-generator', () => {
  it('produces a password of the requested length', () => {
    expect(generatePassword(base)).toHaveLength(20);
  });

  it('respects the selected character sets', () => {
    const pw = generatePassword({
      ...base,
      uppercase: false,
      digits: false,
      symbols: false,
    });
    expect(pw).toMatch(/^[a-z]+$/);
  });

  it('throws when no set is selected', () => {
    expect(() =>
      generatePassword({
        ...base,
        lowercase: false,
        uppercase: false,
        digits: false,
        symbols: false,
      }),
    ).toThrow();
  });

  it('generates hex/base64 keys of the right size', () => {
    expect(generateKey(256, 'hex')).toHaveLength(64); // 32 bytes → 64 hex chars
    expect(generateKey(128, 'base64')).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(generateKey(128, 'base64url')).not.toMatch(/[+/=]/);
  });

  it('estimates entropy bits', () => {
    expect(estimateEntropyBits(base)).toBeGreaterThan(100);
  });

  it('returns zero entropy when no character set is selected', () => {
    expect(
      estimateEntropyBits({ ...base, lowercase: false, uppercase: false, digits: false }),
    ).toBe(0);
  });

  it('returns zero entropy for zero length', () => {
    expect(estimateEntropyBits({ ...base, length: 0 })).toBe(0);
  });

  it('excludes ambiguous characters when avoidAmbiguous is set', () => {
    const pw = generatePassword({
      ...base,
      length: 500,
      symbols: false,
      avoidAmbiguous: true,
    });
    expect(pw).not.toMatch(/[Il1O0o]/);
  });

  it('includes symbols when requested', () => {
    const symbols = '!@#$%^&*()-_=+[]{};:,.<>?';
    const pw = generatePassword({
      length: 200,
      lowercase: false,
      uppercase: false,
      digits: false,
      symbols: true,
      avoidAmbiguous: false,
    });
    expect([...pw].every((ch) => symbols.includes(ch))).toBe(true);
  });

  it('clamps length to the [1, 4096] range', () => {
    expect(generatePassword({ ...base, length: 0 })).toHaveLength(1);
    expect(generatePassword({ ...base, length: -5 })).toHaveLength(1);
    expect(generatePassword({ ...base, length: 10000 })).toHaveLength(4096);
  });

  it('produces different passwords across calls (structure only, never exact values)', () => {
    const passwords = new Set(Array.from({ length: 10 }, () => generatePassword(base)));
    expect(passwords.size).toBeGreaterThan(1);
  });

  it('respects the requested key size in bytes for hex encoding', () => {
    expect(generateKey(8, 'hex')).toHaveLength(2); // 1 byte -> 2 hex chars
    expect(generateKey(64, 'hex')).toHaveLength(16); // 8 bytes -> 16 hex chars
  });

  it('strips base64 padding for base64url encoding', () => {
    expect(generateKey(128, 'base64url')).not.toMatch(/=/);
  });

  it('produces different keys across calls', () => {
    const keys = new Set(Array.from({ length: 10 }, () => generateKey(128, 'hex')));
    expect(keys.size).toBeGreaterThan(1);
  });
});
