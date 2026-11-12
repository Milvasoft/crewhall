// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/json-yaml/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { jsonToYaml, yamlToJson } from './logic';

describe('json-yaml', () => {
  it('converts JSON to YAML', () => {
    const yaml = jsonToYaml('{"name":"Ada","tags":["a","b"],"nested":{"x":1}}');
    expect(yaml).toContain('name: Ada');
    expect(yaml).toContain('- a');
    expect(yaml).toContain('x: 1');
  });

  it('converts YAML to JSON', () => {
    const json = JSON.parse(yamlToJson('name: Ada\nage: 30\nlist:\n  - 1\n  - 2\n'));
    expect(json).toEqual({ name: 'Ada', age: 30, list: [1, 2] });
  });

  it('round-trips', () => {
    const original = { a: 1, b: [true, null, 'x'], c: { d: 'e' } };
    const back = JSON.parse(yamlToJson(jsonToYaml(JSON.stringify(original))));
    expect(back).toEqual(original);
  });

  it('throws on invalid JSON', () => {
    expect(() => jsonToYaml('{not json}')).toThrow();
  });

  it('throws on invalid YAML', () => {
    expect(() => yamlToJson('key: [1,2')).toThrow();
  });

  it('throws on duplicate YAML keys', () => {
    expect(() => yamlToJson('a: 1\na: 2\n')).toThrow();
  });

  it('treats empty YAML input as null', () => {
    expect(yamlToJson('')).toBe('null');
    expect(yamlToJson('   \n')).toBe('null');
  });

  it('respects a custom indent in yamlToJson', () => {
    expect(yamlToJson('a: 1', 4)).toBe(JSON.stringify({ a: 1 }, null, 4));
  });

  it('round-trips unicode content', () => {
    const original = { name: 'İstanbul café 🎉', note: 'line1\nline2' };
    const back = JSON.parse(yamlToJson(jsonToYaml(JSON.stringify(original))));
    expect(back).toEqual(original);
  });

  it('converts a top-level JSON array', () => {
    const yaml = jsonToYaml('[1,2,3]');
    expect(yaml.trim().split('\n')).toEqual(['- 1', '- 2', '- 3']);
  });
});
