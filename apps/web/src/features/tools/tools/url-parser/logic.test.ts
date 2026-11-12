// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/url-parser/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { parsedToJson, parseUrl } from './logic';

describe('url-parser', () => {
  it('parses URL parts and query params', () => {
    const p = parseUrl('https://user:pw@ex.com:8080/a/b?x=1&y=2&x=3#frag');
    expect(p.protocol).toBe('https:');
    expect(p.hostname).toBe('ex.com');
    expect(p.port).toBe('8080');
    expect(p.pathname).toBe('/a/b');
    expect(p.hash).toBe('#frag');
    expect(p.params).toEqual([
      { key: 'x', value: '1' },
      { key: 'y', value: '2' },
      { key: 'x', value: '3' },
    ]);
  });

  it('collapses repeated params into arrays in JSON', () => {
    const json = JSON.parse(parsedToJson(parseUrl('https://x.com/?a=1&a=2&b=3')));
    expect(json.query).toEqual({ a: ['1', '2'], b: '3' });
  });

  it('throws on invalid URL', () => {
    expect(() => parseUrl('not a url')).toThrow();
  });

  it('throws when the scheme is missing', () => {
    expect(() => parseUrl('example.com/path')).toThrow();
  });

  it('trims surrounding whitespace before parsing', () => {
    const p = parseUrl('  https://x.com/a  ');
    expect(p.href).toBe('https://x.com/a');
  });

  it('returns an empty params array when there is no query string', () => {
    const p = parseUrl('https://x.com/a');
    expect(p.params).toEqual([]);
    expect(p.search).toBe('');
  });

  it('punycode-encodes unicode (IDN) hostnames', () => {
    const p = parseUrl('https://münchen.de/');
    expect(p.hostname).toBe('xn--mnchen-3ya.de');
  });

  it('keeps empty query values', () => {
    const p = parseUrl('https://x.com/?a=&b=2');
    expect(p.params).toEqual([
      { key: 'a', value: '' },
      { key: 'b', value: '2' },
    ]);
  });

  it('collapses 3+ repeated params into an ordered array in JSON', () => {
    const json = JSON.parse(parsedToJson(parseUrl('https://x.com/?a=1&a=2&a=3')));
    expect(json.query).toEqual({ a: ['1', '2', '3'] });
  });
});
