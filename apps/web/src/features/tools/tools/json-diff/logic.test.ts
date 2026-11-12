// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/json-diff/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { diffJson, diffValues } from './logic';

describe('json-diff', () => {
  it('detects no changes for equal structures', () => {
    expect(diffValues({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] })).toEqual([]);
  });

  it('is insensitive to object key order', () => {
    expect(diffValues({ a: 1, b: 2 }, { b: 2, a: 1 })).toEqual([]);
  });

  it('reports added, removed and changed', () => {
    const r = diffJson(
      JSON.stringify({ a: 1, b: 2, obj: { x: 1 } }),
      JSON.stringify({ a: 1, b: 3, c: 4, obj: { x: 1 } }),
    );
    expect(r.changed).toBe(1); // b: 2 -> 3
    expect(r.added).toBe(1); // c
    expect(r.removed).toBe(0);
    const changed = r.changes.find((c) => c.type === 'changed');
    expect(changed?.path).toBe('$.b');
    expect(changed?.left).toBe(2);
    expect(changed?.right).toBe(3);
  });

  it('diffs arrays by index', () => {
    const r = diffValues([1, 2, 3], [1, 9, 3, 4]);
    expect(r.find((c) => c.path === '$[1]')?.type).toBe('changed');
    expect(r.find((c) => c.path === '$[3]')?.type).toBe('added');
  });

  it('reports removed elements when the right array is shorter', () => {
    const r = diffValues([1, 2, 3], [1]);
    expect(r).toEqual([
      { path: '$[1]', type: 'removed', left: 2 },
      { path: '$[2]', type: 'removed', left: 3 },
    ]);
  });

  it('throws a SyntaxError for malformed JSON input', () => {
    expect(() => diffJson('{not valid json', '{}')).toThrow();
    expect(() => diffJson('{}', '')).toThrow();
  });

  it('bracket-quotes non-identifier object keys', () => {
    const r = diffValues({ 'foo-bar': 1, '123': 2 }, { 'foo-bar': 2, '123': 3 });
    const paths = r.map((c) => c.path).sort();
    expect(paths).toEqual(['$["123"]', '$["foo-bar"]']);
  });

  it("treats type mismatches (object vs array, null vs object) as a single 'changed' entry", () => {
    expect(diffValues({ a: 1 }, [1])).toEqual([
      { path: '$', type: 'changed', left: { a: 1 }, right: [1] },
    ]);
    expect(diffValues(null, { a: 1 })).toEqual([
      { path: '$', type: 'changed', left: null, right: { a: 1 } },
    ]);
  });

  it('distinguishes -0 from 0 via Object.is', () => {
    const r = diffValues(-0, 0);
    expect(r).toEqual([{ path: '$', type: 'changed', left: -0, right: 0 }]);
  });

  it('produces nested paths for objects inside arrays', () => {
    const r = diffValues([{ name: 'a' }], [{ name: 'b' }]);
    expect(r).toEqual([{ path: '$[0].name', type: 'changed', left: 'a', right: 'b' }]);
  });

  it('reports no changes for two empty objects or arrays', () => {
    expect(diffValues({}, {})).toEqual([]);
    expect(diffValues([], [])).toEqual([]);
  });

  it('diffJson round-trips counts for a purely additive diff', () => {
    const r = diffJson('{}', JSON.stringify({ a: 1, b: 2 }));
    expect(r.added).toBe(2);
    expect(r.removed).toBe(0);
    expect(r.changed).toBe(0);
  });
});
