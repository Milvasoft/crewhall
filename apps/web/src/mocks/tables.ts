import {
  applyView,
  coerceCell,
  computeRows,
  isComputed,
  type CellValue,
  type EndpointName,
  type Table,
  type TableField,
  type TableFieldOptions,
  type TableFieldType,
  type TableRow,
  type TableRowComment,
  type TableRowHistoryItem,
  type TableView,
  type ViewConfig,
} from '@crewhall/shared';
import { MockApiError, myRole, requireUser, summary, type Resolvers } from './core';
import { formsMockState } from './forms';
import { newId } from './db';
import { SPACE, USER, type MockState } from './seed';

/**
 * Tables part of the contract mock: tables, fields, views and rows in memory; queries run
 * through the same shared engine as the server (computed fields, filters, sorts, groups).
 * Import / export and attachments are server-only.
 */

interface MockTable {
  id: string;
  spaceId: string;
  name: string;
  description: string | null;
  rev: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
interface MockRow {
  id: string;
  tableId: string;
  values: Record<string, CellValue>;
  position: string;
  deleted: boolean;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}
interface TablesMockState {
  tables: MockTable[];
  fields: TableField[];
  views: TableView[];
  rows: MockRow[];
  comments: (TableRowComment & { tableId: string })[];
  history: (TableRowHistoryItem & { tableId: string; rowId: string })[];
}

const EMPTY_CONFIG: ViewConfig = {
  filterMode: 'and',
  filters: [],
  sorts: [],
  groupBy: null,
  hidden: [],
  order: [],
  widths: {},
  kanbanFieldId: null,
  dateFieldId: null,
  endDateFieldId: null,
  coverFieldId: null,
};

const pos = (i: number) => String(i).padStart(8, '0');

function field(tableId: string, i: number, name: string, type: TableFieldType, options: TableFieldOptions = {}): TableField {
  return { id: newId(), tableId, name, type, options, description: null, primary: i === 0, position: pos(i) };
}

function seed(): TablesMockState {
  const now = new Date().toISOString();
  const id = newId();
  const choices = [
    { id: 'c_lead', label: 'Aday', color: 'blue' as const },
    { id: 'c_talk', label: 'Görüşme', color: 'yellow' as const },
    { id: 'c_offer', label: 'Teklif', color: 'orange' as const },
    { id: 'c_won', label: 'Kazanıldı', color: 'green' as const },
  ];
  const fields = [
    field(id, 0, 'Firma', 'text'),
    field(id, 1, 'Aşama', 'single_select', { choices }),
    field(id, 2, 'Sorumlu', 'person', { multiple: false }),
    field(id, 3, 'Tutar', 'currency', { currency: 'TRY', precision: 0 }),
    field(id, 4, 'Kapanış', 'date'),
    field(id, 5, 'Öncelik', 'rating', { max: 5 }),
    field(id, 6, 'Aktif', 'checkbox'),
    field(id, 7, 'Web sitesi', 'url'),
  ];
  const [name, stage, owner, amount, close, rating, active, site] = fields as [TableField, ...TableField[]];
  const views: TableView[] = [
    { id: newId(), tableId: id, name: 'Tüm satırlar', type: 'grid', config: EMPTY_CONFIG, position: pos(0) },
    { id: newId(), tableId: id, name: 'Aşamalar', type: 'kanban', config: { ...EMPTY_CONFIG, kanbanFieldId: stage!.id }, position: pos(1) },
    { id: newId(), tableId: id, name: 'Takvim', type: 'calendar', config: { ...EMPTY_CONFIG, dateFieldId: close!.id }, position: pos(2) },
  ];
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  const rows: MockRow[] = Array.from({ length: 320 }, (_, i) => ({
    id: newId(),
    tableId: id,
    values: {
      [name.id]: `Firma ${i + 1}`,
      [stage!.id]: choices[i % 4]!.id,
      [owner!.id]: i % 3 === 0 ? [USER.bugra] : [],
      [amount!.id]: 1000 * ((i * 37) % 90) + 500,
      [close!.id]: day((i % 40) - 15),
      [rating!.id]: (i % 5) + 1,
      [active!.id]: i % 2 === 0,
      [site!.id]: i % 4 === 0 ? `https://firma${i + 1}.example.com` : null,
    },
    position: pos(i),
    deleted: false,
    createdBy: USER.bugra,
    updatedBy: USER.bugra,
    createdAt: now,
    updatedAt: now,
  }));
  return {
    tables: [{ id, spaceId: SPACE.milvasoft, name: 'Müşteriler', description: null, rev: 1, createdBy: USER.bugra, createdAt: now, updatedAt: now }],
    fields,
    views,
    rows,
    comments: [],
    history: [],
  };
}

function store(s: MockState): TablesMockState {
  const holder = s as MockState & { tables?: TablesMockState };
  holder.tables ??= seed();
  return holder.tables;
}

function access(s: MockState, tableId: string, write = false) {
  const u = requireUser(s);
  const st = store(s);
  const table = st.tables.find((t) => t.id === tableId);
  if (!table) throw new MockApiError('not_found', 'No table');
  const role = myRole(s, table.spaceId, u.id);
  if (!role) throw new MockApiError('not_found', 'No table');
  const canEdit = role === 'owner' || role === 'editor';
  if (write && !canEdit) throw new MockApiError('forbidden', 'Read only');
  return { u, st, table, canEdit };
}

const fieldsOf = (st: TablesMockState, tableId: string) =>
  st.fields.filter((f) => f.tableId === tableId).sort((a, b) => a.position.localeCompare(b.position));
const viewsOf = (st: TablesMockState, tableId: string) =>
  st.views.filter((v) => v.tableId === tableId).sort((a, b) => a.position.localeCompare(b.position));
const liveRows = (st: TablesMockState, tableId: string) =>
  st.rows.filter((r) => r.tableId === tableId && !r.deleted).sort((a, b) => a.position.localeCompare(b.position));

function outTable(s: MockState, st: TablesMockState, t: MockTable, canEdit: boolean): Table {
  const creator = s.users.find((u) => u.id === t.createdBy);
  return {
    ...t,
    icon: null,
    fields: fieldsOf(st, t.id),
    views: viewsOf(st, t.id),
    rowCount: liveRows(st, t.id).length,
    createdBy: creator ? summary(creator) : null,
    canEdit,
  };
}

function computed(st: TablesMockState, tableId: string) {
  const fields = fieldsOf(st, tableId);
  const relatedIds = new Set(fields.filter((f) => f.type === 'relation' && f.options.tableId).map((f) => f.options.tableId!));
  const related = new Map(
    [...relatedIds].map((id) => [id, { fields: fieldsOf(st, id), rows: liveRows(st, id) }]),
  );
  return { fields, rows: computeRows(fields, liveRows(st, tableId), related) };
}

function outRow(st: TablesMockState, tableId: string, rowId: string): TableRow {
  const raw = st.rows.find((r) => r.id === rowId && r.tableId === tableId);
  if (!raw) throw new MockApiError('not_found', 'No row');
  const row = computed(st, tableId).rows.find((r) => r.id === rowId) ?? raw;
  return {
    id: raw.id,
    tableId,
    values: row.values,
    position: raw.position,
    commentCount: st.comments.filter((c) => c.rowId === rowId).length,
    createdBy: raw.createdBy,
    updatedBy: raw.updatedBy,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

function checkValues(fields: TableField[], values: Record<string, CellValue | undefined>) {
  const out: Record<string, CellValue> = {};
  for (const [id, v] of Object.entries(values)) {
    const f = fields.find((x) => x.id === id);
    if (!f || isComputed(f.type)) continue;
    const r = coerceCell(f, v);
    if (!r.ok) throw new MockApiError('table_value_invalid', `${f.name}: ${r.error}`);
    out[id] = r.value;
  }
  return out;
}

const touch = (t: MockTable) => {
  t.rev += 1;
  t.updatedAt = new Date().toISOString();
};

type TablesName = Extract<
  EndpointName,
  | 'listTables'
  | 'createTable'
  | 'getTable'
  | 'updateTable'
  | 'deleteTable'
  | 'createTableField'
  | 'updateTableField'
  | 'deleteTableField'
  | 'createTableView'
  | 'updateTableView'
  | 'deleteTableView'
  | 'queryTableRows'
  | 'getTableRow'
  | 'createTableRow'
  | 'updateTableRow'
  | 'deleteTableRows'
  | 'restoreTableRows'
  | 'listTableRowComments'
  | 'addTableRowComment'
  | 'deleteTableRowComment'
  | 'listTableRowHistory'
  | 'createFormTable'
>;

export const tablesResolvers: Resolvers<TablesName> = {
  listTables: ({ s, params }) => {
    const u = requireUser(s);
    if (!myRole(s, params.spaceId!, u.id)) throw new MockApiError('not_found', 'No space');
    const st = store(s);
    return {
      items: st.tables
        .filter((t) => t.spaceId === params.spaceId)
        .map((t) => ({ id: t.id, spaceId: t.spaceId, name: t.name, description: t.description, icon: null, rowCount: liveRows(st, t.id).length, updatedAt: t.updatedAt })),
    };
  },
  createFormTable: ({ s, params }) => {
    const u = requireUser(s);
    const form = formsMockState(s).forms.find((f) => f.id === params.formId);
    if (!form) throw new MockApiError('not_found', 'No form');
    const role = myRole(s, form.spaceId, u.id);
    if (role !== 'owner' && role !== 'editor') throw new MockApiError('not_found', 'No form');
    const st = store(s);
    const now = new Date().toISOString();
    const t: MockTable = { id: newId(), spaceId: form.spaceId, name: `${form.title} · Yanıtlar`, description: null, rev: 1, createdBy: u.id, createdAt: now, updatedAt: now };
    st.tables.push(t);
    const typeOf = (q: (typeof form.fields)[number]): [TableFieldType, TableFieldOptions] =>
      q.type === 'single_choice' || q.type === 'multi_choice'
        ? [q.type === 'single_choice' ? 'single_select' : 'multi_select', { choices: q.choices.map((c) => ({ id: `c_${c.id}`, label: c.label, color: 'blue' as const })) }]
        : q.type === 'short_text' ? ['text', {}] : q.type === 'number' ? ['number', {}] : q.type === 'date' ? ['date', {}] : q.type === 'rating' ? ['rating', { max: q.max ?? 5 }] : ['long_text', {}];
    st.fields.push(
      field(t.id, 0, 'Yanıtlayan', 'text'),
      ...form.fields.map((q, i) => field(t.id, i + 1, q.label, ...typeOf(q))),
      field(t.id, form.fields.length + 1, 'Gönderilme', 'created_at'),
    );
    st.views.push({ id: newId(), tableId: t.id, name: 'Tablo', type: 'grid', config: EMPTY_CONFIG, position: pos(0) });
    return outTable(s, st, t, true);
  },
  createTable: ({ s, params, body }) => {
    const u = requireUser(s);
    const role = myRole(s, params.spaceId!, u.id);
    if (role !== 'owner' && role !== 'editor') throw new MockApiError('forbidden', 'Editors only');
    const st = store(s);
    const now = new Date().toISOString();
    const t: MockTable = { id: newId(), spaceId: params.spaceId!, name: body.name, description: body.description ?? null, rev: 1, createdBy: u.id, createdAt: now, updatedAt: now };
    st.tables.push(t);
    st.fields.push(field(t.id, 0, 'Ad', 'text'), field(t.id, 1, 'Notlar', 'long_text'));
    st.views.push({ id: newId(), tableId: t.id, name: 'Tüm satırlar', type: 'grid', config: EMPTY_CONFIG, position: pos(0) });
    return outTable(s, st, t, true);
  },
  getTable: ({ s, params }) => {
    const { st, table, canEdit } = access(s, params.tableId!);
    return outTable(s, st, table, canEdit);
  },
  updateTable: ({ s, params, body }) => {
    const { st, table } = access(s, params.tableId!, true);
    if (body.name) table.name = body.name;
    if (body.description !== undefined) table.description = body.description;
    touch(table);
    return outTable(s, st, table, true);
  },
  deleteTable: ({ s, params }) => {
    const { st, table } = access(s, params.tableId!, true);
    st.tables = st.tables.filter((t) => t.id !== table.id);
    return {};
  },
  createTableField: ({ s, params, body }) => {
    const { st, table } = access(s, params.tableId!, true);
    const f = field(table.id, fieldsOf(st, table.id).length, body.name, body.type, body.options ?? {});
    f.description = body.description ?? null;
    st.fields.push(f);
    touch(table);
    return f;
  },
  updateTableField: ({ s, params, body }) => {
    const { st, table } = access(s, params.tableId!, true);
    const f = st.fields.find((x) => x.id === params.fieldId && x.tableId === table.id);
    if (!f) throw new MockApiError('not_found', 'No field');
    if (body.name) f.name = body.name;
    if (body.type && body.type !== f.type) {
      if (f.primary && isComputed(body.type)) throw new MockApiError('table_primary_field', 'Primary');
      const next = { ...f, type: body.type, options: body.options ?? f.options };
      for (const r of st.rows.filter((x) => x.tableId === table.id)) {
        const c = coerceCell(next, r.values[f.id]);
        if (c.ok) r.values[f.id] = c.value;
        else delete r.values[f.id];
      }
      f.type = body.type;
    }
    if (body.options) f.options = body.options;
    if (body.description !== undefined) f.description = body.description;
    touch(table);
    return f;
  },
  deleteTableField: ({ s, params }) => {
    const { st, table } = access(s, params.tableId!, true);
    const f = st.fields.find((x) => x.id === params.fieldId && x.tableId === table.id);
    if (!f) throw new MockApiError('not_found', 'No field');
    if (f.primary) throw new MockApiError('table_primary_field', 'Primary');
    st.fields = st.fields.filter((x) => x !== f);
    touch(table);
    return {};
  },
  createTableView: ({ s, params, body }) => {
    const { st, table } = access(s, params.tableId!, true);
    const fields = fieldsOf(st, table.id);
    const v: TableView = {
      id: newId(),
      tableId: table.id,
      name: body.name,
      type: body.type,
      config: {
        ...EMPTY_CONFIG,
        kanbanFieldId: body.type === 'kanban' ? (fields.find((f) => f.type === 'single_select')?.id ?? null) : null,
        dateFieldId: body.type === 'calendar' || body.type === 'timeline' ? (fields.find((f) => f.type === 'date')?.id ?? null) : null,
        ...body.config,
      },
      position: pos(viewsOf(st, table.id).length),
    };
    st.views.push(v);
    return v;
  },
  updateTableView: ({ s, params, body }) => {
    const { st, table } = access(s, params.tableId!, true);
    const v = st.views.find((x) => x.id === params.viewId && x.tableId === table.id);
    if (!v) throw new MockApiError('not_found', 'No view');
    if (body.name) v.name = body.name;
    if (body.config) v.config = { ...v.config, ...body.config };
    return v;
  },
  deleteTableView: ({ s, params }) => {
    const { st, table } = access(s, params.tableId!, true);
    if (viewsOf(st, table.id).length <= 1) throw new MockApiError('table_last_view', 'Last view');
    st.views = st.views.filter((x) => x.id !== params.viewId);
    return {};
  },
  queryTableRows: ({ s, params, query }) => {
    const { st, table } = access(s, params.tableId!);
    const view = query.viewId ? viewsOf(st, table.id).find((v) => v.id === query.viewId) : undefined;
    const { fields, rows } = computed(st, table.id);
    const people = new Map(s.users.map((u) => [u.id, u.name]));
    const config: Partial<ViewConfig> = view?.config ?? {};
    const result = applyView(fields, rows, { ...config, dateFieldId: config.dateFieldId ?? fields.find((f) => f.type === 'date')?.id ?? null }, {
      q: query.q,
      people,
      range: query.from && query.to ? { from: query.from, to: query.to } : undefined,
    });
    const start = query.cursor ? Number(query.cursor) || 0 : 0;
    const limit = query.limit ?? 200;
    return {
      items: result.rows.slice(start, start + limit).map((r) => outRow(st, table.id, r.id)),
      nextCursor: start + limit < result.rows.length ? String(start + limit) : null,
      total: result.rows.length,
      groups: result.groups,
      rev: table.rev,
    };
  },
  getTableRow: ({ s, params }) => {
    const { st, table } = access(s, params.tableId!);
    return outRow(st, table.id, params.rowId!);
  },
  createTableRow: ({ s, params, body }) => {
    const { u, st, table } = access(s, params.tableId!, true);
    const now = new Date().toISOString();
    const r: MockRow = {
      id: newId(),
      tableId: table.id,
      values: checkValues(fieldsOf(st, table.id), body.values ?? {}),
      position: pos(st.rows.length + 1000),
      deleted: false,
      createdBy: u.id,
      updatedBy: u.id,
      createdAt: now,
      updatedAt: now,
    };
    st.rows.push(r);
    st.history.unshift({ id: newId(), tableId: table.id, rowId: r.id, kind: 'created', actor: summary(u), changes: [], createdAt: now });
    touch(table);
    return outRow(st, table.id, r.id);
  },
  updateTableRow: ({ s, params, body }) => {
    const { u, st, table } = access(s, params.tableId!, true);
    const r = st.rows.find((x) => x.id === params.rowId && x.tableId === table.id && !x.deleted);
    if (!r) throw new MockApiError('not_found', 'No row');
    const fields = fieldsOf(st, table.id);
    const next = checkValues(fields, body.values);
    const changes = Object.entries(next)
      .filter(([id, v]) => JSON.stringify(r.values[id] ?? null) !== JSON.stringify(v))
      .map(([id, v]) => ({ fieldId: id, fieldName: fields.find((f) => f.id === id)?.name ?? id, from: r.values[id] ?? null, to: v }));
    Object.assign(r.values, next);
    r.updatedAt = new Date().toISOString();
    r.updatedBy = u.id;
    if (changes.length) {
      st.history.unshift({ id: newId(), tableId: table.id, rowId: r.id, kind: 'updated', actor: summary(u), changes, createdAt: r.updatedAt });
    }
    touch(table);
    return outRow(st, table.id, r.id);
  },
  deleteTableRows: ({ s, params, body }) => {
    const { st, table } = access(s, params.tableId!, true);
    for (const r of st.rows) if (r.tableId === table.id && body.rowIds.includes(r.id)) r.deleted = true;
    touch(table);
    return {};
  },
  restoreTableRows: ({ s, params, body }) => {
    const { st, table } = access(s, params.tableId!, true);
    for (const r of st.rows) if (r.tableId === table.id && body.rowIds.includes(r.id)) r.deleted = false;
    touch(table);
    return {};
  },
  listTableRowComments: ({ s, params }) => {
    const { st, table } = access(s, params.tableId!);
    return { items: st.comments.filter((c) => c.tableId === table.id && c.rowId === params.rowId) };
  },
  addTableRowComment: ({ s, params, body }) => {
    const { u, st, table } = access(s, params.tableId!);
    const c = { id: newId(), tableId: table.id, rowId: params.rowId!, author: summary(u), text: body.text, createdAt: new Date().toISOString() };
    st.comments.push(c);
    return c;
  },
  deleteTableRowComment: ({ s, params }) => {
    const { u, st } = access(s, params.tableId!);
    const c = st.comments.find((x) => x.id === params.commentId);
    if (!c) throw new MockApiError('not_found', 'No comment');
    if (c.author?.id !== u.id) throw new MockApiError('forbidden', 'Not yours');
    st.comments = st.comments.filter((x) => x !== c);
    return {};
  },
  listTableRowHistory: ({ s, params }) => {
    const { st, table } = access(s, params.tableId!);
    return { items: st.history.filter((h) => h.tableId === table.id && h.rowId === params.rowId) };
  },
};

/** Tests read and change the in-memory tables. */
export const tablesMockState = (s: MockState) => store(s);
