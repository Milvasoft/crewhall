/**
 * Fractional index keys (doc 17 §4 "kesirli sıra"): strings that sort in byte order and
 * always leave room in between, so moving an item rewrites one row. Keys never end with
 * the smallest digit, which keeps a smaller key available.
 */
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length;

function digit(ch: string | undefined): number {
  if (ch === undefined) return 0;
  const i = DIGITS.indexOf(ch);
  if (i < 0) throw new Error(`invalid position character ${ch}`);
  return i;
}

/** A key strictly between `a` (or the start) and `b` (or the end). */
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    if (n > 0) return a.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = digit(a[0]);
  const db = b === null || b.length === 0 ? BASE : digit(b[0]);
  if (db - da > 1) return DIGITS[Math.floor((da + db) / 2)]!;
  if (b !== null && b.length > 1) return b[0]!;
  return DIGITS[da]! + midpoint(a.slice(1), null);
}

export function keyBetween(
  before: string | null | undefined,
  after: string | null | undefined,
): string {
  const a = before ?? '';
  const b = after ?? null;
  if (b !== null && a >= b) throw new Error(`keyBetween: ${a} >= ${b}`);
  return midpoint(a, b);
}
