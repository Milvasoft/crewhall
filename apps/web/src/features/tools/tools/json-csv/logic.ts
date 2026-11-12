// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/json-csv/logic.ts. See THIRD_PARTY.md.
/**
 * JSON ↔ CSV without a dependency. Handles RFC-4180 quoting (commas, quotes and
 * newlines inside fields), a header row, and coerces CSV scalars back to JSON
 * numbers/booleans/null on the way in.
 */

function escapeField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function cellToString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function jsonToCsv(jsonText: string): string {
  const parsed = JSON.parse(jsonText) as unknown;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  if (rows.length === 0) return '';

  // Array of primitives → single "value" column.
  const allObjects = rows.every((r) => r !== null && typeof r === 'object' && !Array.isArray(r));
  if (!allObjects) {
    return ['value', ...rows.map((r) => escapeField(cellToString(r)))].join('\n');
  }

  const columns: string[] = [];
  for (const row of rows as Record<string, unknown>[]) {
    for (const key of Object.keys(row)) {
      if (!columns.includes(key)) columns.push(key);
    }
  }

  const lines = [columns.map(escapeField).join(',')];
  for (const row of rows as Record<string, unknown>[]) {
    lines.push(columns.map((c) => escapeField(cellToString(row[c]))).join(','));
  }
  return lines.join('\n');
}

/** Parse CSV text into rows of string fields (RFC-4180-ish). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
    } else if (c === ',') {
      row.push(field);
      field = '';
      i++;
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
    } else if (c === '\r') {
      i++;
    } else {
      field += c;
      i++;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function coerce(v: string): string | number | boolean | null {
  if (v === '') return '';
  if (v === 'null') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) {
    const n = Number(v);
    if (Number.isSafeInteger(n)) return n;
  }
  if (/^-?\d*\.\d+$/.test(v)) return Number(v);
  return v;
}

export function csvToJson(csvText: string, indent = 2): string {
  const rows = parseCsv(csvText.trim());
  if (rows.length === 0) return '[]';
  const [header = [], ...body] = rows;
  const objects = body.map((r) => {
    const obj: Record<string, unknown> = {};
    header.forEach((key, i) => {
      obj[key] = coerce(r[i] ?? '');
    });
    return obj;
  });
  return JSON.stringify(objects, null, indent);
}
