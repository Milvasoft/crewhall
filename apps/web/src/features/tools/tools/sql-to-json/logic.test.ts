// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/sql-to-json/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { sqlToJson } from './logic';

describe('sql-to-json', () => {
  it('parses a multi-row insert with columns', () => {
    const json = JSON.parse(
      sqlToJson(
        "INSERT INTO users (id, name, active) VALUES (1, 'Ada', true), (2, 'O''Brien', NULL);",
      ),
    );
    expect(json).toEqual([
      { id: 1, name: 'Ada', active: true },
      { id: 2, name: "O'Brien", active: null },
    ]);
  });

  it('falls back to column1..N without a column list', () => {
    const json = JSON.parse(sqlToJson("INSERT INTO t VALUES (1, 'x');"));
    expect(json).toEqual([{ column1: 1, column2: 'x' }]);
  });

  it('handles multiple statements', () => {
    const json = JSON.parse(
      sqlToJson('INSERT INTO t (a) VALUES (1); INSERT INTO t (a) VALUES (2);'),
    );
    expect(json).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('throws when there is no insert', () => {
    expect(() => sqlToJson('SELECT * FROM t')).toThrow();
  });

  it('throws on empty or whitespace-only input', () => {
    expect(() => sqlToJson('')).toThrow();
    expect(() => sqlToJson('   ')).toThrow();
  });

  it('parses negative and decimal numbers', () => {
    const json = JSON.parse(sqlToJson('INSERT INTO t VALUES (3.14, -1.5, -2);'));
    expect(json).toEqual([{ column1: 3.14, column2: -1.5, column3: -2 }]);
  });

  it('keeps unsafe (too-large) integers as raw text instead of coercing', () => {
    const json = JSON.parse(sqlToJson('INSERT INTO t VALUES (99999999999999999999);'));
    expect(json).toEqual([{ column1: '99999999999999999999' }]);
  });

  it('keeps unquoted function-call tokens as text', () => {
    const json = JSON.parse(sqlToJson('INSERT INTO t (a) VALUES (NOW());'));
    expect(json).toEqual([{ a: 'NOW()' }]);
  });

  it('strips backticks, double quotes and brackets from column names', () => {
    const json = JSON.parse(
      sqlToJson('INSERT INTO t (`id`, "name", [active]) VALUES (1, \'x\', true);'),
    );
    expect(json).toEqual([{ id: 1, name: 'x', active: true }]);
  });

  it('does not split a quoted value on an embedded comma', () => {
    const json = JSON.parse(sqlToJson("INSERT INTO t (a) VALUES ('a, b');"));
    expect(json).toEqual([{ a: 'a, b' }]);
  });

  it('accepts a statement without a trailing semicolon', () => {
    const json = JSON.parse(sqlToJson('INSERT INTO t (a) VALUES (1)'));
    expect(json).toEqual([{ a: 1 }]);
  });

  it('is case-insensitive for the INSERT/INTO/VALUES keywords', () => {
    const json = JSON.parse(sqlToJson('insert into t (a) values (1);'));
    expect(json).toEqual([{ a: 1 }]);
  });

  it('falls back to columnN for values beyond the declared column list', () => {
    const json = JSON.parse(sqlToJson("INSERT INTO t (id) VALUES (1, 'x');"));
    expect(json).toEqual([{ id: 1, column2: 'x' }]);
  });

  it('honors a custom indent', () => {
    expect(sqlToJson('INSERT INTO t (a) VALUES (1);', 0)).toBe('[{"a":1}]');
  });
});
