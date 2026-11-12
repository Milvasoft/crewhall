// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/iban-validator/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { isValidIban, parseIban } from './logic';

describe('iban-validator', () => {
  it('validates real IBANs', () => {
    expect(isValidIban('GB82 WEST 1234 5698 7654 32')).toBe(true);
    expect(isValidIban('DE89 3704 0044 0532 0130 00')).toBe(true);
    expect(isValidIban('FR14 2004 1010 0505 0001 3M02 606')).toBe(true);
  });

  it('parses components and formats', () => {
    const r = parseIban('de89370400440532013000');
    expect(r.countryCode).toBe('DE');
    expect(r.checkDigits).toBe('89');
    expect(r.formatted).toBe('DE89 3704 0044 0532 0130 00');
    expect(r.valid).toBe(true);
  });

  it('rejects bad checksums and lengths', () => {
    expect(isValidIban('GB82 WEST 1234 5698 7654 33')).toBe(false);
    expect(parseIban('DE00 1234').error).toBeTruthy();
  });

  it('rejects malformed input', () => {
    expect(parseIban('hello').error).toBeTruthy();
  });

  it('rejects empty and whitespace-only input', () => {
    expect(parseIban('').error).toBeTruthy();
    expect(parseIban('').valid).toBe(false);
    expect(parseIban('   ').error).toBeTruthy();
  });

  it('validates the shortest known IBAN length (Norway, 15 chars)', () => {
    const r = parseIban('NO93 8601 1117 947');
    expect(r.lengthExpected).toBe(15);
    expect(r.valid).toBe(true);
  });

  it('validates the longest known IBAN length (Malta, 31 chars)', () => {
    const r = parseIban('MT84 MALT 0110 0001 2345 MTLC AST0 01S');
    expect(r.lengthExpected).toBe(31);
    expect(r.valid).toBe(true);
  });

  it('falls back to checksum-only validation for a country not in the length table', () => {
    // "XX" is not a real/registered country code, so no length is enforced;
    // the check digits below satisfy mod-97 for this body.
    const r = parseIban('XX361234567890');
    expect(r.lengthExpected).toBeUndefined();
    expect(r.error).toBeUndefined();
    expect(r.valid).toBe(true);
  });

  it('reports the expected length in the error message when length mismatches', () => {
    const r = parseIban('NO938601111794700');
    expect(r.countryCode).toBe('NO');
    expect(r.valid).toBe(false);
    expect(r.error).toContain('15');
  });

  it("isValidIban mirrors parseIban's valid flag", () => {
    expect(isValidIban('')).toBe(false);
    expect(isValidIban('NO93 8601 1117 947')).toBe(true);
  });
});
