// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/iban-validator/logic.ts. See THIRD_PARTY.md.
/**
 * IBAN validation (ISO 13616, mod-97) and parsing. Pure and local.
 */

// Expected total IBAN length per country (common set).
export const IBAN_LENGTHS: Record<string, number> = {
  AD: 24,
  AE: 23,
  AL: 28,
  AT: 20,
  AZ: 28,
  BA: 20,
  BE: 16,
  BG: 22,
  BH: 22,
  BR: 29,
  CH: 21,
  CR: 22,
  CY: 28,
  CZ: 24,
  DE: 22,
  DK: 18,
  DO: 28,
  EE: 20,
  ES: 24,
  FI: 18,
  FO: 18,
  FR: 27,
  GB: 22,
  GE: 22,
  GI: 23,
  GL: 18,
  GR: 27,
  GT: 28,
  HR: 21,
  HU: 28,
  IE: 22,
  IL: 23,
  IS: 26,
  IT: 27,
  JO: 30,
  KW: 30,
  KZ: 20,
  LB: 28,
  LI: 21,
  LT: 20,
  LU: 20,
  LV: 21,
  MC: 27,
  MD: 24,
  ME: 22,
  MK: 19,
  MR: 27,
  MT: 31,
  MU: 30,
  NL: 18,
  NO: 15,
  PK: 24,
  PL: 28,
  PS: 29,
  PT: 25,
  QA: 29,
  RO: 24,
  RS: 22,
  SA: 24,
  SE: 24,
  SI: 19,
  SK: 24,
  SM: 27,
  TN: 24,
  TR: 26,
  UA: 29,
  VG: 24,
  XK: 20,
};

export interface IbanResult {
  valid: boolean;
  countryCode: string;
  checkDigits: string;
  bban: string;
  formatted: string;
  lengthExpected?: number;
  error?: string;
}

function normalize(input: string): string {
  return input.replace(/[\s]/g, '').toUpperCase();
}

/** mod-97 over the rearranged, digit-expanded IBAN; valid when the result is 1. */
function mod97(iban: string): number {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const expanded = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let remainder = 0;
  for (const ch of expanded) {
    remainder = (remainder * 10 + Number(ch)) % 97;
  }
  return remainder;
}

export function parseIban(input: string): IbanResult {
  const iban = normalize(input);
  const base: IbanResult = {
    valid: false,
    countryCode: iban.slice(0, 2),
    checkDigits: iban.slice(2, 4),
    bban: iban.slice(4),
    formatted: iban.replace(/(.{4})/g, '$1 ').trim(),
  };

  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(iban)) {
    return { ...base, error: 'Not a well-formed IBAN.' };
  }

  const expected = IBAN_LENGTHS[base.countryCode];
  base.lengthExpected = expected;
  if (expected && iban.length !== expected) {
    return {
      ...base,
      error: `${base.countryCode} IBANs are ${expected} characters (got ${iban.length}).`,
    };
  }

  base.valid = mod97(iban) === 1;
  if (!base.valid) base.error = 'Checksum failed — the IBAN is invalid.';
  return base;
}

export function isValidIban(input: string): boolean {
  return parseIban(input).valid;
}
