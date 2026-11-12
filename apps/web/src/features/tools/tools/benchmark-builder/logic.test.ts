// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/benchmark-builder/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { computeStats, toBulletList, toMarkdownTable } from './logic';

describe('benchmark-builder', () => {
  const suites = [
    { name: 'Suite 1', values: [5, 10] },
    { name: 'Suite 2', values: [8, 12] },
  ];

  it('computes mean, variance and ranking', () => {
    const stats = computeStats(suites);
    expect(stats[0]).toMatchObject({
      name: 'Suite 1',
      mean: 7.5,
      variance: 6.25,
      rank: 1,
    });
    expect(stats[1]).toMatchObject({
      name: 'Suite 2',
      mean: 10,
      variance: 4,
      rank: 2,
      deltaFromBest: 2.5,
      factor: 1.333,
    });
  });

  it('ignores empty suites', () => {
    const stats = computeStats([...suites, { name: 'Empty', values: [] }]);
    expect(stats).toHaveLength(2);
  });

  it('exports a markdown table', () => {
    const md = toMarkdownTable(computeStats(suites), 'ms');
    expect(md).toContain('| Position | Suite | Samples | Mean (ms) | Variance |');
    expect(md).toContain('Suite 1');
    expect(md).toContain('×1.333');
  });

  it('returns an empty array for no suites', () => {
    expect(computeStats([])).toEqual([]);
  });

  it('returns an empty array when every suite is empty', () => {
    expect(computeStats([{ name: 'Empty', values: [] }])).toEqual([]);
  });

  it('gives a single-sample suite zero variance', () => {
    const stats = computeStats([{ name: 'Solo', values: [42] }]);
    expect(stats[0]).toMatchObject({ name: 'Solo', samples: 1, mean: 42, variance: 0 });
  });

  it("avoids dividing by zero when the fastest suite's mean is 0", () => {
    const stats = computeStats([
      { name: 'Zero', values: [0, 0] },
      { name: 'Slow', values: [5, 5] },
    ]);
    expect(stats[0]).toMatchObject({ name: 'Zero', mean: 0, factor: 1 });
    // factor is special-cased to 1 (not Infinity/NaN) whenever the best mean is 0.
    expect(stats[1]).toMatchObject({
      name: 'Slow',
      mean: 5,
      deltaFromBest: 5,
      factor: 1,
    });
  });

  it('exports a bullet list', () => {
    const list = toBulletList(computeStats(suites), 'ms');
    expect(list).toBe('- Suite 1: 7.5 ms\n- Suite 2: 10 ms (+2.5 ms ; ×1.333)');
  });

  it('renders empty stats as an empty table/list', () => {
    expect(toMarkdownTable([])).toBe(
      '| Position | Suite | Samples | Mean | Variance |\n| --- | --- | --- | --- | --- |',
    );
    expect(toBulletList([])).toBe('');
  });
});
