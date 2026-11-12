// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/connection-string/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { connectionStringToJson, jsonToConnectionString, parseConnectionString } from './logic';

describe('connection-string', () => {
  it('parses key/value pairs preserving case', () => {
    const parsed = parseConnectionString('Server=localhost;Database=test;User Id=sa;Password=p@ss');
    expect(parsed).toEqual({
      Server: 'localhost',
      Database: 'test',
      'User Id': 'sa',
      Password: 'p@ss',
    });
  });

  it("keeps '=' inside values", () => {
    expect(parseConnectionString('Data=a=b;X=1')).toEqual({ Data: 'a=b', X: '1' });
  });

  it('ignores empty segments', () => {
    expect(parseConnectionString('A=1;;B=2;')).toEqual({ A: '1', B: '2' });
  });

  it('round-trips', () => {
    const cs = 'Server=localhost;Database=test';
    expect(jsonToConnectionString(connectionStringToJson(cs))).toBe(cs);
  });

  it('rejects non-object JSON', () => {
    expect(() => jsonToConnectionString('[1,2]')).toThrow();
  });

  it('rejects malformed JSON', () => {
    expect(() => jsonToConnectionString('{not json}')).toThrow();
  });

  it('last value wins for a duplicate key', () => {
    expect(parseConnectionString('A=1;A=2')).toEqual({ A: '2' });
  });

  it("ignores segments without '='", () => {
    expect(parseConnectionString('Server=localhost;JustAFlag;Database=test')).toEqual({
      Server: 'localhost',
      Database: 'test',
    });
  });

  it('ignores segments with a blank key', () => {
    expect(parseConnectionString('  =value;A=1')).toEqual({ A: '1' });
  });

  it('trims whitespace around keys and values', () => {
    expect(parseConnectionString(' Server = localhost ; Database = test ')).toEqual({
      Server: 'localhost',
      Database: 'test',
    });
  });

  it('returns an empty object for empty input', () => {
    expect(parseConnectionString('')).toEqual({});
  });

  it('renders null/missing values as empty strings', () => {
    expect(jsonToConnectionString('{"A":null,"B":"x"}')).toBe('A=;B=x');
  });

  it('stringifies non-string JSON values', () => {
    expect(jsonToConnectionString('{"A":1,"B":true}')).toBe('A=1;B=true');
  });

  it('respects a custom indent in connectionStringToJson', () => {
    const json = connectionStringToJson('A=1', 4);
    expect(json).toBe(JSON.stringify({ A: '1' }, null, 4));
  });
});
