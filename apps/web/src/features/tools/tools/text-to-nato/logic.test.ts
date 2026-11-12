// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/text-to-nato/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { textToNato } from './logic';

describe('text-to-nato', () => {
  it('spells letters and digits', () => {
    expect(textToNato('abc')).toBe('Alfa Bravo Charlie');
    expect(textToNato('A1')).toBe('Alfa One');
  });

  it('handles spaces and punctuation', () => {
    expect(textToNato('hi.')).toBe('Hotel India Stop');
  });

  it('brackets unknown characters', () => {
    expect(textToNato('é')).toBe('[é]');
  });

  it('supports a custom separator', () => {
    expect(textToNato('ab', ' / ')).toBe('Alfa / Bravo');
  });

  it('returns an empty string for empty input', () => {
    expect(textToNato('')).toBe('');
  });

  it('is case-insensitive, matching uppercase input too', () => {
    expect(textToNato('ABC')).toBe('Alfa Bravo Charlie');
  });

  it('spells the full digit range', () => {
    expect(textToNato('0123456789')).toBe('Zero One Two Three Four Five Six Seven Eight Nine');
  });

  it('brackets unrecognized punctuation and whitespace characters', () => {
    expect(textToNato('!')).toBe('[!]');
    expect(textToNato('\t')).toBe('[\t]');
  });

  it('brackets multiple adjacent unknown characters independently', () => {
    expect(textToNato('é!')).toBe('[é] [!]');
  });

  it('renders a literal space as (space)', () => {
    expect(textToNato('a b')).toBe('Alfa (space) Bravo');
  });
});
