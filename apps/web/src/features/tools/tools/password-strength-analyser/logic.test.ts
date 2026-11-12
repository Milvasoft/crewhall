// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/password-strength-analyser/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { analyzePassword } from './logic';

describe('password-strength-analyser', () => {
  it('scores an empty password as very weak', () => {
    const r = analyzePassword('');
    expect(r.score).toBe(0);
    expect(r.entropyBits).toBe(0);
  });

  it('rates a short numeric PIN weak', () => {
    const r = analyzePassword('1234');
    expect(r.poolSize).toBe(10);
    expect(r.score).toBeLessThanOrEqual(1);
    expect(r.warnings).toContain('Digits only.');
  });

  it('rates a long mixed password strong', () => {
    const r = analyzePassword('Tr0ub4dour&3xtraLongPhrase!');
    expect(r.poolSize).toBe(26 + 26 + 10 + 33);
    expect(r.score).toBe(4);
    expect(r.crackTimeText).toBe('centuries');
  });

  it('computes entropy as length × log2(pool)', () => {
    // 8 lowercase letters → 8 * log2(26) ≈ 37.6 bits.
    const r = analyzePassword('abcdefgh');
    expect(r.entropyBits).toBeCloseTo(37.6, 1);
  });

  it('produces no warnings for an empty password', () => {
    expect(analyzePassword('').warnings).toEqual([]);
  });

  it('flags each missing character class independently', () => {
    expect(analyzePassword('alllowercase').warnings).toEqual(
      expect.arrayContaining(['No uppercase letters.', 'No digits.', 'No symbols.']),
    );
    const full = analyzePassword('Aa1!Aa1!');
    expect(full.warnings).not.toContain('No uppercase letters.');
    expect(full.warnings).not.toContain('No digits.');
    expect(full.warnings).not.toContain('No symbols.');
  });

  it('flags length only when shorter than 8, at the boundary', () => {
    expect(analyzePassword('Ab1!Ab1').warnings).toContain('Shorter than 8 characters.'); // 7 chars
    expect(analyzePassword('Ab1!Ab1!').warnings).not.toContain('Shorter than 8 characters.'); // 8 chars
  });

  it('flags a single repeated character and digits-only passwords', () => {
    expect(analyzePassword('aaaaaaaa').warnings).toContain('A single repeated character.');
    expect(analyzePassword('12345678').warnings).toContain('Digits only.');
    expect(analyzePassword('12345678').warnings).not.toContain('A single repeated character.');
  });

  it('treats a space-only password as zero entropy despite non-zero length', () => {
    const r = analyzePassword('    ');
    expect(r.poolSize).toBe(1);
    expect(r.entropyBits).toBe(0);
    expect(r.score).toBe(0);
  });

  it('counts non-ASCII characters (accents, emoji) toward the generic symbol pool', () => {
    // 'é' is outside a-z/A-Z/0-9/space, so it falls into the catch-all
    // "common ASCII symbols" pool bucket even though it isn't ASCII.
    const r = analyzePassword('héllo');
    expect(r.poolSize).toBe(26 + 33);

    // Emoji are counted by UTF-16 code units, so a single emoji (a surrogate
    // pair) contributes 2 to `length`, not 1 code point.
    const emoji = analyzePassword('😀');
    expect(emoji.length).toBe(2);
  });

  it('reports very short/weak passwords as crackable instantly', () => {
    expect(analyzePassword('a').crackTimeText).toBe('instantly');
  });
});
