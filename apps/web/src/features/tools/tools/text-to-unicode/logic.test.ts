// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/text-to-unicode/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { decodeUnicode, encodeUnicode } from './logic';

describe('text-to-unicode', () => {
  it('encodes in each format', () => {
    expect(encodeUnicode('AB', 'js')).toBe('\\u0041\\u0042');
    expect(encodeUnicode('A', 'es6')).toBe('\\u{41}');
    expect(encodeUnicode('A', 'u+')).toBe('U+0041');
    expect(encodeUnicode('A', 'html')).toBe('&#x41;');
  });

  it('decodes each format', () => {
    expect(decodeUnicode('\\u0041\\u0042')).toBe('AB');
    expect(decodeUnicode('\\u{1f600}')).toBe('😀');
    expect(decodeUnicode('U+0041 U+0042')).toBe('AB');
    expect(decodeUnicode('&#x41;&#66;')).toBe('AB');
  });

  it('round-trips text including astral characters', () => {
    const s = 'Héllo 😀 世界';
    expect(decodeUnicode(encodeUnicode(s, 'js'))).toBe(s);
    expect(decodeUnicode(encodeUnicode(s, 'es6'))).toBe(s);
  });

  it('defaults to the js format when none is given', () => {
    expect(encodeUnicode('A')).toBe('\\u0041');
  });

  it('encodes an astral character (surrogate pair) as two \\u escapes in js format', () => {
    // "js" format walks UTF-16 code units, so an emoji outside the BMP is
    // split into its surrogate pair, unlike the code-point-aware formats.
    expect(encodeUnicode('😀', 'js')).toBe('\\ud83d\\ude00');
    expect(encodeUnicode('😀', 'es6')).toBe('\\u{1f600}');
  });

  it('joins html-format escapes with no separator, unlike u+', () => {
    expect(encodeUnicode('AB', 'html')).toBe('&#x41;&#x42;');
    expect(encodeUnicode('AB', 'u+')).toBe('U+0041 U+0042');
  });

  it('round-trips a combining mark through the es6 format', () => {
    const s = 'é'; // "e" + combining acute accent, two separate code points
    expect(decodeUnicode(encodeUnicode(s, 'es6'))).toBe(s);
  });

  it('leaves text with no recognized escapes unchanged', () => {
    expect(decodeUnicode('hello world')).toBe('hello world');
    expect(decodeUnicode('')).toBe('');
  });

  it('leaves a malformed/incomplete escape sequence untouched', () => {
    // Only 2 hex digits after \\u: doesn't match the required 4-digit \\uXXXX form.
    expect(decodeUnicode('\\u12 hi')).toBe('\\u12 hi');
  });

  it('decodes a mix of different escape formats in a single string', () => {
    // The U+XXXX pattern also swallows one trailing whitespace character, so
    // the space between "U+0042" and "&#x43;" is consumed by that match.
    expect(decodeUnicode('\\u0041 U+0042 &#x43;')).toBe('A BC');
  });
});
