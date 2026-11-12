// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/yaml-viewer/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { formatYaml, yamlToJson } from './logic';

describe('yaml-viewer', () => {
  it('normalizes messy YAML', () => {
    const out = formatYaml('name:    Ada\nroles: [admin, user]\n');
    expect(out).toContain('name: Ada');
    expect(out).toContain('- admin');
  });

  it('can sort keys', () => {
    const out = formatYaml('b: 2\na: 1\n', true);
    expect(out.indexOf('a: 1')).toBeLessThan(out.indexOf('b: 2'));
  });

  it('converts YAML to JSON', () => {
    expect(JSON.parse(yamlToJson('a: 1\nb: two\n'))).toEqual({ a: 1, b: 'two' });
  });

  it('throws on invalid YAML', () => {
    expect(() => formatYaml('a: [1, 2\n')).toThrow();
  });

  it('also throws from yamlToJson on invalid YAML', () => {
    expect(() => yamlToJson('a: [1, 2\n')).toThrow();
  });

  it('treats empty/whitespace-only input as null', () => {
    expect(formatYaml('')).toBe('null');
    expect(yamlToJson('')).toBe('null');
    expect(yamlToJson('   \n')).toBe('null');
  });

  it('preserves key order when sortKeys is false (the default)', () => {
    const out = formatYaml('b: 2\na: 1\n');
    expect(out.indexOf('b: 2')).toBeLessThan(out.indexOf('a: 1'));
  });

  it('respects a custom indent width in yamlToJson', () => {
    const out = yamlToJson('a:\n  b: 1\n', 4);
    expect(out).toContain('    "b"');
  });

  it('round-trips nested structures and unicode content', () => {
    const yaml = 'name: Ünïcödé 😀\nlist:\n  - one\n  - two\nnested:\n  x: 1\n  y: 2\n';
    const json = JSON.parse(yamlToJson(yaml));
    expect(json).toEqual({
      name: 'Ünïcödé 😀',
      list: ['one', 'two'],
      nested: { x: 1, y: 2 },
    });
  });
});
