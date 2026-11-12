// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/json-csv/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { csvToJson, jsonToCsv, parseCsv } from './logic';

describe('json-csv', () => {
  it('converts array of objects to CSV with a header', () => {
    const csv = jsonToCsv('[{"a":1,"b":"x"},{"a":2,"b":"y"}]');
    expect(csv).toBe('a,b\n1,x\n2,y');
  });

  it('unions columns across rows', () => {
    const csv = jsonToCsv('[{"a":1},{"b":2}]');
    expect(csv.split('\n')[0]).toBe('a,b');
  });

  it('quotes fields containing commas, quotes and newlines', () => {
    const csv = jsonToCsv('[{"a":"x,y","b":"he said \\"hi\\""}]');
    expect(csv).toContain('"x,y"');
    expect(csv).toContain('"he said ""hi"""');
  });

  it('parses quoted CSV correctly', () => {
    const rows = parseCsv('a,b\n"1,2","he said ""hi"""');
    expect(rows[1]).toEqual(['1,2', 'he said "hi"']);
  });

  it('converts CSV to JSON coercing scalars', () => {
    const json = JSON.parse(csvToJson('a,b,c\n1,true,text'));
    expect(json).toEqual([{ a: 1, b: true, c: 'text' }]);
  });

  it('round-trips', () => {
    const original = '[{"id":1,"name":"Ada"},{"id":2,"name":"Grace"}]';
    expect(JSON.parse(csvToJson(jsonToCsv(original)))).toEqual(JSON.parse(original));
  });

  it('wraps a single JSON object as one CSV row', () => {
    expect(jsonToCsv('{"a":1,"b":"x"}')).toBe('a,b\n1,x');
  });

  it('returns an empty string for an empty array', () => {
    expect(jsonToCsv('[]')).toBe('');
  });

  it("uses a single 'value' column for an array of primitives", () => {
    expect(jsonToCsv('[1,2,3]')).toBe('value\n1\n2\n3');
  });

  it('fills missing trailing fields as empty when a row is shorter than the header', () => {
    const json = JSON.parse(csvToJson('a,b,c\n1,2'));
    expect(json).toEqual([{ a: 1, b: 2, c: '' }]);
  });

  it('ignores extra fields beyond the header on a ragged row', () => {
    const json = JSON.parse(csvToJson('a,b\n1,2,3,4'));
    expect(json).toEqual([{ a: 1, b: 2 }]);
  });

  it('handles a single-column CSV', () => {
    const json = JSON.parse(csvToJson('name\nAda\nGrace'));
    expect(json).toEqual([{ name: 'Ada' }, { name: 'Grace' }]);
  });

  it('returns an empty array for empty/whitespace CSV input', () => {
    expect(csvToJson('')).toBe('[]');
    expect(csvToJson('   ')).toBe('[]');
  });
});
