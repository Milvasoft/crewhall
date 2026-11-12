// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/jsonpath/logic.ts. See THIRD_PARTY.md.
import { JSONPath } from 'jsonpath-plus';

export interface JsonPathResult {
  values: unknown[];
  paths: string[];
}

/**
 * Evaluate a JSONPath query. Returns both the matched values and their
 * normalized paths (useful for showing *where* each match came from).
 */
export function queryJsonPath(jsonText: string, path: string): JsonPathResult {
  // JSON.parse returns `any`; JSONPath's options accept a JSON value.
  const json = JSON.parse(jsonText);
  if (!path.trim()) return { values: [], paths: [] };

  const values = JSONPath({ path, json, wrap: true }) as unknown as unknown[];
  const paths = JSONPath({
    path,
    json,
    resultType: 'pointer',
    wrap: true,
  }) as unknown as string[];
  return { values, paths };
}
