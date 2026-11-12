// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/percentage-calculator/logic.ts. See THIRD_PARTY.md.
/**
 * The three everyday percentage questions. Pure and local.
 */

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** What is `percent`% of `value`? */
export function percentOf(percent: number, value: number): number {
  return round((percent / 100) * value);
}

/** `part` is what percent of `whole`? */
export function whatPercent(part: number, whole: number): number {
  if (whole === 0) throw new Error("The whole can't be zero.");
  return round((part / whole) * 100);
}

/** Percentage change from `from` to `to` (positive = increase). */
export function percentChange(from: number, to: number): number {
  if (from === 0) throw new Error("The starting value can't be zero.");
  return round(((to - from) / Math.abs(from)) * 100);
}
