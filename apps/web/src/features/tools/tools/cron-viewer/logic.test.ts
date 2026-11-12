// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/cron-viewer/logic.test.ts. See THIRD_PARTY.md.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cronToHangfire, cronToQuartz, describeCron } from './logic';

describe('describeCron', () => {
  it('describes a standard 5-field expression', () => {
    const r = describeCron('*/5 * * * *');
    expect(r.error).toBeNull();
    expect(r.description?.toLowerCase()).toContain('every 5 minutes');
    expect(r.nextRuns.length).toBe(6);
  });

  it('returns ascending next runs', () => {
    const r = describeCron('0 * * * *');
    for (let i = 1; i < r.nextRuns.length; i++) {
      expect(r.nextRuns[i]!.getTime()).toBeGreaterThan(r.nextRuns[i - 1]!.getTime());
    }
  });

  it('reports an error for nonsense', () => {
    const r = describeCron('not a cron');
    expect(r.error).toBeTruthy();
  });

  it('handles empty input without error', () => {
    const r = describeCron('   ');
    expect(r.error).toBeNull();
    expect(r.description).toBeNull();
  });
});

describe('describeCron with an explicit reference date', () => {
  // cron-parser works in local time and these expectations are written in UTC: pin the zone
  // for this block so the suite passes on any machine (e.g. Europe/Istanbul).
  const originalTz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'UTC';
  });
  afterAll(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  const ref = new Date('2026-01-01T00:00:00.000Z');

  it('computes deterministic next runs for a daily expression', () => {
    const r = describeCron('0 9 * * *', ref);
    expect(r.error).toBeNull();
    expect(r.nextRuns.map((d) => d.toISOString())).toEqual([
      '2026-01-01T09:00:00.000Z',
      '2026-01-02T09:00:00.000Z',
      '2026-01-03T09:00:00.000Z',
      '2026-01-04T09:00:00.000Z',
      '2026-01-05T09:00:00.000Z',
      '2026-01-06T09:00:00.000Z',
    ]);
  });

  it('treats day-of-week 0 and 7 as the same day (Sunday)', () => {
    const withZero = describeCron('0 0 * * 0', ref);
    const withSeven = describeCron('0 0 * * 7', ref);
    expect(withZero.description?.toLowerCase()).toContain('sunday');
    expect(withSeven.description?.toLowerCase()).toContain('sunday');
    expect(withZero.nextRuns.map((d) => d.toISOString())).toEqual(
      withSeven.nextRuns.map((d) => d.toISOString()),
    );
  });

  it("accepts a Quartz-style 6-field expression with seconds and '?'", () => {
    const r = describeCron('0 0 12 * * ?', ref);
    expect(r.error).toBeNull();
    expect(r.fieldCount).toBe(6);
    expect(r.nextRuns[0]?.toISOString()).toBe('2026-01-01T12:00:00.000Z');
  });

  it('reports an error for a field value out of range', () => {
    const r = describeCron('60 * * * *', ref);
    expect(r.description).toBeNull();
    expect(r.error).toBeTruthy();
    expect(r.nextRuns).toEqual([]);
  });
});

describe('cron dialect conversion', () => {
  it('converts 5-field cron to Quartz with seconds and ?', () => {
    // every day at 09:00
    expect(cronToQuartz('0 9 * * *').value).toBe('0 0 9 * * ?');
  });

  it('shifts day-of-week numbering for Quartz', () => {
    // Unix Mon-Fri (1-5) → Quartz (2-6), and dom becomes ?
    expect(cronToQuartz('30 8 * * 1-5').value).toBe('0 30 8 ? * 2-6');
  });

  it("maps both day-of-week boundary values (0 and 7 = Sunday) to Quartz's 1", () => {
    expect(cronToQuartz('0 0 * * 0').value).toBe('0 0 0 ? * 1');
    expect(cronToQuartz('0 0 * * 7').value).toBe('0 0 0 ? * 1');
  });

  it("leaves a day-of-week wildcard as '?' and the day-of-month untouched", () => {
    expect(cronToQuartz('0 0 15 * *').value).toBe('0 0 0 15 * ?');
  });

  it('notes when both day-of-month and day-of-week are specified', () => {
    const r = cronToQuartz('0 9 15 * 1');
    expect(r.value).toBe('0 0 9 15 * 2');
    expect(r.note).toMatch(/can't specify both/i);
  });

  it('passes through an already 6-7 field expression unchanged, with a note', () => {
    const r = cronToQuartz('0 0 12 * * ?');
    expect(r.value).toBe('0 0 12 * * ?');
    expect(r.note).toMatch(/already/i);
  });

  it('rejects expressions that are neither 5 nor 6-7 fields', () => {
    expect(() => cronToQuartz('* * * *')).toThrow();
  });

  it('keeps Hangfire expression unchanged', () => {
    expect(cronToHangfire('*/5 * * * *').value).toBe('*/5 * * * *');
  });

  it('keeps a 6-field Hangfire (seconds) expression unchanged too, with a note', () => {
    const r = cronToHangfire('0 */5 * * * *');
    expect(r.value).toBe('0 */5 * * * *');
    expect(r.note).toMatch(/hangfire/i);
  });
});
