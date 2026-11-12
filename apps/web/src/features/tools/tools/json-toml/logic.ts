// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/json-toml/logic.ts. See THIRD_PARTY.md.
import { parse, stringify } from 'smol-toml';

export function jsonToToml(jsonText: string): string {
  const value = JSON.parse(jsonText) as Record<string, unknown>;
  return stringify(value);
}

export function tomlToJson(tomlText: string, indent = 2): string {
  const value = parse(tomlText);
  return JSON.stringify(value, null, indent);
}
