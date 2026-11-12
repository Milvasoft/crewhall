// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/json-string/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { jsonToString, stringToJson } from './logic';

describe('json-string', () => {
  it('stringifies JSON into an escaped literal', () => {
    expect(jsonToString('{ "a": 1 }')).toBe('"{\\"a\\":1}"');
  });

  it('parses a quoted string literal back to pretty JSON', () => {
    expect(stringToJson('"{\\"a\\":1}"')).toBe('{\n  "a": 1\n}');
  });

  it('accepts a bare escaped body', () => {
    expect(JSON.parse(stringToJson('{\\"a\\":1}'))).toEqual({ a: 1 });
  });

  it('accepts raw JSON too', () => {
    expect(JSON.parse(stringToJson('{"a":1}'))).toEqual({ a: 1 });
  });

  it('round-trips', () => {
    const original = { name: 'Ada', nested: { x: [1, 2] }, active: true };
    const literal = jsonToString(JSON.stringify(original));
    expect(JSON.parse(stringToJson(literal))).toEqual(original);
  });

  it('throws on invalid JSON', () => {
    expect(() => jsonToString('{not json}')).toThrow();
  });

  it('throws on empty input to both directions', () => {
    expect(() => jsonToString('')).toThrow();
    expect(() => stringToJson('')).toThrow();
  });

  it('throws when a quoted literal decodes to non-JSON text', () => {
    expect(() => stringToJson('"not json"')).toThrow();
  });

  it('round-trips unicode content (emoji and accented characters)', () => {
    const original = { emoji: '😀', accented: 'café' };
    const literal = jsonToString(JSON.stringify(original));
    expect(JSON.parse(stringToJson(literal))).toEqual(original);
  });

  it('round-trips embedded backslashes', () => {
    const original = { path: 'C:\\Users\\a' };
    const literal = jsonToString(JSON.stringify(original));
    expect(JSON.parse(stringToJson(literal))).toEqual(original);
  });

  it('honors a custom indent width, including 0 for compact output', () => {
    expect(stringToJson('{"a":1,"b":2}', 4)).toBe('{\n    "a": 1,\n    "b": 2\n}');
    expect(stringToJson('{"a":1,"b":2}', 0)).toBe('{"a":1,"b":2}');
  });
});
