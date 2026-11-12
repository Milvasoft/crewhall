// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/text-compare/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { diffText } from './logic';

describe('diffText', () => {
  it('marks identical text as all equal', () => {
    const r = diffText('a\nb\nc', 'a\nb\nc');
    expect(r.added).toBe(0);
    expect(r.removed).toBe(0);
    expect(r.rows.every((row) => row.type === 'equal')).toBe(true);
  });

  it('detects an added line', () => {
    const r = diffText('a\nb', 'a\nb\nc');
    expect(r.added).toBe(1);
    expect(r.removed).toBe(0);
  });

  it('pairs replaced lines as modified', () => {
    const r = diffText('hello', 'world');
    expect(r.changed).toBe(1);
    const row = r.rows[0]!;
    expect(row.left).toBe('hello');
    expect(row.right).toBe('world');
  });

  it('honors ignoreCase', () => {
    const eq = diffText('Hello', 'hello', { ignoreCase: true });
    expect(eq.changed + eq.added + eq.removed).toBe(0);
    const neq = diffText('Hello', 'hello');
    expect(neq.changed).toBe(1);
  });

  it('honors ignoreWhitespace', () => {
    const r = diffText('a  b', 'a b', { ignoreWhitespace: true });
    expect(r.rows[0]!.type).toBe('equal');
  });

  it('honors trim', () => {
    const r = diffText('  hello  ', 'hello', { trim: true });
    expect(r.rows[0]!.type).toBe('equal');
    expect(r.added + r.removed + r.changed).toBe(0);
  });

  it('combines trim, ignoreCase and ignoreWhitespace', () => {
    const r = diffText(' Hello   World ', 'hello world', {
      trim: true,
      ignoreCase: true,
      ignoreWhitespace: true,
    });
    expect(r.rows[0]!.type).toBe('equal');
    expect(r.added + r.removed + r.changed).toBe(0);
  });

  it('produces no rows when comparing two empty strings', () => {
    const r = diffText('', '');
    expect(r.rows).toEqual([]);
    expect(r.added + r.removed + r.changed).toBe(0);
  });

  it('treats every line as added when the left side is empty', () => {
    const r = diffText('', 'a\nb');
    expect(r.added).toBe(2);
    expect(r.removed).toBe(0);
    expect(r.rows.every((row) => row.type === 'added')).toBe(true);
  });

  it('treats every line as removed when the right side is empty', () => {
    const r = diffText('a\nb', '');
    expect(r.removed).toBe(2);
    expect(r.added).toBe(0);
    expect(r.rows.every((row) => row.type === 'removed')).toBe(true);
  });

  it('splits on \\r\\n and lone \\r the same as \\n', () => {
    const r = diffText('a\r\nb\rc', 'a\nb\nc');
    expect(r.rows.every((row) => row.type === 'equal')).toBe(true);
    expect(r.rows).toHaveLength(3);
  });

  it('pairs a shorter-to-longer replacement as modified rows plus trailing added rows', () => {
    const r = diffText('x1\nx2', 'y1\ny2\ny3');
    expect(r.changed).toBe(2);
    expect(r.added).toBe(1);
    expect(r.removed).toBe(0);
    expect(r.rows.map((row) => row.type)).toEqual(['modified', 'modified', 'added']);
    expect(r.rows[2]).toEqual({
      left: null,
      right: 'y3',
      leftNo: null,
      rightNo: 3,
      type: 'added',
    });
  });

  it('pairs a longer-to-shorter replacement as modified rows plus trailing removed rows', () => {
    const r = diffText('x1\nx2\nx3', 'y1');
    expect(r.changed).toBe(1);
    expect(r.removed).toBe(2);
    expect(r.added).toBe(0);
    expect(r.rows.map((row) => row.type)).toEqual(['modified', 'removed', 'removed']);
  });

  it('numbers left/right lines sequentially and independently across mixed changes', () => {
    const r = diffText('a\nb\nold\nd', 'a\nb\nnew1\nnew2\nd');
    expect(r.rows.map((row) => [row.leftNo, row.rightNo])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3], // old -> new1, modified
      [null, 4], // new2, added
      [4, 5], // d, equal
    ]);
  });
});
