// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/roman-numeral-converter/logic.ts. See THIRD_PARTY.md.
/**
 * Roman numeral conversion (1–3999, standard subtractive notation). Pure and local.
 */

const TABLE: [number, string][] = [
  [1000, 'M'],
  [900, 'CM'],
  [500, 'D'],
  [400, 'CD'],
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
];

export const MIN_ROMAN = 1;
export const MAX_ROMAN = 3999;

export function intToRoman(value: number): string {
  if (!Number.isInteger(value)) throw new Error('Enter a whole number.');
  if (value < MIN_ROMAN || value > MAX_ROMAN) {
    throw new Error(`Roman numerals cover ${MIN_ROMAN}–${MAX_ROMAN}.`);
  }
  let n = value;
  let out = '';
  for (const [num, sym] of TABLE) {
    while (n >= num) {
      out += sym;
      n -= num;
    }
  }
  return out;
}

export function romanToInt(input: string): number {
  const s = input.trim().toUpperCase();
  if (!s) throw new Error('Enter a Roman numeral.');
  if (!/^[MDCLXVI]+$/.test(s)) throw new Error('Only the letters M D C L X V I are allowed.');

  const value: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const cur = value[s[i]!]!;
    const next = value[s[i + 1] ?? ''] ?? 0;
    total += cur < next ? -cur : cur;
  }

  // Round-trip to reject malformed numerals like "IIII" or "VX".
  if (intToRoman(total) !== s) {
    throw new Error('Not a valid Roman numeral.');
  }
  return total;
}
