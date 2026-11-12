// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/sql-parameterizer/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { parameterize } from './logic';

describe('sql-parameterizer', () => {
  it('extracts string and number literals', () => {
    const r = parameterize("SELECT * FROM users WHERE id = 5 AND name = 'Ada'", 'at');
    expect(r.query).toBe('SELECT * FROM users WHERE id = @p1 AND name = @p2');
    expect(r.params).toEqual([
      { name: 'p1', value: 5 },
      { name: 'p2', value: 'Ada' },
    ]);
  });

  it('handles escaped quotes in strings', () => {
    const r = parameterize("WHERE name = 'O''Brien'", 'at');
    expect(r.params[0]!.value).toBe("O'Brien");
  });

  it('does not touch numbers inside identifiers', () => {
    const r = parameterize('SELECT col1, x2 FROM t WHERE a = 3', 'at');
    expect(r.query).toContain('col1');
    expect(r.query).toContain('x2');
    expect(r.params).toEqual([{ name: 'p1', value: 3 }]);
  });

  it('supports positional and dollar styles', () => {
    expect(parameterize('a = 1 AND b = 2', 'question').query).toBe('a = ? AND b = ?');
    expect(parameterize('a = 1', 'dollar').query).toBe('a = $1');
  });

  it('handles empty input', () => {
    expect(parameterize('', 'at')).toEqual({ query: '', params: [] });
  });

  it('extracts decimal number literals', () => {
    const r = parameterize('a = 1.5 AND b = 2.75', 'at');
    expect(r.query).toBe('a = @p1 AND b = @p2');
    expect(r.params).toEqual([
      { name: 'p1', value: 1.5 },
      { name: 'p2', value: 2.75 },
    ]);
  });

  it('extracts an empty string literal', () => {
    const r = parameterize("WHERE s = ''", 'at');
    expect(r.query).toBe('WHERE s = @p1');
    expect(r.params).toEqual([{ name: 'p1', value: '' }]);
  });

  it('does not hang or throw on an unterminated string literal', () => {
    const r = parameterize("WHERE unterminated = '", 'at');
    expect(r.query).toBe('WHERE unterminated = @p1');
    expect(r.params).toEqual([{ name: 'p1', value: '' }]);
  });

  it('preserves unicode content inside string literals', () => {
    const r = parameterize("SELECT 'héllo wörld ☕'", 'at');
    expect(r.params).toEqual([{ name: 'p1', value: 'héllo wörld ☕' }]);
  });

  it('leaves a digit sequence immediately followed by a letter untouched (not a clean number)', () => {
    const r = parameterize('width = 5px', 'at');
    expect(r.query).toBe('width = 5px');
    expect(r.params).toEqual([]);
  });

  it('leaves a malformed multi-dot number untouched', () => {
    const r = parameterize('v = 1.2.3', 'at');
    expect(r.query).toBe('v = 1.2.3');
    expect(r.params).toEqual([]);
  });

  it('normalizes a leading-zero integer literal to its numeric value', () => {
    const r = parameterize('code = 007', 'at');
    expect(r.params).toEqual([{ name: 'p1', value: 7 }]);
  });

  it('handles several literals across a multi-clause query in sequence', () => {
    const r = parameterize("a = 1 AND b = 2 AND c = 'x'", 'colon');
    expect(r.query).toBe('a = :p1 AND b = :p2 AND c = :p3');
    expect(r.params).toEqual([
      { name: 'p1', value: 1 },
      { name: 'p2', value: 2 },
      { name: 'p3', value: 'x' },
    ]);
  });
});
