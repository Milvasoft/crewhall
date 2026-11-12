// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/query-string/logic.ts. See THIRD_PARTY.md.
/**
 * Query string ↔ JSON. Repeated keys become arrays; array values in JSON are
 * expanded to repeated `key=value` pairs. Values are URL-encoded on build and
 * decoded on parse (via URLSearchParams).
 */

export function parseQueryString(input: string, indent = 2): string {
  const q = input.trim().replace(/^\?/, '');
  const params = new URLSearchParams(q);
  const obj: Record<string, string | string[]> = {};
  for (const [key, value] of params) {
    if (key in obj) {
      const existing = obj[key]!;
      obj[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
    } else {
      obj[key] = value;
    }
  }
  return JSON.stringify(obj, null, indent);
}

export function buildQueryString(jsonText: string): string {
  const obj = JSON.parse(jsonText) as Record<string, unknown>;
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('Provide a JSON object of parameters.');
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value)) {
      for (const v of value) params.append(key, String(v));
    } else if (value !== null && value !== undefined) {
      params.append(key, String(value));
    } else {
      params.append(key, '');
    }
  }
  return params.toString();
}
