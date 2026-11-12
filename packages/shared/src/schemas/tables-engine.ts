import {
  COMPUTED_FIELD_TYPES,
  type CellValue,
  type RowGroup,
  type RowValues,
  type TableAttachment,
  type TableField,
  type TableFieldType,
  type ViewConfig,
  type ViewFilter,
} from './tables';
import {
  evaluateFormula,
  formulaRefs,
  parseFormula,
  type FormulaValue,
  type ParsedFormula,
} from './tables-formula';

/**
 * The tables engine: computed fields (formula, lookup, rollup, created/updated time), cell
 * coercion for writes and imports, and the view query (filter, search, sort, group). The server,
 * the web and the mock all run this, so results are the same everywhere.
 */

export interface EngineRow {
  id: string;
  values: RowValues;
  position: string;
  createdAt: string;
  updatedAt: string;
}

export interface RelatedTable {
  fields: TableField[];
  rows: EngineRow[];
}

/** Names for person ids (sorting, search, export); unknown ids stay ids. */
export type PersonNames = ReadonlyMap<string, string>;

const isEmpty = (v: CellValue | undefined) =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

export const isComputed = (t: TableFieldType) => COMPUTED_FIELD_TYPES.includes(t);

/* -------------------------------- coercion -------------------------------- */

const DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type CoerceResult = { ok: true; value: CellValue } | { ok: false; error: string };

/** Turns "1.234,5" / "1,234.5" / "12" into a number, or NaN. */
export function parseNumber(s: string): number {
  const t = s.trim().replace(/[^\d,.-]/g, '');
  if (!t) return Number.NaN;
  const lastComma = t.lastIndexOf(',');
  const lastDot = t.lastIndexOf('.');
  const normalized =
    lastComma > lastDot ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  return Number(normalized);
}

/** "29.10.2026", "2026-10-29", "10/29/2026" → ISO date (or datetime); null when not a date. */
export function parseDate(s: string, includeTime = false): string | null {
  const t = s.trim();
  if (!t) return null;
  let iso: string | null = null;
  const tr = /^(\d{1,2})[./](\d{1,2})[./](\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(t);
  if (DATE_RE.test(t)) iso = t;
  else if (tr) {
    const [, d, m, y, hh, mm] = tr;
    iso = `${y}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}${hh ? `T${hh.padStart(2, '0')}:${mm}:00` : ''}`;
  }
  if (!iso) return null;
  const date = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(date.getTime())) return null;
  // Date rolls 31.02 over to March: such days are not real dates.
  if (iso.length === 10 && date.toISOString().slice(0, 10) !== iso) return null;
  return includeTime && iso.length > 10 ? date.toISOString() : iso.slice(0, 10);
}

/**
 * Validates and normalizes a value written to a field. Text from imports and forms is accepted
 * for any type ("evet" → checkbox, choice label → choice id, "1.234,5" → number).
 */
export function coerceCell(field: TableField, raw: CellValue | undefined): CoerceResult {
  if (isComputed(field.type)) return { ok: false, error: 'computed' };
  if (isEmpty(raw)) return { ok: true, value: field.type === 'checkbox' ? false : null };
  const v = raw!;
  const text = typeof v === 'string' ? v : Array.isArray(v) ? '' : String(v);
  switch (field.type) {
    case 'text':
    case 'long_text':
    case 'phone': {
      const s = Array.isArray(v) ? v.join(', ') : String(v);
      return field.type === 'text' && s.length > 1000
        ? { ok: false, error: 'too_long' }
        : { ok: true, value: s };
    }
    case 'url': {
      const s = text.trim();
      const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
      // http(s) with a host, or mailto: (no URL global here: this package also runs outside the DOM).
      return /^https?:\/\/[^\s/?#]+\.[^\s/?#]+([/?#]\S*)?$/i.test(withScheme) ||
        /^mailto:[^\s@]+@[^\s@]+$/i.test(withScheme)
        ? { ok: true, value: withScheme }
        : { ok: false, error: 'invalid' };
    }
    case 'email':
      return EMAIL_RE.test(text.trim())
        ? { ok: true, value: text.trim().toLowerCase() }
        : { ok: false, error: 'invalid' };
    case 'number':
    case 'currency':
    case 'rating': {
      const n = typeof v === 'number' ? v : parseNumber(text);
      if (!Number.isFinite(n)) return { ok: false, error: 'invalid' };
      if (field.type === 'rating') {
        const r = Math.round(n);
        return r < 0 || r > (field.options.max ?? 5)
          ? { ok: false, error: 'out_of_range' }
          : { ok: true, value: r };
      }
      return { ok: true, value: n };
    }
    case 'checkbox':
      if (typeof v === 'boolean') return { ok: true, value: v };
      return { ok: true, value: /^(1|true|evet|yes|x|✓|on|doğru)$/i.test(text.trim()) };
    case 'date': {
      const d = parseDate(text, field.options.includeTime === true);
      return d ? { ok: true, value: d } : { ok: false, error: 'invalid' };
    }
    case 'single_select':
    case 'multi_select': {
      const choices = field.options.choices ?? [];
      const wanted = Array.isArray(v)
        ? v.map(String)
        : field.type === 'multi_select'
          ? text
              .split(/[,;]/)
              .map((s) => s.trim())
              .filter(Boolean)
          : [text.trim()];
      const ids: string[] = [];
      for (const w of wanted) {
        const c =
          choices.find((x) => x.id === w) ??
          choices.find((x) => x.label.toLocaleLowerCase('tr') === w.toLocaleLowerCase('tr'));
        if (!c) return { ok: false, error: 'unknown_choice' };
        if (!ids.includes(c.id)) ids.push(c.id);
      }
      return field.type === 'single_select'
        ? { ok: true, value: ids[0] ?? null }
        : { ok: true, value: ids };
    }
    case 'person':
    case 'relation': {
      const ids = (Array.isArray(v) ? v.map(String) : [text]).filter(Boolean);
      if (!field.options.multiple && ids.length > 1) return { ok: false, error: 'single_only' };
      return { ok: true, value: [...new Set(ids)] };
    }
    case 'attachment': {
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'object' || x === null)) {
        return { ok: false, error: 'invalid' };
      }
      return { ok: true, value: v as TableAttachment[] };
    }
    default:
      return { ok: false, error: 'invalid' };
  }
}

/* ------------------------------ computed values ------------------------------ */

const fieldByName = (fields: TableField[], name: string) => {
  const n = name.toLocaleLowerCase('tr');
  return fields.find((f) => f.name.toLocaleLowerCase('tr') === n);
};

function toFormulaValue(field: TableField | undefined, v: CellValue | undefined): FormulaValue {
  if (!field || v === undefined) return null;
  if (field.type === 'single_select') {
    return field.options.choices?.find((c) => c.id === v)?.label ?? null;
  }
  if (field.type === 'multi_select' && Array.isArray(v)) {
    return (v as string[]).map(
      (id) => field.options.choices?.find((c) => c.id === id)?.label ?? id,
    );
  }
  if (field.type === 'attachment' && Array.isArray(v))
    return (v as TableAttachment[]).map((a) => a.name);
  return v as FormulaValue;
}

function rollup(fn: string, values: CellValue[]): CellValue {
  const vals: unknown[] = values
    .flatMap((v): unknown[] => (Array.isArray(v) ? [...v] : [v]))
    .filter((v) => !isEmpty(v as CellValue));
  const nums = vals
    .map((v) => (typeof v === 'number' ? v : parseNumber(String(v))))
    .filter(Number.isFinite);
  switch (fn) {
    case 'count':
      return vals.length;
    case 'sum':
      return nums.reduce((s, n) => s + n, 0);
    case 'avg':
      return nums.length ? nums.reduce((s, n) => s + n, 0) / nums.length : null;
    case 'min':
      return nums.length ? Math.min(...nums) : null;
    case 'max':
      return nums.length ? Math.max(...nums) : null;
    case 'earliest':
    case 'latest': {
      const dates = vals
        .map(String)
        .filter((s) => DATE_RE.test(s))
        .sort();
      return (fn === 'earliest' ? dates[0] : dates.at(-1)) ?? null;
    }
    default:
      return vals
        .map((v) =>
          typeof v === 'object' && v ? ((v as { name?: string }).name ?? '') : String(v),
        )
        .join(', ');
  }
}

/** Formula fields in an order where each comes after the formulas it reads; cycles left out. */
function formulaOrder(fields: TableField[]): { order: TableField[]; cyclic: Set<string> } {
  const formulas = fields.filter((f) => f.type === 'formula');
  const deps = new Map(
    formulas.map((f) => [
      f.id,
      formulaRefs(f.options.formula ?? '')
        .map((n) => fieldByName(fields, n))
        .filter((x): x is TableField => x?.type === 'formula')
        .map((x) => x.id),
    ]),
  );
  const order: TableField[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const cyclic = new Set<string>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 'done') return true;
    if (state.get(id) === 'visiting') return false;
    state.set(id, 'visiting');
    let ok = true;
    for (const d of deps.get(id) ?? []) if (!visit(d)) ok = false;
    state.set(id, 'done');
    if (ok) order.push(formulas.find((f) => f.id === id)!);
    else cyclic.add(id);
    return ok;
  };
  for (const f of formulas) visit(f.id);
  return { order, cyclic };
}

/**
 * Fills the computed fields of every row. `related` holds the tables reached by relation fields
 * (by table id). Lookups and rollups run first, then formulas in dependency order.
 */
export function computeRows(
  fields: TableField[],
  rows: EngineRow[],
  related: ReadonlyMap<string, RelatedTable>,
  now = new Date(),
): EngineRow[] {
  const relatedRows = new Map<string, Map<string, EngineRow>>();
  for (const [id, t] of related) relatedRows.set(id, new Map(t.rows.map((r) => [r.id, r])));
  const parsed = new Map<string, ParsedFormula | null>();
  for (const f of fields) {
    if (f.type !== 'formula') continue;
    try {
      parsed.set(f.id, parseFormula(f.options.formula ?? ''));
    } catch {
      parsed.set(f.id, null);
    }
  }
  const { order, cyclic } = formulaOrder(fields);

  return rows.map((row) => {
    const values: RowValues = { ...row.values };
    for (const f of fields) {
      if (f.type === 'created_at') values[f.id] = row.createdAt;
      if (f.type === 'updated_at') values[f.id] = row.updatedAt;
      if (f.type === 'lookup' || f.type === 'rollup') {
        const rel = fields.find((x) => x.id === f.options.relationFieldId);
        const target = rel?.options.tableId ? related.get(rel.options.tableId) : undefined;
        const byId = rel?.options.tableId ? relatedRows.get(rel.options.tableId) : undefined;
        const targetField = target?.fields.find((x) => x.id === f.options.targetFieldId);
        const linked = Array.isArray(row.values[rel?.id ?? ''])
          ? (row.values[rel!.id] as string[])
          : [];
        const found = linked
          .map((id) => byId?.get(id))
          .filter((r): r is EngineRow => !!r)
          .map((r) => r.values[targetField?.id ?? ''] ?? null);
        if (f.type === 'lookup') {
          values[f.id] = found.flatMap((v) =>
            Array.isArray(v)
              ? (v as (string | number | boolean | null)[])
              : [v as string | number | boolean | null],
          );
        } else {
          values[f.id] = rollup(f.options.fn ?? 'count', found);
        }
      }
    }
    for (const f of fields)
      if (cyclic.has(f.id) || (f.type === 'formula' && !parsed.get(f.id))) values[f.id] = null;
    for (const f of order) {
      const node = parsed.get(f.id);
      if (!node) continue;
      try {
        const out = evaluateFormula(
          node,
          (name) => {
            const ref = fieldByName(fields, name);
            return toFormulaValue(ref, ref ? values[ref.id] : undefined);
          },
          now,
        );
        values[f.id] = Array.isArray(out) ? out.map((x) => (Array.isArray(x) ? null : x)) : out;
      } catch {
        values[f.id] = null;
      }
    }
    return { ...row, values };
  });
}

/* --------------------------------- text form --------------------------------- */

/** A cell as plain text: search, grouping labels, CSV export. */
export function cellText(
  field: TableField,
  v: CellValue | undefined,
  people: PersonNames = new Map(),
  related?: RelatedTable,
): string {
  if (isEmpty(v)) return '';
  switch (field.type) {
    case 'single_select':
      return field.options.choices?.find((c) => c.id === v)?.label ?? String(v);
    case 'multi_select':
      return (v as string[])
        .map((id) => field.options.choices?.find((c) => c.id === id)?.label ?? id)
        .join(', ');
    case 'person':
      return (v as string[]).map((id) => people.get(id) ?? id).join(', ');
    case 'attachment':
      return (v as TableAttachment[]).map((a) => a.name).join(', ');
    case 'checkbox':
      return v ? '✓' : '';
    case 'relation': {
      const primary = related?.fields.find((f) => f.primary);
      return (v as string[])
        .map((id) => {
          const r = related?.rows.find((x) => x.id === id);
          return r && primary ? String(r.values[primary.id] ?? '') : id;
        })
        .join(', ');
    }
    default:
      return Array.isArray(v) ? v.map((x) => (x === null ? '' : String(x))).join(', ') : String(v);
  }
}

/* --------------------------------- filtering --------------------------------- */

function asNumber(v: CellValue | undefined): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = parseNumber(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Does one filter hold for a row? Unknown fields never filter anything out. */
export function matchesFilter(
  field: TableField | undefined,
  v: CellValue | undefined,
  f: ViewFilter,
  people: PersonNames = new Map(),
): boolean {
  if (!field) return true;
  const want = f.value;
  const wantText = (Array.isArray(want) ? want.join(',') : (want ?? '')).toLocaleLowerCase('tr');
  const text = cellText(field, v, people).toLocaleLowerCase('tr');
  const ids = Array.isArray(v)
    ? (v as unknown[]).map(String)
    : v === null || v === undefined
      ? []
      : [String(v)];
  const wantIds = Array.isArray(want) ? want : want ? [want] : [];
  switch (f.op) {
    case 'is_empty':
      return isEmpty(v) || v === false;
    case 'is_not_empty':
      return !isEmpty(v) && v !== false;
    case 'is_checked':
      return v === true;
    case 'is_unchecked':
      return v !== true;
    case 'is':
      if (field.type === 'single_select' || field.type === 'person' || field.type === 'relation') {
        return wantIds.length > 0 && ids.length > 0 && wantIds.includes(ids[0]!);
      }
      if (field.type === 'date') return String(v ?? '').slice(0, 10) === wantText;
      if (asNumber(v) !== null && want !== null && !Array.isArray(want))
        return asNumber(v) === parseNumber(want);
      return text === wantText;
    case 'is_not':
      return !matchesFilter(field, v, { ...f, op: 'is' }, people);
    case 'contains':
      return text.includes(wantText);
    case 'not_contains':
      return !text.includes(wantText);
    case 'starts_with':
      return text.startsWith(wantText);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = asNumber(v);
      const b = want !== null && !Array.isArray(want) ? parseNumber(want) : Number.NaN;
      if (a === null || !Number.isFinite(b)) return false;
      return f.op === 'gt' ? a > b : f.op === 'gte' ? a >= b : f.op === 'lt' ? a < b : a <= b;
    }
    case 'is_before':
    case 'is_after': {
      const a = String(v ?? '').slice(0, 10);
      if (!a || !wantText) return false;
      return f.op === 'is_before' ? a < wantText : a > wantText;
    }
    case 'has_any':
      return wantIds.some((w) => ids.includes(w));
    case 'has_all':
      return wantIds.every((w) => ids.includes(w));
    case 'has_none':
      return !wantIds.some((w) => ids.includes(w));
  }
}

/* --------------------------------- sorting --------------------------------- */

function sortKey(
  field: TableField,
  v: CellValue | undefined,
  people: PersonNames,
): number | string | null {
  if (isEmpty(v)) return null;
  switch (field.type) {
    case 'number':
    case 'currency':
    case 'rating':
    case 'rollup':
      return asNumber(v);
    case 'checkbox':
      return v ? 1 : 0;
    case 'single_select': {
      const i = field.options.choices?.findIndex((c) => c.id === v) ?? -1;
      return i < 0 ? null : i;
    }
    case 'date':
    case 'created_at':
    case 'updated_at':
      return String(v);
    case 'formula':
      return typeof v === 'number' ? v : String(v);
    default:
      return cellText(field, v, people).toLocaleLowerCase('tr');
  }
}

function compareKeys(a: number | string, b: number | string) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'tr', { numeric: true });
}

const byPosition = (a: EngineRow, b: EngineRow) =>
  a.position < b.position ? -1 : a.position > b.position ? 1 : 0;

export interface ViewResult {
  rows: EngineRow[];
  groups: RowGroup[] | null;
}

/** Group key of a value: choice id, first person id, day of a date, otherwise its text. */
export function groupKey(field: TableField, v: CellValue | undefined, people: PersonNames) {
  if (isEmpty(v)) return '';
  if (field.type === 'single_select') return String(v);
  if (field.type === 'checkbox') return v ? 'true' : 'false';
  if (field.type === 'person' || field.type === 'multi_select')
    return String((v as string[])[0] ?? '');
  if (field.type === 'date' || field.type === 'created_at' || field.type === 'updated_at')
    return String(v).slice(0, 10);
  return cellText(field, v, people);
}

/**
 * Applies a view to computed rows: filters (and/or), search over the visible fields, sorts
 * (stable, table order last) and, with groupBy, orders by group and returns the groups.
 */
export function applyView(
  fields: TableField[],
  rows: EngineRow[],
  config: Partial<ViewConfig>,
  opts: { q?: string; people?: PersonNames; range?: { from: string; to: string } } = {},
): ViewResult {
  const people = opts.people ?? new Map<string, string>();
  const byId = new Map(fields.map((f) => [f.id, f]));
  const filters = config.filters ?? [];
  const mode = config.filterMode ?? 'and';
  let out = rows.filter((r) => {
    if (filters.length === 0) return true;
    const results = filters.map((f) =>
      matchesFilter(byId.get(f.fieldId), r.values[f.fieldId], f, people),
    );
    return mode === 'and' ? results.every(Boolean) : results.some(Boolean);
  });
  const q = opts.q?.trim().toLocaleLowerCase('tr');
  if (q) {
    const hidden = new Set(config.hidden ?? []);
    const visible = fields.filter((f) => !hidden.has(f.id));
    out = out.filter((r) =>
      visible.some((f) => cellText(f, r.values[f.id], people).toLocaleLowerCase('tr').includes(q)),
    );
  }
  if (opts.range && config.dateFieldId) {
    const { from, to } = opts.range;
    const start = config.dateFieldId;
    const end = config.endDateFieldId ?? start;
    out = out.filter((r) => {
      const a = String(r.values[start] ?? '').slice(0, 10);
      const b = String(r.values[end] ?? r.values[start] ?? '').slice(0, 10) || a;
      return Boolean(a) && a <= to && b >= from;
    });
  }
  const sorts = [
    ...(config.groupBy ? [{ fieldId: config.groupBy, dir: 'asc' as const }] : []),
    ...(config.sorts ?? []),
  ].filter((s) => byId.has(s.fieldId));
  out = [...out].sort((a, b) => {
    for (const s of sorts) {
      const f = byId.get(s.fieldId)!;
      const ka = sortKey(f, a.values[f.id], people);
      const kb = sortKey(f, b.values[f.id], people);
      // Empty values go last in both directions.
      if (ka === null || kb === null) {
        if (ka === kb) continue;
        return ka === null ? 1 : -1;
      }
      const c = compareKeys(ka, kb);
      if (c !== 0) return s.dir === 'desc' ? -c : c;
    }
    return byPosition(a, b);
  });
  let groups: RowGroup[] | null = null;
  const gf = config.groupBy ? byId.get(config.groupBy) : undefined;
  if (gf) {
    groups = [];
    out.forEach((r, i) => {
      const key = groupKey(gf, r.values[gf.id], people);
      const last = groups!.at(-1);
      if (last && last.key === key) last.count++;
      else groups!.push({ key, count: 1, start: i });
    });
  }
  return { rows: out, groups };
}

/* ------------------------------- import helpers ------------------------------- */

/** Guesses a field type from the non-empty values of a column. */
export function inferFieldType(values: string[]): TableFieldType {
  const vals = values.map((v) => v.trim()).filter(Boolean);
  if (vals.length === 0) return 'text';
  const all = (re: (s: string) => boolean) => vals.every(re);
  if (all((s) => /^(true|false|evet|hayır|yes|no|x|✓)$/i.test(s))) return 'checkbox';
  if (all((s) => /^-?[\d.,\s]+$/.test(s) && Number.isFinite(parseNumber(s)))) return 'number';
  if (all((s) => parseDate(s) !== null)) return 'date';
  if (all((s) => EMAIL_RE.test(s))) return 'email';
  if (all((s) => /^https?:\/\//i.test(s))) return 'url';
  const distinct = new Set(vals.map((v) => v.toLocaleLowerCase('tr')));
  if (vals.length >= 6 && distinct.size <= Math.min(12, Math.ceil(vals.length / 3)))
    return 'single_select';
  if (vals.some((v) => v.length > 200 || v.includes('\n'))) return 'long_text';
  return 'text';
}

/** RFC 4180 CSV (also `;` separated, as Excel writes in Turkish locales). */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const sep =
    (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
      continue;
    }
    if (c === '"' && cell === '') quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

export function toCsv(rows: string[][]): string {
  const esc = (v: string) => (/[",\n\r;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return `﻿${rows.map((r) => r.map(esc).join(',')).join('\r\n')}\r\n`;
}
