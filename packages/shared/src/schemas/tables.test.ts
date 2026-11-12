import { describe, expect, it } from 'vitest';
import type { TableField, TableFieldOptions, TableFieldType } from './tables';
import {
  applyView,
  coerceCell,
  computeRows,
  inferFieldType,
  parseCsv,
  parseDate,
  parseNumber,
  toCsv,
  type EngineRow,
} from './tables-engine';
import { FormulaError, evaluateFormula, parseFormula } from './tables-formula';

let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const TABLE = '00000000-0000-4000-8000-0000000000aa';
const field = (
  name: string,
  type: TableFieldType,
  options: TableFieldOptions = {},
  primary = false,
): TableField => ({
  id: uuid(),
  tableId: TABLE,
  name,
  type,
  options,
  description: null,
  primary,
  position: `a${n}`,
});
const row = (values: EngineRow['values'], position: string): EngineRow => ({
  id: uuid(),
  values,
  position,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-02T10:00:00.000Z',
});

describe('formula language', () => {
  const run = (src: string, vars: Record<string, unknown> = {}) =>
    evaluateFormula(
      parseFormula(src),
      (k) => (vars[k] ?? null) as never,
      new Date('2026-10-29T12:00:00Z'),
    );

  it('computes arithmetic, text, logic and dates', () => {
    expect(run('1 + 2 * 3')).toBe(7);
    expect(run('({Fiyat} - 10) / 2', { Fiyat: 30 })).toBe(10);
    expect(run('{Ad} & " " & UPPER({Soyad})', { Ad: 'Ayşe', Soyad: 'yılmaz' })).toBe('Ayşe YILMAZ');
    expect(run('IF({Adet} > 5, "çok", "az")', { Adet: 7 })).toBe('çok');
    expect(run('AND(TRUE, {x} = 2)', { x: 2 })).toBe(true);
    expect(run('ROUND(AVG(1, 2, 2), 2)')).toBe(1.67);
    expect(run('DATEDIFF("2026-11-10", "2026-11-01", "days")')).toBe(9);
    expect(run('DATEADD("2026-01-31", 1, "days")')).toBe('2026-02-01');
    expect(run('TODAY()')).toBe('2026-10-29');
    expect(run('SUM({Liste})', { Liste: [1, 2, 3] })).toBe(6);
  });

  it('rejects bad syntax and fails on errors at run time', () => {
    expect(() => parseFormula('1 +')).toThrow(FormulaError);
    expect(() => parseFormula('NOPE(1)')).toThrow(FormulaError);
    expect(() => parseFormula('"açık')).toThrow(FormulaError);
    expect(() => run('1 / 0')).toThrow(FormulaError);
  });
});

describe('cell coercion', () => {
  it('normalizes values written by people, forms and imports', () => {
    const status = field('Durum', 'single_select', {
      choices: [
        { id: 'new', label: 'Yeni', color: 'blue' },
        { id: 'won', label: 'Kazanıldı', color: 'green' },
      ],
    });
    expect(coerceCell(status, 'kazanıldı')).toEqual({ ok: true, value: 'won' });
    expect(coerceCell(status, 'yok')).toEqual({ ok: false, error: 'unknown_choice' });
    expect(coerceCell(field('Tutar', 'currency'), '1.234,50 ₺')).toEqual({
      ok: true,
      value: 1234.5,
    });
    expect(coerceCell(field('Tarih', 'date'), '29.10.2026')).toEqual({
      ok: true,
      value: '2026-10-29',
    });
    expect(coerceCell(field('Onay', 'checkbox'), 'evet')).toEqual({ ok: true, value: true });
    expect(coerceCell(field('Site', 'url'), 'crewhall.dev/x')).toEqual({
      ok: true,
      value: 'https://crewhall.dev/x',
    });
    expect(coerceCell(field('Posta', 'email'), 'yok')).toEqual({ ok: false, error: 'invalid' });
    expect(coerceCell(field('Puan', 'rating', { max: 5 }), 9)).toEqual({
      ok: false,
      error: 'out_of_range',
    });
    expect(coerceCell(field('F', 'formula'), 1)).toEqual({ ok: false, error: 'computed' });
  });

  it('parses numbers and dates in Turkish and English forms', () => {
    expect(parseNumber('1,234.5')).toBe(1234.5);
    expect(parseNumber('1.234,5')).toBe(1234.5);
    expect(parseDate('2026-10-29T14:30:00Z', true)).toBe('2026-10-29T14:30:00.000Z');
    expect(parseDate('31.02.2026')).toBeNull();
  });
});

describe('engine', () => {
  const name = field('Ad', 'text', {}, true);
  const qty = field('Adet', 'number');
  const price = field('Fiyat', 'currency');
  const total = field('Toplam', 'formula', { formula: '{Adet} * {Fiyat}' });
  const loopA = field('A', 'formula', { formula: '{B} + 1' });
  const loopB = field('B', 'formula', { formula: '{A} + 1' });
  const kind = field('Tür', 'single_select', {
    choices: [
      { id: 'hw', label: 'Donanım', color: 'blue' },
      { id: 'sw', label: 'Yazılım', color: 'green' },
    ],
  });
  const fields = [name, qty, price, total, loopA, loopB, kind];
  const rows = [
    row({ [name.id]: 'Laptop', [qty.id]: 2, [price.id]: 1000, [kind.id]: 'hw' }, 'a1'),
    row({ [name.id]: 'Lisans', [qty.id]: 10, [price.id]: 50, [kind.id]: 'sw' }, 'a2'),
    row({ [name.id]: 'Fare', [qty.id]: 5, [price.id]: 20, [kind.id]: 'hw' }, 'a3'),
    row({ [name.id]: 'İsimsiz' }, 'a4'),
  ];

  it('computes formulas and leaves cycles empty', () => {
    const out = computeRows(fields, rows, new Map());
    expect(out.map((r) => r.values[total.id])).toEqual([2000, 500, 100, 0]);
    expect(out[0]!.values[loopA.id]).toBeNull();
  });

  it('computes lookups and rollups through relations', () => {
    const order = field('Ürünler', 'relation', { tableId: TABLE, multiple: true });
    const sum = field('Tutar', 'rollup', {
      relationFieldId: order.id,
      targetFieldId: price.id,
      fn: 'sum',
    });
    const names = field('Adlar', 'lookup', { relationFieldId: order.id, targetFieldId: name.id });
    const orders = [row({ [order.id]: [rows[0]!.id, rows[2]!.id] }, 'b1')];
    const [o] = computeRows([order, sum, names], orders, new Map([[TABLE, { fields, rows }]]));
    expect(o!.values[sum.id]).toBe(1020);
    expect(o!.values[names.id]).toEqual(['Laptop', 'Fare']);
  });

  it('filters, searches, sorts with empties last and groups', () => {
    const computed = computeRows(fields, rows, new Map());
    const byTotal = applyView(fields, computed, { sorts: [{ fieldId: total.id, dir: 'desc' }] });
    expect(byTotal.rows.map((r) => r.values[name.id])).toEqual([
      'Laptop',
      'Lisans',
      'Fare',
      'İsimsiz',
    ]);
    const cheap = applyView(fields, computed, {
      filters: [{ fieldId: price.id, op: 'lt', value: '100' }],
    });
    expect(cheap.rows.map((r) => r.values[name.id])).toEqual(['Lisans', 'Fare']);
    const either = applyView(fields, computed, {
      filterMode: 'or',
      filters: [
        { fieldId: kind.id, op: 'is', value: 'sw' },
        { fieldId: name.id, op: 'starts_with', value: 'f' },
      ],
    });
    expect(either.rows).toHaveLength(2);
    expect(applyView(fields, computed, {}, { q: 'lis' }).rows).toHaveLength(1);
    const grouped = applyView(fields, computed, { groupBy: kind.id });
    expect(grouped.groups).toEqual([
      { key: 'hw', count: 2, start: 0 },
      { key: 'sw', count: 1, start: 2 },
      { key: '', count: 1, start: 3 },
    ]);
  });
});

describe('import helpers', () => {
  it('reads CSV (comma or semicolon, quotes) and guesses types', () => {
    expect(parseCsv('Ad;Adet\n"Laptop; 15""";2\nFare;5\n')).toEqual([
      ['Ad', 'Adet'],
      ['Laptop; 15"', '2'],
      ['Fare', '5'],
    ]);
    expect(inferFieldType(['1', '2,5', '1.000'])).toBe('number');
    expect(inferFieldType(['29.10.2026', '2026-11-01'])).toBe('date');
    expect(inferFieldType(['evet', 'hayır'])).toBe('checkbox');
    expect(inferFieldType(['a@b.co', 'c@d.io'])).toBe('email');
    expect(inferFieldType(['A', 'B', 'A', 'B', 'A', 'B', 'A'])).toBe('single_select');
    expect(toCsv([['a,b', 'c']])).toBe('﻿"a,b",c\r\n');
  });
});
