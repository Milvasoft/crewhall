// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/json-toml/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { jsonToToml, tomlToJson } from './logic';

describe('json-toml', () => {
  it('round-trips a JSON object through TOML', () => {
    const json = JSON.stringify({
      title: 'TOML',
      owner: { name: 'Ada' },
      ports: [80, 443],
      enabled: true,
    });
    const toml = jsonToToml(json);
    expect(JSON.parse(tomlToJson(toml))).toEqual(JSON.parse(json));
  });

  it('parses TOML to JSON', () => {
    expect(JSON.parse(tomlToJson('a = 1\nb = "x"'))).toEqual({ a: 1, b: 'x' });
  });

  it('throws on invalid TOML', () => {
    expect(() => tomlToJson('= nope')).toThrow();
  });

  it('throws on invalid JSON', () => {
    expect(() => jsonToToml('{not valid json')).toThrow();
  });

  it('round-trips nested arrays of tables', () => {
    const json = JSON.stringify({
      servers: [
        { name: 'alpha', ip: '10.0.0.1' },
        { name: 'beta', ip: '10.0.0.2' },
      ],
    });
    const toml = jsonToToml(json);
    expect(JSON.parse(tomlToJson(toml))).toEqual(JSON.parse(json));
  });

  it('respects the indent parameter when converting TOML to JSON', () => {
    const compact = tomlToJson('a = 1', 0);
    const indented = tomlToJson('a = 1', 4);
    expect(compact).toBe('{"a":1}');
    expect(indented).toBe('{\n    "a": 1\n}');
  });

  it('parses floats, booleans and negative numbers from TOML', () => {
    expect(JSON.parse(tomlToJson('f = 1.5\nb = false\nn = -3'))).toEqual({
      f: 1.5,
      b: false,
      n: -3,
    });
  });

  it('throws converting a JSON array/root value that TOML cannot represent as a document', () => {
    expect(() => jsonToToml('[1,2,3]')).toThrow();
  });

  it('throws on TOML integers that cannot be represented losslessly as JS numbers', () => {
    expect(() => tomlToJson('n = 9007199254740993')).toThrow();
  });
});
