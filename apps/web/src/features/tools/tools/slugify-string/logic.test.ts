// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/slugify-string/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { slugify } from './logic';

describe('slugify-string', () => {
  it('slugifies typical titles', () => {
    expect(slugify('Hello World!')).toBe('hello-world');
    expect(slugify('  Foo_Bar  ')).toBe('foo-bar');
    expect(slugify('Too Much Tools: The Sequel')).toBe('too-much-tools-the-sequel');
  });

  it('strips diacritics', () => {
    expect(slugify('Héllo Wörld')).toBe('hello-world');
    expect(slugify('Crème brûlée')).toBe('creme-brulee');
  });

  it('keeps Turkish letters as their base letters', () => {
    expect(slugify('Işık ağacı, çiçek ve şeker')).toBe('isik-agaci-cicek-ve-seker');
    expect(slugify('İstanbul Üsküdar')).toBe('istanbul-uskudar');
  });

  it('respects options', () => {
    expect(slugify('Hello World', { separator: '_' })).toBe('hello_world');
    expect(slugify('Hello World', { lowercase: false })).toBe('Hello-World');
  });

  it('collapses separators', () => {
    expect(slugify('a --- b ___ c')).toBe('a-b-c');
  });

  it('handles empty and separator-only input', () => {
    expect(slugify('')).toBe('');
    expect(slugify('!!!')).toBe('');
  });

  it('strips emoji (surrogate pairs) like any other non-alphanumeric run', () => {
    expect(slugify('Hello 😀 World')).toBe('hello-world');
  });

  it('is idempotent: slugifying an already-slugified string is a no-op', () => {
    const slug = slugify('Hello World!');
    expect(slugify(slug)).toBe(slug);
  });

  it('produces no separators at all when separator is empty', () => {
    expect(slugify('a b c', { separator: '' })).toBe('abc');
  });
});
