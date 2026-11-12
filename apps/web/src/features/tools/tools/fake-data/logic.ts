// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/fake-data/logic.ts. See THIRD_PARTY.md.
import { newId } from '@/lib/ids';

/** Small, dependency-free fake-data generator. All values are random & local. */

export type FakeType =
  | 'firstName'
  | 'lastName'
  | 'fullName'
  | 'email'
  | 'username'
  | 'phone'
  | 'uuid'
  | 'int'
  | 'decimal'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'company'
  | 'city'
  | 'country'
  | 'street'
  | 'url'
  | 'ipv4'
  | 'word'
  | 'sentence'
  | 'color'
  | 'tckn'
  | 'vkn'
  | 'iban';

export const FAKE_TYPES: FakeType[] = [
  'firstName',
  'lastName',
  'fullName',
  'email',
  'username',
  'phone',
  'uuid',
  'int',
  'decimal',
  'boolean',
  'date',
  'datetime',
  'company',
  'city',
  'country',
  'street',
  'url',
  'ipv4',
  'word',
  'sentence',
  'color',
  'tckn',
  'vkn',
  'iban',
];

export interface FakeField {
  name: string;
  type: FakeType;
}

export type OutputFormat = 'json' | 'csv' | 'sql' | 'plain';

const FIRST =
  'James Mary John Patricia Robert Jennifer Ada Grace Linus Alan Katherine Margaret Omar Yuki Sofia Chen Priya Diego Fatima Noah'.split(
    ' ',
  );
const LAST =
  'Smith Johnson Williams Brown Jones Lovelace Hopper Turing Torvalds Curie Hamilton Khan Tanaka Garcia Nakamura Patel Rossi Haddad Kim Silva'.split(
    ' ',
  );
const COMPANY =
  'Acme Globex Initech Umbrella Soylent Hooli Stark Wayne Wonka Cyberdyne Massive Vandelay'.split(
    ' ',
  );
const CITY =
  'London Berlin Tokyo Paris Madrid Istanbul Toronto Austin Oslo Lisbon Seoul Cairo'.split(' ');
const COUNTRY =
  'USA UK Germany Japan France Spain Turkey Canada Norway Portugal Brazil India'.split(' ');
const STREETS = 'Main Oak Pine Maple Cedar Elm Washington Park Lake Hill'.split(' ');
const WORDS =
  'system data cloud vector matrix kernel buffer socket thread cache token schema'.split(' ');
const DOMAINS = 'example.com test.dev mail.io acme.co'.split(' ');

const r = (n: number) => Math.floor(Math.random() * n);
const pick = <T>(a: T[]): T => a[r(a.length)]!;

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// --- Turkish national IDs and IBAN (valid checksums, still random data) ------

/** Random valid Türkiye T.C. Kimlik No (11 digits, RFC-less official rules). */
export function randomTckn(): string {
  const d = [1 + r(9)]; // first digit is 1..9
  for (let i = 1; i < 9; i++) d.push(r(10));
  const odd = d[0]! + d[2]! + d[4]! + d[6]! + d[8]!;
  const even = d[1]! + d[3]! + d[5]! + d[7]!;
  d.push((((odd * 7 - even) % 10) + 10) % 10); // 10th digit
  d.push(d.reduce((a, b) => a + b, 0) % 10); // 11th digit
  return d.join('');
}

export function isValidTckn(s: string): boolean {
  if (!/^[1-9]\d{10}$/.test(s)) return false;
  const d = [...s].map(Number);
  const odd = d[0]! + d[2]! + d[4]! + d[6]! + d[8]!;
  const even = d[1]! + d[3]! + d[5]! + d[7]!;
  const c10 = (((odd * 7 - even) % 10) + 10) % 10;
  const c11 = d.slice(0, 10).reduce((a, b) => a + b, 0) % 10;
  return d[9] === c10 && d[10] === c11;
}

/** Random valid Türkiye Vergi Kimlik No (VKN, 10 digits). */
export function randomVkn(): string {
  const v: number[] = Array.from({ length: 9 }, () => r(10));
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const tmp = (v[i]! + (9 - i)) % 10;
    sum += tmp === 9 ? 9 : (tmp * 2 ** (9 - i)) % 9;
  }
  v.push((10 - (sum % 10)) % 10);
  return v.join('');
}

export function isValidVkn(s: string): boolean {
  if (!/^\d{10}$/.test(s)) return false;
  const v = [...s].map(Number);
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const tmp = (v[i]! + (9 - i)) % 10;
    sum += tmp === 9 ? 9 : (tmp * 2 ** (9 - i)) % 9;
  }
  return (10 - (sum % 10)) % 10 === v[9];
}

/** ISO 7064 mod-97-10 over the digit string (letters already expanded). */
function mod97(numeric: string): number {
  let rem = 0;
  for (const ch of numeric) rem = (rem * 10 + (ch.charCodeAt(0) - 48)) % 97;
  return rem;
}

function ibanCheckDigits(country: string, bban: string): string {
  const rearranged = `${bban}${country}00`;
  const numeric = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  return String(98 - mod97(numeric)).padStart(2, '0');
}

/** Random valid Türkiye IBAN: TR + 2 check + 5 bank + 1 reserved + 16 account. */
export function randomTrIban(): string {
  const bban =
    String(r(100000)).padStart(5, '0') + '0' + Array.from({ length: 16 }, () => r(10)).join('');
  return `TR${ibanCheckDigits('TR', bban)}${bban}`;
}

export function isValidTrIban(s: string): boolean {
  if (!/^TR\d{24}$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  return mod97(numeric) === 1;
}

export function generateValue(type: FakeType): string | number | boolean {
  switch (type) {
    case 'firstName':
      return pick(FIRST);
    case 'lastName':
      return pick(LAST);
    case 'fullName':
      return `${pick(FIRST)} ${pick(LAST)}`;
    case 'username':
      return `${slug(pick(FIRST))}${r(1000)}`;
    case 'email':
      return `${slug(pick(FIRST))}.${slug(pick(LAST))}@${pick(DOMAINS)}`;
    case 'phone':
      return `+1-${200 + r(800)}-${100 + r(900)}-${1000 + r(9000)}`;
    case 'uuid':
      return newId();
    case 'int':
      return r(10000);
    case 'decimal':
      return Math.round(r(100000)) / 100;
    case 'boolean':
      return Math.random() < 0.5;
    case 'date':
      return new Date(Date.now() - r(1e10)).toISOString().slice(0, 10);
    case 'datetime':
      return new Date(Date.now() - r(1e10)).toISOString();
    case 'company':
      return `${pick(COMPANY)} ${pick(['Inc', 'LLC', 'Ltd', 'Corp'])}`;
    case 'city':
      return pick(CITY);
    case 'country':
      return pick(COUNTRY);
    case 'street':
      return `${1 + r(999)} ${pick(STREETS)} St`;
    case 'url':
      return `https://${pick(DOMAINS)}/${slug(pick(WORDS))}`;
    case 'ipv4':
      return `${r(256)}.${r(256)}.${r(256)}.${r(256)}`;
    case 'word':
      return pick(WORDS);
    case 'sentence':
      return Array.from({ length: 5 + r(6) }, () => pick(WORDS)).join(' ');
    case 'color':
      return '#' + r(0x1000000).toString(16).padStart(6, '0');
    case 'tckn':
      return randomTckn();
    case 'vkn':
      return randomVkn();
    case 'iban':
      return randomTrIban();
  }
}

export function generateRows(
  fields: FakeField[],
  count: number,
): Record<string, string | number | boolean>[] {
  const n = Math.max(1, Math.min(count, 5000));
  return Array.from({ length: n }, () => {
    const row: Record<string, string | number | boolean> = {};
    for (const f of fields) row[f.name] = generateValue(f.type);
    return row;
  });
}

function sqlValue(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  return `'${String(v).replace(/'/g, "''")}'`;
}

function csvValue(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const plainValue = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/** A SQL value tuple like `(1, 'Ada', 0)` for one record. */
const sqlTuple = (row: Record<string, unknown>, cols: string[]): string =>
  `(${cols.map((c) => sqlValue(row[c])).join(', ')})`;

/**
 * One formatted string per record, used for the per-row copy list in the UI.
 * When `sqlBulk` is set, SQL rows are the bare value tuples (the shared
 * `INSERT INTO … VALUES` header lives in {@link formatOutput}).
 */
export function formatRows(
  rows: Record<string, string | number | boolean>[],
  format: OutputFormat,
  tableName = 'data',
  sqlBulk = false,
): string[] {
  if (rows.length === 0) return [];
  const cols = Object.keys(rows[0]!);
  switch (format) {
    case 'json':
      return rows.map((row) => JSON.stringify(row));
    case 'csv':
      return rows.map((row) => cols.map((c) => csvValue(row[c])).join(','));
    case 'plain':
      return rows.map((row) => cols.map((c) => plainValue(row[c])).join(' '));
    case 'sql': {
      if (sqlBulk) return rows.map((row) => sqlTuple(row, cols));
      const colList = cols.map((c) => `"${c}"`).join(', ');
      return rows.map(
        (row) => `INSERT INTO ${tableName} (${colList}) VALUES ${sqlTuple(row, cols)};`,
      );
    }
  }
}

export function formatOutput(
  rows: Record<string, string | number | boolean>[],
  format: OutputFormat,
  tableName = 'data',
  sqlBulk = false,
): string {
  if (rows.length === 0) return '';
  const cols = Object.keys(rows[0]!);
  if (format === 'json') return JSON.stringify(rows, null, 2);
  // CSV keeps a header row.
  if (format === 'csv') {
    return [cols.map(csvValue).join(','), ...formatRows(rows, 'csv')].join('\n');
  }
  // A single multi-row INSERT: one header + comma-separated value tuples.
  if (format === 'sql' && sqlBulk) {
    const colList = cols.map((c) => `"${c}"`).join(', ');
    const tuples = formatRows(rows, 'sql', tableName, true).map((t) => `  ${t}`);
    return `INSERT INTO ${tableName} (${colList}) VALUES\n${tuples.join(',\n')};`;
  }
  return formatRows(rows, format, tableName, sqlBulk).join('\n');
}
