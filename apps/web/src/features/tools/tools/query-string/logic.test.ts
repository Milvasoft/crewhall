// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/query-string/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { buildQueryString, parseQueryString } from './logic';

describe('query-string', () => {
  it('builds a query string with encoding', () => {
    expect(buildQueryString('{"q":"a b","page":2}')).toBe('q=a+b&page=2');
  });

  it('expands arrays to repeated keys', () => {
    expect(buildQueryString('{"tag":["a","b"]}')).toBe('tag=a&tag=b');
  });

  it('parses a query string to JSON', () => {
    expect(JSON.parse(parseQueryString('?q=a+b&page=2'))).toEqual({
      q: 'a b',
      page: '2',
    });
  });

  it('collapses repeated keys into arrays', () => {
    expect(JSON.parse(parseQueryString('tag=a&tag=b'))).toEqual({ tag: ['a', 'b'] });
  });

  it('rejects non-object JSON', () => {
    expect(() => buildQueryString('"x"')).toThrow();
  });

  it('rejects a JSON array and JSON null at the top level', () => {
    expect(() => buildQueryString('[1,2]')).toThrow(/provide a json object/i);
    expect(() => buildQueryString('null')).toThrow(/provide a json object/i);
  });

  it('throws on malformed JSON input', () => {
    expect(() => buildQueryString('not json')).toThrow();
  });

  it('returns an empty object for an empty query string', () => {
    expect(parseQueryString('')).toBe('{}');
  });

  it('encodes null and undefined values as an empty string', () => {
    expect(buildQueryString('{"a":null}')).toBe('a=');
  });

  it('round-trips Unicode values through build and parse', () => {
    const qs = buildQueryString('{"q":"héllo 😀"}');
    expect(JSON.parse(parseQueryString(qs))).toEqual({ q: 'héllo 😀' });
  });

  it('honors a custom indent for parseQueryString', () => {
    expect(parseQueryString('a=1', 0)).toBe('{"a":"1"}');
  });
});
