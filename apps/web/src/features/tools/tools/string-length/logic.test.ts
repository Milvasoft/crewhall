// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/string-length/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { computeTextStats } from './logic';

describe('computeTextStats', () => {
  it('counts an empty string as all zeros', () => {
    const s = computeTextStats('');
    expect(s.characters).toBe(0);
    expect(s.words).toBe(0);
    expect(s.lines).toBe(0);
    expect(s.bytes).toBe(0);
  });

  it('counts words and lines', () => {
    const s = computeTextStats('hello world\nsecond line');
    expect(s.words).toBe(4);
    expect(s.lines).toBe(2);
  });

  it('counts UTF-8 bytes vs code points for multibyte chars', () => {
    const s = computeTextStats('é😀');
    // 'é' = 2 bytes, '😀' = 4 bytes
    expect(s.bytes).toBe(6);
    // Two code points, but UTF-16 length is 3 (emoji is a surrogate pair).
    expect(s.characters).toBe(2);
    expect(s.utf16).toBe(3);
  });

  it('excludes whitespace from charactersNoSpaces', () => {
    const s = computeTextStats('a b\tc\n');
    expect(s.charactersNoSpaces).toBe(3);
  });

  it('counts sentences', () => {
    expect(computeTextStats('One. Two! Three?').sentences).toBe(3);
  });

  it('counts text without terminal punctuation as zero sentences', () => {
    expect(computeTextStats('Hello world').sentences).toBe(0);
  });

  it('treats whitespace-only input as one blank line with no words', () => {
    const s = computeTextStats('   ');
    expect(s.words).toBe(0);
    expect(s.lines).toBe(1);
    expect(s.characters).toBe(3);
    expect(s.charactersNoSpaces).toBe(0);
  });

  it('does not merge combining marks into a single code point', () => {
    // "e" + combining acute accent (U+0301) is two code points, not the
    // precomposed "é" — this function counts code points, not graphemes.
    const combining = 'é';
    const s = computeTextStats(combining);
    expect(s.characters).toBe(2);
    expect(s.utf16).toBe(2);
    expect(s.bytes).toBe(3); // 'e' (1 byte) + U+0301 (2 bytes in UTF-8)
  });

  it('counts an empty line for each newline-delimited segment, including a trailing newline', () => {
    expect(computeTextStats('a\nb\n').lines).toBe(3);
  });

  it('counts a lone astral character as one code point but two UTF-16 units', () => {
    const s = computeTextStats('𝕊');
    expect(s.characters).toBe(1);
    expect(s.utf16).toBe(2);
    expect(s.bytes).toBe(4);
  });
});
