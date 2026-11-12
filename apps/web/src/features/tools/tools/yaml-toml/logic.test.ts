// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/yaml-toml/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';
import { tomlToYaml, yamlToToml } from './logic';

describe('yaml-toml', () => {
  it('converts YAML to TOML', () => {
    const toml = yamlToToml('name: Ada\nports:\n  - 80\n  - 443\n');
    expect(toml).toContain('name = "Ada"');
    expect(toml).toContain('ports = [');
  });

  it('round-trips through TOML back to an equivalent object', () => {
    const yaml = 'title: T\nowner:\n  name: Ada\nenabled: true\n';
    const toml = yamlToToml(yaml);
    expect(load(tomlToYaml(toml))).toEqual(load(yaml));
  });

  it('rejects a non-mapping YAML root', () => {
    expect(() => yamlToToml('- 1\n- 2\n')).toThrow();
  });

  it('rejects a scalar or null YAML root', () => {
    expect(() => yamlToToml('just text')).toThrow();
    expect(() => yamlToToml('~')).toThrow();
    expect(() => yamlToToml('')).toThrow();
  });

  it('throws on malformed YAML', () => {
    expect(() => yamlToToml('key: [unclosed')).toThrow();
  });

  it('throws on malformed TOML', () => {
    expect(() => tomlToYaml('key = [')).toThrow();
  });

  it('converts an empty TOML document to an empty YAML mapping', () => {
    expect(load(tomlToYaml(''))).toEqual({});
  });
});
