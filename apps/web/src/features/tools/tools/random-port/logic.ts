// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/random-port/logic.ts. See THIRD_PARTY.md.
/**
 * Random port number generation. Pure and local; the RNG is injectable so it's
 * deterministic in tests.
 */

export interface PortOptions {
  min: number;
  max: number;
}

export const DEFAULT_PORT_OPTIONS: PortOptions = { min: 1024, max: 65535 };

export function randomPort(opts: PortOptions, rng: () => number = Math.random): number {
  const { min, max } = opts;
  if (min > max) throw new Error('min must be ≤ max.');
  return Math.floor(rng() * (max - min + 1)) + min;
}

/** Up to `count` unique ports; caps at the range size to avoid an infinite loop. */
export function randomPorts(
  count: number,
  opts: PortOptions,
  rng: () => number = Math.random,
): number[] {
  const span = opts.max - opts.min + 1;
  const target = Math.min(count, span);
  const seen = new Set<number>();
  while (seen.size < target) {
    seen.add(randomPort(opts, rng));
  }
  return [...seen];
}
