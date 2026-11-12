// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/smart-paste/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { detectContent } from './logic';

const primary = (s: string) => detectContent(s)[0]?.type;

describe('smart-paste detection', () => {
  it('detects JSON', () => {
    expect(primary('{"name":"John"}')).toBe('json');
    expect(primary('[1, 2, 3]')).toBe('json');
  });

  it('detects a JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMifQ.sig';
    expect(primary(jwt)).toBe('jwt');
    expect(detectContent(jwt)[0]!.toolIds).toContain('jwt-decoder');
  });

  it('detects SQL', () => {
    expect(primary('SELECT * FROM users WHERE id = 1;')).toBe('sql');
  });

  it('detects XML vs HTML', () => {
    expect(primary('<note><to>A</to></note>')).toBe('xml');
    expect(primary('<div><p>hi</p></div>')).toBe('html');
  });

  it('detects URL, UUID, timestamp', () => {
    expect(primary('https://example.com/path?x=1')).toBe('url');
    expect(primary('3fa85f64-5717-4562-b3fc-2c963f66afa6')).toBe('uuid');
    expect(primary('1700000000')).toBe('timestamp');
  });

  it('detects a data-URI image', () => {
    expect(primary('data:image/png;base64,AAAA')).toBe('image');
  });

  it('detects CSV and cron', () => {
    expect(primary('a,b,c\n1,2,3')).toBe('csv');
    expect(primary('*/5 * * * *')).toBe('cron');
  });

  it('detects a connection string', () => {
    expect(primary('Server=localhost;Database=test;User Id=sa')).toBe('connection-string');
  });

  it('returns nothing for empty input', () => {
    expect(detectContent('   ')).toEqual([]);
    expect(detectContent('')).toEqual([]);
  });

  it("rejects a JWT-shaped string whose header isn't valid JSON", () => {
    // Three dot-separated base64url-ish segments, but decoding the first
    // segment doesn't yield a JSON object with "alg" — should not throw and
    // should not be classified as anything.
    expect(detectContent('abc.def.ghi')).toEqual([]);
  });

  it('excludes the base64 detector when a JWT is already detected', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMifQ.sig';
    const types = detectContent(jwt).map((d) => d.type);
    expect(types).toContain('jwt');
    expect(types).not.toContain('base64');
  });

  it('only treats exactly 10 or 13 digit numbers as a timestamp', () => {
    expect(detectContent('123456789')).toEqual([]); // 9 digits
    expect(detectContent('12345678901')).toEqual([]); // 11 digits
    expect(primary('1700000000')).toBe('timestamp'); // 10 digits (seconds)
    expect(primary('1700000000000')).toBe('timestamp'); // 13 digits (ms)
  });

  it('requires a semicolon for a connection string, not just key=value pairs', () => {
    expect(detectContent('Server=localhost Database=test')).toEqual([]);
    expect(primary('Server=localhost;Database=test')).toBe('connection-string');
  });

  it('is case-insensitive and tolerant of a UUID, but rejects a malformed one', () => {
    expect(primary('3FA85F64-5717-4562-B3FC-2C963F66AFA6')).toBe('uuid');
    expect(detectContent('3fa85f64-5717-4562-b3fc-2c963f66afa')).toEqual([]); // one hex digit short
  });

  it('tolerates a CSV column-count drift of at most 1, and rejects more', () => {
    expect(primary('a,b,c\n1,2,3,4')).toBe('csv'); // header has 3, row has 4: tolerated
    expect(detectContent('a,b,c\n1,2,3,4,5')).not.toContainEqual(
      expect.objectContaining({ type: 'csv' }),
    ); // drift of 2 from the header count: rejected
  });

  it('recognizes a 6-field cron expression (with seconds) but not multi-line or wrong field counts', () => {
    expect(primary('*/5 * * * * *')).toBe('cron'); // 6 fields
    expect(detectContent('*/5 * * *')).toEqual([]); // 4 fields, too few
  });

  it('detects YAML for list/mapping shapes, but not for plain prose', () => {
    expect(primary('- a\n- b\n- c')).toBe('yaml');
    expect(detectContent('just some plain text here')).toEqual([]);
  });

  it('requires a minimum length and a multiple-of-4 length for base64', () => {
    expect(detectContent('QUJDREVGR3g')).toEqual([]); // 11 chars: too short / not %4
    expect(primary('QUJDREVGR3g=')).toBe('base64'); // 12 chars, valid padding
  });

  it('recognizes a base64-encoded image data URI distinctly from an image mime detection', () => {
    expect(primary('data:image/jpeg;base64,/9j/4AAQ')).toBe('image');
  });
});
