// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/connection-string/logic.ts. See THIRD_PARTY.md.
/**
 * ADO.NET-style connection strings: `Key=Value;Key2=Value2`. Keys are parsed
 * case-preserving and in order. Values may themselves contain `=`; only the
 * first `=` in each segment separates key from value.
 */
export function parseConnectionString(input: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const segment of input.split(';')) {
    const part = segment.trim();
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

export function connectionStringToJson(input: string, indent = 2): string {
  return JSON.stringify(parseConnectionString(input), null, indent);
}

export function jsonToConnectionString(jsonText: string): string {
  const obj = JSON.parse(jsonText) as Record<string, unknown>;
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('Provide a JSON object of key/value pairs.');
  }
  return Object.entries(obj)
    .map(([k, v]) => `${k}=${v ?? ''}`)
    .join(';');
}
