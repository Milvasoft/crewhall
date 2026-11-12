// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/fake-data/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import {
  FAKE_TYPES,
  formatOutput,
  formatRows,
  generateRows,
  generateValue,
  isValidTckn,
  isValidTrIban,
  isValidVkn,
} from './logic';

describe('fake-data', () => {
  it('generates rows matching the schema', () => {
    const rows = generateRows(
      [
        { name: 'id', type: 'uuid' },
        { name: 'email', type: 'email' },
      ],
      5,
    );
    expect(rows).toHaveLength(5);
    expect(Object.keys(rows[0]!)).toEqual(['id', 'email']);
    expect(String(rows[0]!.email)).toContain('@');
  });

  it('produces valid value types', () => {
    expect(typeof generateValue('int')).toBe('number');
    expect(typeof generateValue('boolean')).toBe('boolean');
    expect(String(generateValue('ipv4'))).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });

  it('formats as JSON, CSV and SQL', () => {
    const rows = [{ id: 1, name: 'Ada' }];
    expect(JSON.parse(formatOutput(rows, 'json'))).toEqual(rows);
    expect(formatOutput(rows, 'csv')).toBe('id,name\n1,Ada');
    expect(formatOutput(rows, 'sql', 'users')).toContain(
      'INSERT INTO users ("id", "name") VALUES (1, \'Ada\');',
    );
  });

  const VALIDATORS: Record<string, (v: string | number | boolean) => void> = {
    firstName: (v) => expect(String(v)).toMatch(/^[A-Za-z]+$/),
    lastName: (v) => expect(String(v)).toMatch(/^[A-Za-z]+$/),
    fullName: (v) => expect(String(v)).toMatch(/^[A-Za-z]+ [A-Za-z]+$/),
    email: (v) => expect(String(v)).toMatch(/^[a-z]+\.[a-z]+@[a-z.]+$/),
    username: (v) => expect(String(v)).toMatch(/^[a-z]+\d+$/),
    phone: (v) => expect(String(v)).toMatch(/^\+1-\d{3}-\d{3}-\d{4}$/),
    uuid: (v) =>
      expect(String(v)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
    int: (v) => {
      expect(Number.isInteger(v)).toBe(true);
      expect(v as number).toBeGreaterThanOrEqual(0);
      expect(v as number).toBeLessThan(10000);
    },
    decimal: (v) => {
      expect(v as number).toBeGreaterThanOrEqual(0);
      expect(v as number).toBeLessThan(1000);
      expect(Math.round((v as number) * 100)).toBeCloseTo((v as number) * 100, 6);
    },
    boolean: (v) => expect(typeof v).toBe('boolean'),
    date: (v) => expect(String(v)).toMatch(/^\d{4}-\d{2}-\d{2}$/),
    datetime: (v) => expect(String(v)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    company: (v) => expect(String(v)).toMatch(/^[A-Za-z]+ (Inc|LLC|Ltd|Corp)$/),
    city: (v) => expect(String(v)).toMatch(/^[A-Za-z]+$/),
    country: (v) => expect(String(v)).toMatch(/^[A-Za-z]+$/),
    street: (v) => expect(String(v)).toMatch(/^\d+ [A-Za-z]+ St$/),
    url: (v) => expect(String(v)).toMatch(/^https:\/\/[a-z.]+\/[a-z]+$/),
    ipv4: (v) => expect(String(v)).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/),
    word: (v) => expect(String(v)).toMatch(/^[a-z]+$/),
    sentence: (v) => expect(String(v).split(' ').length).toBeGreaterThanOrEqual(5),
    color: (v) => expect(String(v)).toMatch(/^#[0-9a-f]{6}$/),
    tckn: (v) => {
      expect(String(v)).toMatch(/^[1-9]\d{10}$/);
      expect(isValidTckn(String(v))).toBe(true);
    },
    vkn: (v) => {
      expect(String(v)).toMatch(/^\d{10}$/);
      expect(isValidVkn(String(v))).toBe(true);
    },
    iban: (v) => {
      expect(String(v)).toMatch(/^TR\d{24}$/);
      expect(isValidTrIban(String(v))).toBe(true);
    },
  };

  it('produces validly formatted values for every fake type', () => {
    expect(Object.keys(VALIDATORS).sort()).toEqual([...FAKE_TYPES].sort());
    for (const type of FAKE_TYPES) {
      // Sample several times since output is random.
      for (let i = 0; i < 5; i++) {
        VALIDATORS[type]!(generateValue(type));
      }
    }
  });

  it('generates distinct uuids across calls', () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateValue('uuid')));
    expect(ids.size).toBe(20);
  });

  it('clamps the row count to at least 1 and at most 5000', () => {
    expect(generateRows([{ name: 'n', type: 'int' }], 0)).toHaveLength(1);
    expect(generateRows([{ name: 'n', type: 'int' }], -5)).toHaveLength(1);
    expect(generateRows([{ name: 'n', type: 'int' }], 10000)).toHaveLength(5000);
  });

  it('produces empty row objects when there are no fields', () => {
    const rows = generateRows([], 3);
    expect(rows).toEqual([{}, {}, {}]);
  });

  it('formats an empty row set as an empty string in every format', () => {
    expect(formatOutput([], 'json')).toBe('');
    expect(formatOutput([], 'csv')).toBe('');
    expect(formatOutput([], 'sql')).toBe('');
  });

  it('quotes CSV values containing commas, quotes or newlines', () => {
    const rows = [{ note: 'has, a "quote"\nand a newline' }];
    const csv = formatOutput(rows, 'csv');
    expect(csv).toBe('note\n"has, a ""quote""\nand a newline"');
  });

  it('renders NULL for missing SQL values and 0/1 for booleans', () => {
    const rows = [{ a: undefined, flag: true, other: false }] as unknown as Record<
      string,
      string | number | boolean
    >[];
    const sql = formatOutput(rows, 'sql', 't');
    expect(sql).toBe('INSERT INTO t ("a", "flag", "other") VALUES (NULL, 1, 0);');
  });

  it('escapes single quotes in SQL string values', () => {
    const rows = [{ name: "O'Brien" }];
    expect(formatOutput(rows, 'sql', 't')).toContain(`'O''Brien'`);
  });

  it('formats plain output as values only, no header or delimiters', () => {
    const rows = [
      { tckn: '10000000146', city: 'Istanbul' },
      { tckn: '10000000254', city: 'Ankara' },
    ];
    expect(formatOutput(rows, 'plain')).toBe('10000000146 Istanbul\n10000000254 Ankara');
  });

  it('emits a single multi-row INSERT when sqlBulk is set', () => {
    const rows = [
      { id: 1, name: 'Ada' },
      { id: 2, name: 'Al' },
    ];
    expect(formatOutput(rows, 'sql', 'users', true)).toBe(
      'INSERT INTO users ("id", "name") VALUES\n  (1, \'Ada\'),\n  (2, \'Al\');',
    );
    expect(formatRows(rows, 'sql', 'users', true)).toEqual(["(1, 'Ada')", "(2, 'Al')"]);
  });

  it('formatRows returns one string per record for each format', () => {
    const rows = [
      { id: 1, name: 'Ada' },
      { id: 2, name: 'Al' },
    ];
    expect(formatRows(rows, 'json')).toEqual(['{"id":1,"name":"Ada"}', '{"id":2,"name":"Al"}']);
    expect(formatRows(rows, 'csv')).toEqual(['1,Ada', '2,Al']);
    expect(formatRows(rows, 'plain')).toEqual(['1 Ada', '2 Al']);
    expect(formatRows(rows, 'sql', 't')[0]).toBe(
      'INSERT INTO t ("id", "name") VALUES (1, \'Ada\');',
    );
    expect(formatRows([], 'csv')).toEqual([]);
  });

  it('rejects malformed or bad-checksum TCKN, VKN and IBAN', () => {
    expect(isValidTckn('00000000000')).toBe(false); // leading zero
    expect(isValidTckn('12345678901')).toBe(false); // bad checksum
    expect(isValidVkn('1234567890')).toBe(true); // valid (check digit 0)
    expect(isValidVkn('1234567891')).toBe(false); // wrong check digit
    expect(isValidTrIban('TR000000000000000000000000')).toBe(false);
    expect(isValidTrIban('DE00')).toBe(false);
  });
});
