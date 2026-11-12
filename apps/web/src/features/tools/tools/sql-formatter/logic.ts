// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/sql-formatter/logic.ts. See THIRD_PARTY.md.
import { format, type FormatOptionsWithLanguage } from 'sql-formatter';

/** A subset of sql-formatter's dialects, surfaced explicitly in the UI. */
export type SqlDialect = NonNullable<FormatOptionsWithLanguage['language']>;

export const SQL_DIALECTS: { id: SqlDialect; label: string }[] = [
  { id: 'sql', label: 'Standard SQL' },
  { id: 'postgresql', label: 'PostgreSQL' },
  { id: 'mysql', label: 'MySQL' },
  { id: 'mariadb', label: 'MariaDB' },
  { id: 'sqlite', label: 'SQLite' },
  { id: 'transactsql', label: 'T-SQL (SQL Server)' },
  { id: 'plsql', label: 'PL/SQL (Oracle)' },
  { id: 'bigquery', label: 'BigQuery' },
];

export interface SqlFormatOptions {
  dialect: SqlDialect;
  keywordCase: 'upper' | 'lower' | 'preserve';
  tabWidth: number;
}

export function formatSql(sql: string, options: SqlFormatOptions): string {
  return format(sql, {
    language: options.dialect,
    keywordCase: options.keywordCase,
    tabWidth: options.tabWidth,
  });
}
