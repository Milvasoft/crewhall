// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/binary-text/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { binaryToText, textToBinary } from './logic';

describe('binary-text', () => {
  it('encodes ASCII to 8-bit binary', () => {
    expect(textToBinary('A')).toBe('01000001');
    expect(textToBinary('Hi')).toBe('01001000 01101001');
  });

  it('round-trips text through binary', () => {
    const s = 'Hello, world!';
    expect(binaryToText(textToBinary(s))).toBe(s);
  });

  it('handles multi-byte UTF-8 characters', () => {
    const s = 'é😀ü';
    expect(binaryToText(textToBinary(s))).toBe(s);
  });

  it('decodes an unbroken bit run', () => {
    expect(binaryToText('0100100001101001')).toBe('Hi');
  });

  it('rejects invalid characters and bad lengths', () => {
    expect(() => binaryToText('0101 2')).toThrow();
    expect(() => binaryToText('0101')).toThrow();
  });

  it('returns empty for empty input', () => {
    expect(textToBinary('')).toBe('');
    expect(binaryToText('   ')).toBe('');
  });

  it('encodes whitespace-only text (not treated as empty)', () => {
    expect(textToBinary(' ')).toBe('00100000');
    expect(binaryToText('00100000')).toBe(' ');
  });

  it('supports custom separators', () => {
    expect(textToBinary('Hi', '')).toBe('0100100001101001');
    expect(textToBinary('Hi', '\n')).toBe('01001000\n01101001');
  });

  it('round-trips an emoji (surrogate pair) as 4 UTF-8 bytes', () => {
    const s = '😀';
    const bin = textToBinary(s);
    expect(bin.split(' ')).toHaveLength(4);
    expect(binaryToText(bin)).toBe(s);
  });

  it('decodes groups separated by mixed whitespace (tabs, newlines)', () => {
    expect(binaryToText('01001000\t01101001\n')).toBe('Hi');
  });

  it('rejects a bit count that is not a multiple of 8 even with valid separators', () => {
    expect(() => binaryToText('0000000')).toThrow(); // 7 bits
  });
});
