// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/phone-parser/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { parsePhone } from './logic';

describe('phone-parser', () => {
  it('parses an international number', () => {
    const r = parsePhone('+1 415 555 2671');
    expect(r.valid).toBe(true);
    const get = (l: string) => r.fields.find((f) => f.label === l)?.value;
    expect(get('Country')).toBe('US');
    expect(get('Calling code')).toBe('+1');
    expect(get('E.164')).toBe('+14155552671');
  });

  it('uses a default country for national input', () => {
    const r = parsePhone('020 7946 0958', 'GB');
    expect(r.fields.find((f) => f.label === 'Country')?.value).toBe('GB');
    expect(r.fields.find((f) => f.label === 'E.164')?.value).toBe('+442079460958');
  });

  it('returns not-valid for junk', () => {
    expect(parsePhone('abc').valid).toBe(false);
  });

  it('returns an empty result (no fields) for empty or whitespace-only input', () => {
    expect(parsePhone('')).toEqual({ valid: false, possible: false, fields: [] });
    expect(parsePhone('   ')).toEqual({ valid: false, possible: false, fields: [] });
  });

  it("distinguishes 'possible' from 'valid' for a plausible-but-unassigned number", () => {
    // A 555 number with no area code: right shape, not a real allocation.
    const r = parsePhone('+1 555 019 0000');
    expect(r.valid).toBe(false);
    expect(r.possible).toBe(true);
  });

  it('populates every field for a fully valid, fictional (555) number', () => {
    // 555-01XX is the block reserved by NANPA for fictional use.
    const r = parsePhone('+1 202 555 0173');
    const get = (l: string) => r.fields.find((f) => f.label === l)?.value;
    expect(r.valid).toBe(true);
    expect(get('E.164')).toBe('+12025550173');
    expect(get('National number')).toBe('2025550173');
    expect(get('Country')).toBe('US');
    expect(get('URI')).toBe('tel:+12025550173');
    expect(get('Type')).not.toBe('Unknown');
  });

  it('reports invalid for a too-short number even with a default country given', () => {
    const r = parsePhone('123', 'US');
    expect(r.valid).toBe(false);
    expect(r.possible).toBe(false);
  });
});
