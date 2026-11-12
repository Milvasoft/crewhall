// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/json-excel/logic.ts. See THIRD_PARTY.md.
/**
 * Pure helpers for the JSON ↔ Excel tool. The actual .xlsx read/write (SheetJS)
 * happens in the component because it deals with Blobs/files; this module keeps
 * the JSON-shape validation testable.
 */

export function normalizeRows(jsonText: string): Record<string, unknown>[] {
  const parsed = JSON.parse(jsonText) as unknown;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const ok = rows.every((r) => r !== null && typeof r === 'object' && !Array.isArray(r));
  if (!ok) {
    throw new Error('Expected a JSON object or an array of objects.');
  }
  return rows as Record<string, unknown>[];
}

/** Ordered union of keys across all rows, the spreadsheet's columns. */
export function columnsOf(rows: Record<string, unknown>[]): string[] {
  const cols: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!cols.includes(key)) cols.push(key);
    }
  }
  return cols;
}
