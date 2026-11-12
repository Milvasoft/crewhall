// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/json-excel/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { columnsOf, normalizeRows } from './logic';

describe('json-excel', () => {
  it('wraps a single object into one row', () => {
    expect(normalizeRows('{"a":1}')).toEqual([{ a: 1 }]);
  });

  it('accepts an array of objects', () => {
    expect(normalizeRows('[{"a":1},{"a":2}]')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('rejects arrays of primitives', () => {
    expect(() => normalizeRows('[1,2,3]')).toThrow();
  });

  it('computes the union of columns in order', () => {
    expect(columnsOf([{ a: 1 }, { b: 2 }, { a: 3, c: 4 }])).toEqual(['a', 'b', 'c']);
  });

  it('throws on empty or malformed JSON', () => {
    expect(() => normalizeRows('')).toThrow();
    expect(() => normalizeRows('   ')).toThrow();
    expect(() => normalizeRows('{not json')).toThrow();
  });

  it('rejects a top-level null and arrays containing null', () => {
    expect(() => normalizeRows('null')).toThrow();
    expect(() => normalizeRows('[{"a":1}, null]')).toThrow();
  });

  it('accepts an empty array with no rows', () => {
    expect(normalizeRows('[]')).toEqual([]);
    expect(columnsOf([])).toEqual([]);
  });

  it('accepts rows whose values are nested objects/arrays', () => {
    expect(normalizeRows('{"a":{"nested":1},"b":[1,2]}')).toEqual([
      { a: { nested: 1 }, b: [1, 2] },
    ]);
  });
});
