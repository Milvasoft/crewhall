// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/yaml-viewer/logic.ts. See THIRD_PARTY.md.
import { dump, load } from 'js-yaml';

/**
 * Validate and normalize YAML, or view it as JSON. Pure and local.
 */

export function formatYaml(text: string, sortKeys = false): string {
  const value = load(text);
  return dump(value ?? null, {
    indent: 2,
    lineWidth: -1,
    noRefs: true,
    sortKeys,
  }).trimEnd();
}

export function yamlToJson(text: string, indent = 2): string {
  return JSON.stringify(load(text) ?? null, null, indent);
}
