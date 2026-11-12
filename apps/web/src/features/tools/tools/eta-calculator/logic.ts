// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/eta-calculator/logic.ts. See THIRD_PARTY.md.
/**
 * Estimate how long a task will take and when it will finish, from a measured
 * consumption rate. Pure and local.
 */

export const TIME_UNITS: { id: string; label: string; seconds: number }[] = [
  { id: 'second', label: 'seconds', seconds: 1 },
  { id: 'minute', label: 'minutes', seconds: 60 },
  { id: 'hour', label: 'hours', seconds: 3600 },
  { id: 'day', label: 'days', seconds: 86400 },
];

export interface EtaResult {
  durationSeconds: number;
  endMs: number;
}

/**
 * `total` items remaining, of which `amount` are consumed every `span`
 * `unitSeconds`. Returns the total duration and projected end time.
 */
export function computeEta(
  total: number,
  amount: number,
  span: number,
  unitSeconds: number,
  startMs: number,
): EtaResult {
  const ratePerSecond = amount / (span * unitSeconds);
  if (!Number.isFinite(ratePerSecond) || ratePerSecond <= 0) {
    throw new Error('The consumption rate must be greater than zero.');
  }
  const durationSeconds = total / ratePerSecond;
  return { durationSeconds, endMs: startMs + durationSeconds * 1000 };
}

/** Format a duration in seconds as e.g. "5 hours 10 minutes". */
export function formatDuration(totalSeconds: number): string {
  const s = Math.round(totalSeconds);
  const parts: string[] = [];
  const units: [number, string][] = [
    [86400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
    [1, 'second'],
  ];
  let rem = s;
  for (const [size, name] of units) {
    const n = Math.floor(rem / size);
    if (n > 0) {
      parts.push(`${n} ${name}${n === 1 ? '' : 's'}`);
      rem -= n * size;
    }
  }
  return parts.slice(0, 2).join(' ') || '0 seconds';
}
