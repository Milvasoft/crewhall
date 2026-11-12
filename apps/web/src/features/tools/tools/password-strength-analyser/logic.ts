// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/password-strength-analyser/logic.ts. See THIRD_PARTY.md.
/**
 * Password strength estimate based on character-set entropy. This is a fast,
 * transparent heuristic (not a dictionary cracker like zxcvbn): entropy =
 * length × log2(pool size), with the pool derived from the character classes
 * used. Pure and local — the password never leaves the browser.
 */

const GUESSES_PER_SECOND = 1e10; // offline attack on a fast hash, ~10B/s

export interface StrengthResult {
  length: number;
  poolSize: number;
  entropyBits: number;
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
  crackTimeText: string;
  warnings: string[];
}

const LABELS = ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'] as const;

function poolSize(pw: string): number {
  let size = 0;
  if (/[a-z]/.test(pw)) size += 26;
  if (/[A-Z]/.test(pw)) size += 26;
  if (/[0-9]/.test(pw)) size += 10;
  if (/[ ]/.test(pw)) size += 1;
  if (/[^a-zA-Z0-9 ]/.test(pw)) size += 33; // common ASCII symbols
  return size;
}

function humanizeSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds > 3.15e12) return 'centuries';
  if (seconds < 1) return 'instantly';
  const units: [number, string][] = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [365, 'day'],
    [Infinity, 'year'],
  ];
  let value = seconds;
  for (const [step, name] of units) {
    if (value < step) {
      const n = Math.round(value);
      return `${n} ${name}${n === 1 ? '' : 's'}`;
    }
    value /= step;
  }
  return 'centuries';
}

export function analyzePassword(pw: string): StrengthResult {
  const length = pw.length;
  const pool = poolSize(pw);
  const entropy = length === 0 ? 0 : length * Math.log2(pool || 1);

  // Average guesses to crack ~ half the keyspace.
  const seconds = Math.pow(2, entropy - 1) / GUESSES_PER_SECOND;

  let score: StrengthResult['score'];
  if (entropy < 28) score = 0;
  else if (entropy < 40) score = 1;
  else if (entropy < 60) score = 2;
  else if (entropy < 100) score = 3;
  else score = 4;

  const warnings: string[] = [];
  if (length > 0 && length < 8) warnings.push('Shorter than 8 characters.');
  if (pw && !/[A-Z]/.test(pw)) warnings.push('No uppercase letters.');
  if (pw && !/[0-9]/.test(pw)) warnings.push('No digits.');
  if (pw && !/[^a-zA-Z0-9]/.test(pw)) warnings.push('No symbols.');
  if (pw && /^(.)\1+$/.test(pw)) warnings.push('A single repeated character.');
  if (pw && /^[0-9]+$/.test(pw)) warnings.push('Digits only.');

  return {
    length,
    poolSize: pool,
    entropyBits: Math.round(entropy * 10) / 10,
    score,
    label: LABELS[score],
    crackTimeText: humanizeSeconds(seconds),
    warnings,
  };
}
