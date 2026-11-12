// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/timestamp/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { formatInZone, parseInput, relativeTime, toInfo } from './logic';

describe('timestamp', () => {
  it('parses Unix seconds', () => {
    const d = parseInput('1700000000');
    expect(d?.toISOString()).toBe('2023-11-14T22:13:20.000Z');
  });

  it('auto-detects milliseconds by magnitude', () => {
    const d = parseInput('1700000000000');
    expect(d?.toISOString()).toBe('2023-11-14T22:13:20.000Z');
  });

  it('parses ISO strings', () => {
    const d = parseInput('2024-01-01T00:00:00Z');
    expect(d?.getTime()).toBe(Date.UTC(2024, 0, 1));
  });

  it('returns null for garbage', () => {
    expect(parseInput('not a date')).toBeNull();
    expect(parseInput('')).toBeNull();
  });

  it('computes seconds and millis', () => {
    const info = toInfo(new Date('2024-01-01T00:00:00Z'));
    expect(info.unixSeconds).toBe(1704067200);
    expect(info.unixMillis).toBe(1704067200000);
  });

  it('formats relative time', () => {
    const now = new Date('2024-01-01T00:00:00Z');
    expect(relativeTime(new Date('2024-01-02T00:00:00Z'), now)).toMatch(/tomorrow|day/);
  });

  it('treats a 12-digit numeric string as seconds, not milliseconds', () => {
    // 999999999999 < 1e12, so it is multiplied by 1000 as seconds.
    const d = parseInput('999999999999');
    expect(d?.getTime()).toBe(999999999999 * 1000);
  });

  it('treats exactly 1e12 as milliseconds (the seconds/millis threshold)', () => {
    const d = parseInput('1000000000000');
    expect(d?.getTime()).toBe(1000000000000);
  });

  it('interprets a negative integer string as Unix seconds before the epoch', () => {
    const d = parseInput('-100');
    expect(d?.toISOString()).toBe('1969-12-31T23:58:20.000Z');
  });

  it('returns null for a decimal numeric string, whitespace, and out-of-range magnitudes', () => {
    expect(parseInput('1700000000.5')).toBeNull();
    expect(parseInput('   ')).toBeNull();
    expect(parseInput('99999999999999999999')).toBeNull();
  });

  it('trims surrounding whitespace before parsing', () => {
    const d = parseInput('  1700000000  ');
    expect(d?.toISOString()).toBe('2023-11-14T22:13:20.000Z');
  });

  it('formats a moment in an explicit IANA zone', () => {
    const d = new Date('2024-06-15T12:00:00Z');
    expect(formatInZone(d, 'UTC')).toContain('12:00:00');
    expect(formatInZone(d, 'UTC')).toContain('UTC');
    expect(formatInZone(d, 'Asia/Tokyo')).toContain('21:00:00');
  });

  it('returns an empty string for an invalid time zone', () => {
    const d = new Date('2024-06-15T12:00:00Z');
    expect(formatInZone(d, 'Not/AZone')).toBe('');
  });

  it('picks the right relative-time unit across bucket boundaries', () => {
    const now = new Date('2024-01-01T00:00:00Z');
    expect(relativeTime(new Date(now.getTime() + 30 * 1000), now)).toBe('in 30 seconds');
    expect(relativeTime(new Date(now.getTime() + 5 * 60 * 1000), now)).toBe('in 5 minutes');
    expect(relativeTime(new Date(now.getTime() + 3 * 60 * 60 * 1000), now)).toBe('in 3 hours');
    expect(relativeTime(new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000), now)).toBe('3 days ago');
    expect(relativeTime(now, now)).toBe('now');
  });

  it('toInfo derives seconds/millis/iso/utc consistently for a known date', () => {
    const info = toInfo(new Date('2024-06-15T12:00:00Z'), new Date('2024-06-15T12:00:00Z'));
    expect(info.iso).toBe('2024-06-15T12:00:00.000Z');
    expect(info.utc).toBe('Sat, 15 Jun 2024 12:00:00 GMT');
    expect(info.unixSeconds).toBe(1718452800);
    expect(info.unixMillis).toBe(1718452800000);
    expect(info.relative).toBe('now');
  });
});
