// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/number-base/logic.ts. See THIRD_PARTY.md.
/**
 * Arbitrary-base integer conversion, backed by BigInt so it's exact for
 * numbers far beyond Number.MAX_SAFE_INTEGER. Pure and local.
 */

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';

export function isValidBase(base: number): boolean {
  return Number.isInteger(base) && base >= 2 && base <= 36;
}

/** Parse an integer string written in `base` into a BigInt. */
export function parseInBase(input: string, base: number): bigint {
  if (!isValidBase(base)) throw new Error('Base must be between 2 and 36.');
  let s = input.trim().toLowerCase();
  if (!s) throw new Error('Enter a number.');

  let negative = false;
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  // Tolerate common prefixes when they match the chosen base.
  if (base === 16 && s.startsWith('0x')) s = s.slice(2);
  else if (base === 2 && s.startsWith('0b')) s = s.slice(2);
  else if (base === 8 && s.startsWith('0o')) s = s.slice(2);
  s = s.replace(/[_\s]/g, '');

  if (!s) throw new Error('Enter a number.');

  const bigBase = BigInt(base);
  let value = 0n;
  for (const ch of s) {
    const digit = DIGITS.indexOf(ch);
    if (digit < 0 || digit >= base) {
      throw new Error(`Invalid digit "${ch}" for base ${base}.`);
    }
    value = value * bigBase + BigInt(digit);
  }
  return negative ? -value : value;
}

/** Render a BigInt in `base` (lowercase digits). */
export function toBase(value: bigint, base: number): string {
  if (!isValidBase(base)) throw new Error('Base must be between 2 and 36.');
  return value.toString(base);
}

export interface BaseRow {
  base: number;
  label: string;
  value: string;
}

export const COMMON_BASES: { base: number; label: string }[] = [
  { base: 2, label: 'Binary' },
  { base: 8, label: 'Octal' },
  { base: 10, label: 'Decimal' },
  { base: 16, label: 'Hex' },
];

/** Convert `input`/`fromBase` into the four common bases. */
export function convertBases(input: string, fromBase: number): BaseRow[] {
  const value = parseInBase(input, fromBase);
  return COMMON_BASES.map(({ base, label }) => ({
    base,
    label,
    value: toBase(value, base),
  }));
}
