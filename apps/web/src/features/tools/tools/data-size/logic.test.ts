// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/data-size/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { convertAll, formatNumber, fromBytes, humanize, toBytes, unitById } from './logic';

describe('data-size', () => {
  it('converts to bytes', () => {
    expect(toBytes(1, 'kb')).toBe(1000);
    expect(toBytes(1, 'kib')).toBe(1024);
    expect(toBytes(1, 'mib')).toBe(1024 * 1024);
    expect(toBytes(8, 'bit')).toBe(1);
  });

  it('round-trips through bytes', () => {
    expect(fromBytes(toBytes(2.5, 'gb'), 'gb')).toBeCloseTo(2.5);
    expect(fromBytes(toBytes(1, 'gib'), 'mib')).toBe(1024);
  });

  it('convertAll produces one row per unit including the source', () => {
    const rows = convertAll(1, 'mib');
    const kib = rows.find((r) => r.unit.id === 'kib');
    const mb = rows.find((r) => r.unit.id === 'mb');
    expect(kib?.value).toBe(1024);
    expect(mb?.value).toBeCloseTo(1.048576);
  });

  it('throws on unknown units', () => {
    expect(() => toBytes(1, 'nope')).toThrow();
  });

  it('humanizes byte counts', () => {
    expect(humanize(0)).toBe('0 B');
    expect(humanize(1536, true)).toBe('1.5 KiB');
    expect(humanize(1_500_000, false)).toBe('1.5 MB');
  });

  it('throws on unknown units for fromBytes', () => {
    expect(() => fromBytes(1, 'nope')).toThrow();
  });

  it('looks up units by id and returns undefined for unknown ids', () => {
    expect(unitById('mib')?.label).toBe('MiB');
    expect(unitById('nope')).toBeUndefined();
  });

  it('formats numbers: exponential thresholds, trailing-zero trimming and non-finite', () => {
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(NaN)).toBe('—');
    expect(formatNumber(Infinity)).toBe('—');
    expect(formatNumber(1e15)).toBe('1e+15');
    expect(formatNumber(0.0000001)).toBe('1e-7');
    expect(formatNumber(-5.5)).toBe('-5.5');
    expect(formatNumber(2)).toBe('2');
  });

  it('clamps humanize to the largest unit beyond the top of the table', () => {
    // 2048 PiB in bytes: index would exceed the table, so it clamps to PiB
    // rather than throwing or indexing out of bounds.
    expect(humanize(1024 ** 6 * 2)).toBe('2048 PiB');
  });

  it('humanizes negative byte counts', () => {
    expect(humanize(-1536)).toBe('-1.5 KiB');
  });

  it('defaults humanize to binary (IEC) units', () => {
    expect(humanize(1536)).toBe('1.5 KiB');
  });
});
