// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/sql-formatter/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { formatSql, SQL_DIALECTS } from './logic';

const OPTS = { dialect: 'sql' as const, keywordCase: 'upper' as const, tabWidth: 2 };

describe('sql-formatter', () => {
  it('formats and uppercases keywords', () => {
    const out = formatSql('select a,b from t where x=1', OPTS);
    expect(out).toContain('SELECT');
    expect(out).toContain('FROM');
    expect(out).toContain('WHERE');
    expect(out.split('\n').length).toBeGreaterThan(1);
  });

  it('respects lower keyword case', () => {
    const out = formatSql('SELECT A FROM T', { ...OPTS, keywordCase: 'lower' });
    expect(out).toContain('select');
    expect(out).toContain('from');
  });

  it('indents nested clauses', () => {
    const out = formatSql('select a from t where x in (1,2,3)', OPTS);
    expect(out).toMatch(/\n\s+/); // has indentation
  });

  it('exposes all eight supported dialects with ids and labels', () => {
    expect(SQL_DIALECTS).toHaveLength(8);
    for (const d of SQL_DIALECTS) {
      expect(typeof d.id).toBe('string');
      expect(d.label.length).toBeGreaterThan(0);
    }
    expect(SQL_DIALECTS.map((d) => d.id)).toEqual([
      'sql',
      'postgresql',
      'mysql',
      'mariadb',
      'sqlite',
      'transactsql',
      'plsql',
      'bigquery',
    ]);
  });

  it('preserves original keyword casing when requested', () => {
    const out = formatSql('SeLeCt a FrOm t', { ...OPTS, keywordCase: 'preserve' });
    expect(out).toContain('SeLeCt');
    expect(out).toContain('FrOm');
  });

  it('returns an empty string for empty input', () => {
    expect(formatSql('', OPTS)).toBe('');
  });

  it('uses tabWidth spaces for each indent level', () => {
    const sql = 'select a from t';
    const out2 = formatSql(sql, { ...OPTS, tabWidth: 2 });
    const out4 = formatSql(sql, { ...OPTS, tabWidth: 4 });
    expect(out2).toContain('\n  a');
    expect(out4).toContain('\n    a');
  });

  it('is idempotent: formatting already-formatted SQL changes nothing', () => {
    const once = formatSql('select a,b from t where x=1', OPTS);
    const twice = formatSql(once, OPTS);
    expect(twice).toBe(once);
  });

  it('formats dialect-specific syntax (MySQL backticks, T-SQL TOP)', () => {
    const mysql = formatSql('select `a` from `t`', { ...OPTS, dialect: 'mysql' });
    expect(mysql).toContain('`a`');
    expect(mysql).toContain('`t`');

    const tsql = formatSql('select top 10 a from t', { ...OPTS, dialect: 'transactsql' });
    expect(tsql).toContain('TOP 10');
  });
});
