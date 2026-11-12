// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/numeronym-generator/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { numeronym, numeronymText } from './logic';

describe('numeronym-generator', () => {
  it('makes classic numeronyms', () => {
    expect(numeronym('internationalization')).toBe('i18n');
    expect(numeronym('accessibility')).toBe('a11y');
    expect(numeronym('localization')).toBe('l10n');
    expect(numeronym('kubernetes')).toBe('k8s');
  });

  it('leaves short words alone', () => {
    expect(numeronym('cat')).toBe('cat');
    expect(numeronym('go')).toBe('go');
  });

  it('transforms words within a sentence', () => {
    expect(numeronymText('accessibility and localization')).toBe('a11y and l10n');
  });

  it('is boundary-exact: 3 letters unchanged, 4 letters abbreviated', () => {
    expect(numeronym('cat')).toBe('cat'); // 3 letters: unchanged
    expect(numeronym('word')).toBe('w2d'); // 4 letters: first abbreviated word length
  });

  it('returns empty string unchanged', () => {
    expect(numeronym('')).toBe('');
    expect(numeronymText('')).toBe('');
  });

  it('leaves text with only short words unchanged', () => {
    expect(numeronymText('a cat and a dog')).toBe('a cat and a dog');
  });

  it('does not touch non-ASCII letters (regex is [A-Za-z] only)', () => {
    // "café" breaks the ASCII run at "é", leaving only the 3-letter "caf".
    expect(numeronymText('café')).toBe('café');
  });

  it('treats digits/punctuation as word boundaries, not letters to count', () => {
    // Digits split "hello123world" into two separate 5-letter runs, each
    // abbreviated on its own (not as one combined word).
    expect(numeronymText('hello123world!!!')).toBe('h3o123w3d!!!');
  });
});
