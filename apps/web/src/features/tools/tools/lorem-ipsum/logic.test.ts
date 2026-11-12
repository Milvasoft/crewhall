// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/lorem-ipsum/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { generateLorem } from './logic';

describe('lorem-ipsum', () => {
  it('generates the requested number of paragraphs', () => {
    expect(generateLorem(3, 'paragraphs').split('\n\n')).toHaveLength(3);
  });

  it("can start with 'Lorem ipsum'", () => {
    expect(generateLorem(2, 'sentences', true).startsWith('Lorem ipsum')).toBe(true);
  });

  it('generates a word count', () => {
    expect(generateLorem(10, 'words').split(' ')).toHaveLength(10);
  });

  it('clamps the count to a minimum of 1 for zero or negative input', () => {
    expect(generateLorem(0, 'words').split(' ')).toHaveLength(1);
    expect(generateLorem(-5, 'words').split(' ')).toHaveLength(1);
  });

  it('clamps the count to a maximum of 1000', () => {
    expect(generateLorem(5000, 'words').split(' ')).toHaveLength(1000);
  });

  it("can omit the leading 'Lorem ipsum' phrase", () => {
    const words = generateLorem(20, 'words', false).split(' ');
    expect(words).toHaveLength(20);
    // Every generated token must come from the known word pool (structural
    // check, not exact text since the output is random).
    for (const w of words) {
      expect(w.toLowerCase()).toMatch(/^[a-z]+$/);
    }
  });

  it('capitalizes only the first character of a word-count result', () => {
    const out = generateLorem(5, 'words', false);
    expect(out[0]).toBe(out[0]!.toUpperCase());
    expect(out.slice(1)).toBe(out.slice(1).toLowerCase());
  });

  it('produces exactly one sentence-ending period per sentence', () => {
    const out = generateLorem(5, 'sentences');
    expect((out.match(/\./g) ?? []).length).toBe(5);
  });

  it('starts a paragraph result with the fixed Lorem ipsum opener', () => {
    const out = generateLorem(2, 'paragraphs', true);
    expect(out.startsWith('Lorem ipsum dolor sit amet, consectetur adipiscing elit.')).toBe(true);
    expect(out.split('\n\n')).toHaveLength(2);
  });
});
