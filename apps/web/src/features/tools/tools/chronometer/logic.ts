// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/chronometer/logic.ts. See THIRD_PARTY.md.
/**
 * Stopwatch time formatting. Pure and local.
 */

/** Format milliseconds as `HH:MM:SS.cs` (centiseconds). */
export function formatStopwatch(ms: number): string {
  const total = Math.max(0, Math.floor(ms));
  const cs = Math.floor((total % 1000) / 10);
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60000) % 60;
  const h = Math.floor(total / 3600000);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(h)}:${p2(m)}:${p2(s)}.${p2(cs)}`;
}
