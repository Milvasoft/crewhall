// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/yaml-toml/logic.ts. See THIRD_PARTY.md.
import { dump, load } from 'js-yaml';
import { parse, stringify } from 'smol-toml';

export function yamlToToml(yamlText: string): string {
  const value = load(yamlText) as Record<string, unknown>;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('TOML needs a top-level table (a YAML mapping).');
  }
  return stringify(value);
}

export function tomlToYaml(tomlText: string): string {
  const value = parse(tomlText);
  return dump(value, { indent: 2, lineWidth: -1, noRefs: true });
}
