// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/json-string/logic.ts. See THIRD_PARTY.md.
/**
 * JSON ↔ escaped-string conversion.
 *
 * jsonToString: validate + minify the JSON, then escape it into a quoted string
 * literal you can paste into code (e.g. `"{\"a\":1}"`).
 * stringToJson: accept a quoted string literal, a bare escaped body, or raw
 * JSON, and return pretty-printed JSON.
 */

export function jsonToString(jsonText: string): string {
  const value = JSON.parse(jsonText) as unknown; // validates
  const minified = JSON.stringify(value); // one-line JSON text
  return JSON.stringify(minified); // escape + quote → string literal
}

export function stringToJson(input: string, indent = 2): string {
  const s = input.trim();
  let inner: string;

  if (s.startsWith('"') && s.endsWith('"')) {
    // A JSON string literal → decode to the underlying text.
    inner = JSON.parse(s) as string;
  } else {
    // A bare escaped body ({\"a\":1}) or already-raw JSON.
    try {
      inner = JSON.parse(`"${s}"`) as string;
    } catch {
      inner = s;
    }
  }

  const value = JSON.parse(inner) as unknown;
  return JSON.stringify(value, null, indent);
}
