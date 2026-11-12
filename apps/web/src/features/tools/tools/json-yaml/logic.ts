// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/json-yaml/logic.ts. See THIRD_PARTY.md.
import { dump, load } from 'js-yaml';

export function jsonToYaml(jsonText: string): string {
  const value = JSON.parse(jsonText) as unknown;
  return dump(value, { indent: 2, lineWidth: -1, noRefs: true });
}

export function yamlToJson(yamlText: string, indent = 2): string {
  const value = load(yamlText);
  return JSON.stringify(value ?? null, null, indent);
}
