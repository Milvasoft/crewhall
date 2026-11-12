// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/list-converter/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS, listStats, transformList, type ListOptions } from './logic';

const opts = (o: Partial<ListOptions>): ListOptions => ({ ...DEFAULT_OPTIONS, ...o });

describe('list-converter', () => {
  it('trims and removes empty lines by default', () => {
    expect(transformList('  a  \n\n b \n', DEFAULT_OPTIONS)).toBe('a\nb');
  });

  it('dedupes and sorts', () => {
    expect(transformList('b\na\nb\nc', opts({ dedupe: true, sort: 'asc' }))).toBe('a\nb\nc');
  });

  it('sorts numerically', () => {
    expect(transformList('10\n2\n1', opts({ sort: 'numeric' }))).toBe('1\n2\n10');
  });

  it('applies affixes and a custom separator', () => {
    expect(transformList('a\nb', opts({ prefix: "'", suffix: "'", separator: ', ' }))).toBe(
      "'a', 'b'",
    );
  });

  it('uppercases and reverses', () => {
    expect(transformList('a\nb', opts({ caseTransform: 'upper', reverse: true }))).toBe('B\nA');
  });

  it('sorts by length and descending order', () => {
    expect(transformList('bbb\na\ncc', opts({ sort: 'length' }))).toBe('a\ncc\nbbb');
    expect(transformList('a\nb\nc', opts({ sort: 'desc' }))).toBe('c\nb\na');
  });

  it('dedupes case-insensitively when case transform runs first', () => {
    // caseTransform is applied before dedupe, so 'A' and 'a' collapse together.
    expect(transformList('A\na\nB', opts({ caseTransform: 'lower', dedupe: true }))).toBe('a\nb');
  });

  it('returns an empty string for empty input', () => {
    expect(transformList('', DEFAULT_OPTIONS)).toBe('');
  });

  it('keeps blank lines when removeEmpty is false', () => {
    expect(transformList('a\n\nb', opts({ removeEmpty: false, trim: false }))).toBe('a\n\nb');
  });

  it('computes stats: line count and unique count', () => {
    expect(listStats('a\na\nb\n\n')).toEqual({ lines: 3, unique: 2 });
    expect(listStats('')).toEqual({ lines: 0, unique: 0 });
  });
});
