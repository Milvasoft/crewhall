// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/json-viewer/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { computeStats, formatError, formatJson, minifyJson, parseJson } from './logic';

describe('json-viewer logic', () => {
  it('formats with 2-space indent', () => {
    expect(formatJson('{"a":1}')).toBe('{\n  "a": 1\n}');
  });

  it('sorts keys deeply when requested', () => {
    const out = formatJson('{"b":1,"a":{"d":1,"c":2}}', { sortKeys: true });
    expect(out.indexOf('"a"')).toBeLessThan(out.indexOf('"b"'));
    expect(out.indexOf('"c"')).toBeLessThan(out.indexOf('"d"'));
  });

  it('minifies', () => {
    expect(minifyJson('{\n "a": [1, 2] \n}')).toBe('{"a":[1,2]}');
  });

  it('reports an error for invalid JSON', () => {
    const res = parseJson('{\n  "a": 1,\n  "b":\n}');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toBeTruthy();
      // When the engine includes a position, it is mapped to a 1-based line.
      if (res.error.line !== undefined) {
        expect(res.error.line).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('maps an engine position string to line/column', () => {
    // Simulates a V8-style message that includes a position.
    const res = parseJson('[1, 2,]');
    expect(res.ok).toBe(false);
  });

  it('computes structure stats', () => {
    const parsed = parseJson('{"a":[1,2,{"b":3}]}');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const s = computeStats(parsed.value);
      expect(s.objects).toBe(2);
      expect(s.arrays).toBe(1);
      expect(s.keys).toBe(2);
    }
  });

  it('computes stats for edge-case top-level values', () => {
    expect(computeStats(42)).toEqual({
      objects: 0,
      arrays: 0,
      keys: 0,
      values: 1,
      depth: 1,
    });
    expect(computeStats(null)).toEqual({
      objects: 0,
      arrays: 0,
      keys: 0,
      values: 1,
      depth: 1,
    });
    expect(computeStats({})).toEqual({
      objects: 1,
      arrays: 0,
      keys: 0,
      values: 0,
      depth: 1,
    });
    expect(computeStats([])).toEqual({
      objects: 0,
      arrays: 1,
      keys: 0,
      values: 0,
      depth: 1,
    });
  });

  it('formats formatError with and without line/column info', () => {
    expect(formatError({ message: 'boom' })).toBe('boom');
    expect(formatError({ message: 'boom', line: 2, column: 5 })).toBe('boom (line 2, column 5)');
  });

  it('throws from formatJson/minifyJson on invalid input', () => {
    expect(() => formatJson('{bad')).toThrow();
    expect(() => minifyJson('{bad')).toThrow();
  });

  it('supports a custom indent width and tab indent', () => {
    expect(formatJson('{"a":1}', { indent: 4 })).toBe('{\n    "a": 1\n}');
    expect(formatJson('{"a":1}', { indent: '\t' })).toBe('{\n\t"a": 1\n}');
  });

  it('sorts keys inside array elements too, without reordering the array', () => {
    const out = formatJson('[{"b":1,"a":2},{"d":1,"c":2}]', { sortKeys: true });
    const parsed = JSON.parse(out);
    expect(Object.keys(parsed[0])).toEqual(['a', 'b']);
    expect(Object.keys(parsed[1])).toEqual(['c', 'd']);
  });

  it('is idempotent: formatting already-formatted JSON is a no-op', () => {
    const once = formatJson('{"a":1}');
    expect(formatJson(once)).toBe(once);
  });

  it('preserves Unicode characters in string values', () => {
    expect(formatJson('{"emoji":"😀"}')).toContain('😀');
  });
});
