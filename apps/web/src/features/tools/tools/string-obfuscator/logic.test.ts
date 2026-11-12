// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/string-obfuscator/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { DEFAULT_OBFUSCATE, obfuscate, type ObfuscateOptions } from './logic';

const o = (p: Partial<ObfuscateOptions>): ObfuscateOptions => ({
  ...DEFAULT_OBFUSCATE,
  ...p,
});

describe('string-obfuscator', () => {
  it('masks the middle', () => {
    expect(obfuscate('password', o({ keepFirst: 2, keepLast: 2 }))).toBe('pa****rd');
  });

  it('can hide the whole start', () => {
    expect(obfuscate('1234567890', o({ keepFirst: 0, keepLast: 4 }))).toBe('******7890');
  });

  it('keeps spaces when asked', () => {
    expect(obfuscate('ab cd', o({ keepFirst: 1, keepLast: 1, keepSpaces: true }))).toBe('a* *d');
  });

  it('uses a custom mask char', () => {
    expect(obfuscate('secret', o({ keepFirst: 1, keepLast: 1, maskChar: '•' }))).toBe('s••••t');
  });

  it('returns an empty string unchanged', () => {
    expect(obfuscate('', o({ keepFirst: 2, keepLast: 2 }))).toBe('');
  });

  it('reveals the whole string when the keep window exceeds its length', () => {
    // keepFirst + keepLast (6) is larger than the string length (2).
    expect(obfuscate('ab', o({ keepFirst: 3, keepLast: 3 }))).toBe('ab');
  });

  it('never reveals more characters than keepFirst + keepLast configures', () => {
    const input = 'abcdefghij'; // 10 chars
    const out = obfuscate(input, o({ keepFirst: 2, keepLast: 3, maskChar: '*' }));
    const revealed = Array.from(out).filter((ch) => ch !== '*').length;
    expect(revealed).toBe(2 + 3);
    expect(out).toBe('ab*****hij');
  });

  it('masks spaces too when keepSpaces is false', () => {
    expect(obfuscate('ab cd', o({ keepFirst: 1, keepLast: 1, keepSpaces: false }))).toBe('a***d');
  });

  it("falls back to '*' when maskChar is an empty string", () => {
    expect(obfuscate('secret', o({ keepFirst: 1, keepLast: 1, maskChar: '' }))).toBe('s****t');
  });

  it('treats multi-byte characters (emoji) as single units', () => {
    const input = '🔥🔥🔥🔥🔥'; // 5 emoji, each a surrogate pair
    const out = obfuscate(input, o({ keepFirst: 1, keepLast: 1, maskChar: '*' }));
    expect(Array.from(out)).toEqual(['🔥', '*', '*', '*', '🔥']);
  });
});
