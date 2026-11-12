// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/unicode-inspector/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { inspect } from './logic';

describe('unicode-inspector', () => {
  it('inspects ASCII', () => {
    const a = inspect('A')[0]!;
    expect(a.codePoint).toBe(65);
    expect(a.hex).toBe('U+0041');
    expect(a.utf8).toBe('41');
    expect(a.htmlEntity).toBe('&#65;');
  });

  it('handles astral (emoji) code points', () => {
    const chars = inspect('😀');
    expect(chars).toHaveLength(1); // one code point, not two UTF-16 units
    expect(chars[0]!.codePoint).toBe(128512);
    expect(chars[0]!.hex).toBe('U+1F600');
    expect(chars[0]!.utf8).toBe('F0 9F 98 80');
    expect(chars[0]!.utf16.split(' ')).toHaveLength(2); // surrogate pair
  });

  it('computes multibyte UTF-8', () => {
    expect(inspect('é')[0]!.utf8).toBe('C3 A9');
  });

  it('returns an empty array for empty input', () => {
    expect(inspect('')).toEqual([]);
  });

  it('computes a 3-byte UTF-8 sequence', () => {
    expect(inspect('€')[0]!.utf8).toBe('E2 82 AC');
  });

  it('treats a combining mark as its own code point, separate from the base letter', () => {
    const decomposed = 'é'; // "e" + combining acute accent
    const chars = inspect(decomposed);
    expect(chars).toHaveLength(2);
    expect(chars[0]!.codePoint).toBe(0x65);
    expect(chars[1]!.codePoint).toBe(0x301);
    expect(chars[1]!.hex).toBe('U+0301');
  });

  it('splits a ZWJ emoji sequence into its constituent code points, not one grapheme', () => {
    // family: man, ZWJ, woman, ZWJ, girl, ZWJ, boy => 7 code points
    const family = '👨‍👩‍👧‍👦';
    const chars = inspect(family);
    expect(chars).toHaveLength(7);
    expect(chars[1]!.codePoint).toBe(0x200d);
    expect(chars[1]!.hex).toBe('U+200D');
  });

  it('single UTF-16 code unit for BMP characters vs. a surrogate pair for astral ones', () => {
    expect(inspect('A')[0]!.utf16.split(' ')).toHaveLength(1);
    expect(inspect('😀')[0]!.utf16).toBe('D83D DE00');
  });
});
