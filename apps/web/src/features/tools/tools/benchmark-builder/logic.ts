// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/benchmark-builder/logic.ts. See THIRD_PARTY.md.
/**
 * Compare benchmark suites by mean and variance. Pure and local.
 */

export interface Suite {
  name: string;
  values: number[];
}

export interface SuiteStat {
  name: string;
  samples: number;
  mean: number;
  variance: number;
  rank: number;
  /** How much slower than the fastest suite (absolute). */
  deltaFromBest: number;
  /** Ratio to the fastest suite's mean (1 = fastest). */
  factor: number;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function variance(values: number[], m: number): number {
  return values.reduce((a, b) => a + (b - m) ** 2, 0) / values.length;
}

/** Rank suites fastest-first (lowest mean), with deltas relative to the best. */
export function computeStats(suites: Suite[]): SuiteStat[] {
  const withStats = suites
    .filter((s) => s.values.length > 0)
    .map((s) => {
      const m = mean(s.values);
      return { name: s.name, samples: s.values.length, mean: m, variance: variance(s.values, m) };
    });

  const sorted = [...withStats].sort((a, b) => a.mean - b.mean);
  const best = sorted[0]?.mean ?? 0;

  return sorted.map((s, i) => ({
    ...s,
    mean: round(s.mean),
    variance: round(s.variance),
    rank: i + 1,
    deltaFromBest: round(s.mean - best),
    factor: best === 0 ? 1 : round(s.mean / best),
  }));
}

export function toMarkdownTable(stats: SuiteStat[], unit = ''): string {
  const u = unit ? ` (${unit})` : '';
  const header = `| Position | Suite | Samples | Mean${u} | Variance |\n| --- | --- | --- | --- | --- |`;
  const rows = stats.map((s) => {
    const extra = s.rank === 1 ? '' : ` (+${s.deltaFromBest} ; ×${s.factor})`;
    return `| ${s.rank} | ${s.name} | ${s.samples} | ${s.mean}${extra} | ${s.variance} |`;
  });
  return [header, ...rows].join('\n');
}

export function toBulletList(stats: SuiteStat[], unit = ''): string {
  const u = unit ? ` ${unit}` : '';
  return stats
    .map((s) => {
      const extra = s.rank === 1 ? '' : ` (+${s.deltaFromBest}${u} ; ×${s.factor})`;
      return `- ${s.name}: ${s.mean}${u}${extra}`;
    })
    .join('\n');
}
