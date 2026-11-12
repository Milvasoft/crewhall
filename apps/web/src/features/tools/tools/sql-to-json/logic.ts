// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/sql-to-json/logic.ts. See THIRD_PARTY.md.
/**
 * Parse SQL `INSERT` statements into JSON rows. Supports multiple statements,
 * multi-row VALUES, quoted strings (with '' escapes), numbers, NULL and
 * booleans. Best-effort, not a full SQL parser.
 */

type SqlValue = string | number | boolean | null;

function parseValueList(inner: string): SqlValue[] {
  const values: SqlValue[] = [];
  let i = 0;
  let token = '';
  let inStr = false;

  const flush = () => {
    const t = token.trim();
    token = '';
    if (t === '') return;
    values.push(coerce(t));
  };

  while (i < inner.length) {
    const c = inner[i];
    if (inStr) {
      if (c === "'") {
        if (inner[i + 1] === "'") {
          token += "'";
          i += 2;
          continue;
        }
        inStr = false;
        token += "'";
        i++;
        continue;
      }
      token += c;
      i++;
      continue;
    }
    if (c === "'") {
      inStr = true;
      token += c;
      i++;
    } else if (c === ',') {
      flush();
      i++;
    } else {
      token += c;
      i++;
    }
  }
  flush();
  return values;
}

function coerce(raw: string): SqlValue {
  const t = raw.trim();
  if (t.startsWith("'") && t.endsWith("'")) {
    return t.slice(1, -1).replace(/''/g, "'");
  }
  const upper = t.toUpperCase();
  if (upper === 'NULL') return null;
  if (upper === 'TRUE') return true;
  if (upper === 'FALSE') return false;
  if (/^-?\d+$/.test(t)) {
    const n = Number(t);
    if (Number.isSafeInteger(n)) return n;
  }
  if (/^-?\d*\.\d+$/.test(t)) return Number(t);
  return t; // unquoted token (e.g. function call), keep as text
}

/** Split a VALUES clause into top-level ( … ) tuples. */
function splitTuples(s: string): string[] {
  const tuples: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "'" && s[i + 1] !== "'") inStr = false;
      else if (c === "'" && s[i + 1] === "'") i++;
      continue;
    }
    if (c === "'") inStr = true;
    else if (c === '(') {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (c === ')') {
      depth--;
      if (depth === 0 && start !== -1) {
        tuples.push(s.slice(start, i));
        start = -1;
      }
    }
  }
  return tuples;
}

export function sqlToJson(sql: string, indent = 2): string {
  const rows: Record<string, SqlValue>[] = [];
  const re = /insert\s+into\s+[`"[\]\w.]+\s*(?:\(([^)]*)\))?\s*values\s*([\s\S]*?)(?:;|$)/gi;
  let m: RegExpExecArray | null;

  while ((m = re.exec(sql))) {
    const columns = m[1]
      ? m[1].split(',').map((c) => c.trim().replace(/^[`"[]|[`"\]]$/g, ''))
      : null;
    for (const tuple of splitTuples(m[2] ?? '')) {
      const values = parseValueList(tuple);
      const row: Record<string, SqlValue> = {};
      values.forEach((v, i) => {
        const key = columns && columns[i] ? columns[i] : `column${i + 1}`;
        row[key] = v;
      });
      rows.push(row);
    }
  }

  if (rows.length === 0) throw new Error('No INSERT statements found.');
  return JSON.stringify(rows, null, indent);
}
