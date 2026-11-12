import { z } from 'zod';
import { Id, Timestamp } from './common';
import { UserSummary } from './org';

/**
 * Tables (Airtable / Notion database style, sonraki-isler.md › Tablolar). A table belongs to a
 * space: typed fields, rows keyed by field id, views with their own filter, sort, grouping and
 * hidden fields. Formula, lookup and rollup values are computed on read (tables-engine.ts runs
 * the same code on the server, in the web preview and in the mock). Only the tables session
 * edits this file; see docs/contracts/moduller.md.
 */

export const TABLE_LIMITS = {
  tablesPerSpace: 200,
  fields: 100,
  views: 50,
  rows: 20_000,
  choices: 100,
  nameChars: 120,
  textChars: 10_000,
  formulaChars: 2_000,
  pageMax: 500,
  importBytes: 15 * 1024 * 1024,
  attachmentsPerCell: 20,
  relationsPerCell: 500,
} as const;

export const TableFieldType = z.enum([
  'text',
  'long_text',
  'number',
  'currency',
  'date',
  'single_select',
  'multi_select',
  'person',
  'attachment',
  'checkbox',
  'url',
  'email',
  'phone',
  'rating',
  'relation',
  'lookup',
  'rollup',
  'formula',
  'created_at',
  'updated_at',
]);
export type TableFieldType = z.infer<typeof TableFieldType>;

/** Types whose value is computed, never written. */
export const COMPUTED_FIELD_TYPES: readonly TableFieldType[] = [
  'lookup',
  'rollup',
  'formula',
  'created_at',
  'updated_at',
];

export const ChoiceColor = z.enum([
  'gray',
  'yellow',
  'orange',
  'red',
  'pink',
  'purple',
  'blue',
  'teal',
  'green',
]);
export type ChoiceColor = z.infer<typeof ChoiceColor>;

export const TableChoice = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  label: z.string().trim().min(1).max(200),
  color: ChoiceColor.default('gray'),
});
export type TableChoice = z.infer<typeof TableChoice>;

export const RollupFn = z.enum([
  'count',
  'sum',
  'avg',
  'min',
  'max',
  'concat',
  'earliest',
  'latest',
]);
export type RollupFn = z.infer<typeof RollupFn>;

/** Settings per field type; the server keeps only the keys its type uses. */
export const TableFieldOptions = z.object({
  /** single_select, multi_select. */
  choices: z.array(TableChoice).max(TABLE_LIMITS.choices).optional(),
  /** number, currency, rollup, formula: digits after the point. */
  precision: z.number().int().min(0).max(8).optional(),
  /** currency: ISO 4217. */
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  /** date: with a time of day. */
  includeTime: z.boolean().optional(),
  /** rating: scale 3-10 (default 5). */
  max: z.number().int().min(3).max(10).optional(),
  /** person, relation: more than one value. */
  multiple: z.boolean().optional(),
  /** relation: the other table (same space). */
  tableId: Id.optional(),
  /** lookup, rollup: through this relation field, read this field of the other table. */
  relationFieldId: z.string().optional(),
  targetFieldId: z.string().optional(),
  /** rollup. */
  fn: RollupFn.optional(),
  /** formula: `{Alan adı}` references, see tables-formula.ts. */
  formula: z.string().max(TABLE_LIMITS.formulaChars).optional(),
});
export type TableFieldOptions = z.infer<typeof TableFieldOptions>;

export const TableField = z.object({
  id: z.string(),
  tableId: Id,
  name: z.string(),
  type: TableFieldType,
  options: TableFieldOptions,
  description: z.string().nullable(),
  /** The row's title: shown in relations, cards and search. One per table. */
  primary: z.boolean(),
  position: z.string(),
});
export type TableField = z.infer<typeof TableField>;

export const TableAttachment = z.object({
  nodeId: Id,
  name: z.string(),
  mime: z.string().nullable(),
  sizeBytes: z.number().int(),
});
export type TableAttachment = z.infer<typeof TableAttachment>;

/**
 * A stored or computed cell: text kinds and dates (ISO) as strings, numbers, checkbox as boolean,
 * select ids / person ids / related row ids as string arrays, attachments as objects. Computed
 * lookups may hold arrays of any of these.
 */
export const CellValue = z.union([
  z.string().max(TABLE_LIMITS.textChars),
  z.number(),
  z.boolean(),
  z.array(z.string()).max(TABLE_LIMITS.relationsPerCell),
  z.array(TableAttachment).max(TABLE_LIMITS.attachmentsPerCell),
  z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])),
  z.null(),
]);
export type CellValue = z.infer<typeof CellValue>;
export type RowValues = Record<string, CellValue>;

export const TableRow = z.object({
  id: Id,
  tableId: Id,
  /** Stored and computed values by field id. */
  values: z.record(z.string(), CellValue),
  position: z.string(),
  commentCount: z.number().int(),
  createdBy: Id.nullable(),
  updatedBy: Id.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type TableRow = z.infer<typeof TableRow>;

export const TableViewType = z.enum(['grid', 'kanban', 'calendar', 'gallery', 'timeline']);
export type TableViewType = z.infer<typeof TableViewType>;

export const FilterOp = z.enum([
  'is',
  'is_not',
  'contains',
  'not_contains',
  'starts_with',
  'gt',
  'gte',
  'lt',
  'lte',
  'is_empty',
  'is_not_empty',
  'has_any',
  'has_all',
  'has_none',
  'is_before',
  'is_after',
  'is_checked',
  'is_unchecked',
]);
export type FilterOp = z.infer<typeof FilterOp>;

export const ViewFilter = z.object({
  fieldId: z.string(),
  op: FilterOp,
  /** Text, number as text, ISO date, or ids for has_any / has_all / has_none. */
  value: z.union([z.string().max(500), z.array(z.string()).max(100), z.null()]).default(null),
});
export type ViewFilter = z.infer<typeof ViewFilter>;

export const ViewSort = z.object({
  fieldId: z.string(),
  dir: z.enum(['asc', 'desc']).default('asc'),
});
export type ViewSort = z.infer<typeof ViewSort>;

export const ViewConfig = z.object({
  filterMode: z.enum(['and', 'or']).default('and'),
  filters: z.array(ViewFilter).max(30).default([]),
  sorts: z.array(ViewSort).max(10).default([]),
  /** grid: group rows by this field. */
  groupBy: z.string().nullable().default(null),
  hidden: z.array(z.string()).default([]),
  /** Field order of this view; fields missing here follow in table order. */
  order: z.array(z.string()).default([]),
  /** grid: column widths in px. */
  widths: z.record(z.string(), z.number().int().min(60).max(800)).default({}),
  /** kanban: the single-select field whose choices are the columns. */
  kanbanFieldId: z.string().nullable().default(null),
  /** calendar, timeline: start date field; timeline: end date field. */
  dateFieldId: z.string().nullable().default(null),
  endDateFieldId: z.string().nullable().default(null),
  /** gallery, kanban: the attachment field shown as the card image. */
  coverFieldId: z.string().nullable().default(null),
});
export type ViewConfig = z.infer<typeof ViewConfig>;
export type ViewConfigInput = z.input<typeof ViewConfig>;

/**
 * A view config change: only the keys that are sent. `ViewConfig.partial()` would not do: zod
 * applies the defaults inside it, so a change of one key would reset every other one (groupBy,
 * hidden fields…). The server lays the patch over the stored config.
 */
export const ViewConfigPatch = z.object({
  filterMode: z.enum(['and', 'or']).optional(),
  filters: z.array(ViewFilter).max(30).optional(),
  sorts: z.array(ViewSort).max(10).optional(),
  groupBy: z.string().nullable().optional(),
  hidden: z.array(z.string()).optional(),
  order: z.array(z.string()).optional(),
  widths: z.record(z.string(), z.number().int().min(60).max(800)).optional(),
  kanbanFieldId: z.string().nullable().optional(),
  dateFieldId: z.string().nullable().optional(),
  endDateFieldId: z.string().nullable().optional(),
  coverFieldId: z.string().nullable().optional(),
});
export type ViewConfigPatch = z.infer<typeof ViewConfigPatch>;

export const TableView = z.object({
  id: Id,
  tableId: Id,
  name: z.string(),
  type: TableViewType,
  config: ViewConfig,
  position: z.string(),
});
export type TableView = z.infer<typeof TableView>;

export const TableTemplate = z.enum(['empty', 'crm', 'inventory', 'hiring', 'assets']);
export type TableTemplate = z.infer<typeof TableTemplate>;

export const Table = z.object({
  id: Id,
  spaceId: Id,
  name: z.string(),
  description: z.string().nullable(),
  icon: z.string().nullable(),
  fields: z.array(TableField),
  views: z.array(TableView),
  rowCount: z.number().int(),
  /** Grows with every change; clients compare it with `tables.changed` events. */
  rev: z.number().int(),
  createdBy: UserSummary.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  /** The caller may change rows, fields and views (tables.edit). */
  canEdit: z.boolean(),
});
export type Table = z.infer<typeof Table>;

export const TableSummary = Table.pick({
  id: true,
  spaceId: true,
  name: true,
  description: true,
  icon: true,
  rowCount: true,
  updatedAt: true,
});
export type TableSummary = z.infer<typeof TableSummary>;

const Name = z.string().trim().min(1).max(TABLE_LIMITS.nameChars);

export const CreateTable = z.object({
  name: Name,
  description: z.string().max(1000).nullable().optional(),
  template: TableTemplate.default('empty'),
});
export type CreateTable = z.input<typeof CreateTable>;

export const UpdateTable = z.object({
  name: Name.optional(),
  description: z.string().max(1000).nullable().optional(),
  icon: z.string().max(40).nullable().optional(),
});

export const CreateTableField = z.object({
  name: Name,
  type: TableFieldType,
  options: TableFieldOptions.default({}),
  description: z.string().max(500).nullable().optional(),
  /** Place after this field; absent = last. */
  afterId: z.string().optional(),
});
export type CreateTableField = z.input<typeof CreateTableField>;

/** Changing the type converts the stored values where it can (text ↔ number, select ↔ text…). */
export const UpdateTableField = z.object({
  name: Name.optional(),
  type: TableFieldType.optional(),
  options: TableFieldOptions.optional(),
  description: z.string().max(500).nullable().optional(),
  primary: z.literal(true).optional(),
  afterId: z.string().nullable().optional(),
});
export type UpdateTableField = z.input<typeof UpdateTableField>;

export const CreateTableView = z.object({
  name: Name,
  type: TableViewType,
  config: ViewConfigPatch.default({}),
});
export type CreateTableView = z.input<typeof CreateTableView>;

export const UpdateTableView = z.object({
  name: Name.optional(),
  config: ViewConfigPatch.optional(),
  afterId: z.string().nullable().optional(),
});
export type UpdateTableView = z.input<typeof UpdateTableView>;

export const QueryTableRows = z.object({
  /** Filter, sort and grouping of this view; absent = table order, everything. */
  viewId: Id.optional(),
  /** Words searched in every visible field. */
  q: z.string().max(200).optional(),
  /** Offset cursor from the previous page. */
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(TABLE_LIMITS.pageMax).default(200),
  /** calendar / timeline: only rows whose date range meets [from, to] (YYYY-MM-DD). */
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
export type QueryTableRows = z.input<typeof QueryTableRows>;

export const RowGroup = z.object({
  /** Group key: the value as text ("" = empty). */
  key: z.string(),
  count: z.number().int(),
  /** Index of the group's first row in the whole ordered result. */
  start: z.number().int(),
});
export type RowGroup = z.infer<typeof RowGroup>;

export const TableRowsPage = z.object({
  items: z.array(TableRow),
  nextCursor: z.string().nullable(),
  /** Rows matching the view's filter and the search. */
  total: z.number().int(),
  /** With groupBy: every group in order (rows come sorted by group). */
  groups: z.array(RowGroup).nullable(),
  rev: z.number().int(),
});
export type TableRowsPage = z.infer<typeof TableRowsPage>;

export const CreateTableRow = z.object({
  values: z.record(z.string(), CellValue).default({}),
  afterId: Id.nullable().optional(),
});
export type CreateTableRow = z.input<typeof CreateTableRow>;

export const UpdateTableRow = z.object({ values: z.record(z.string(), CellValue) });
export type UpdateTableRow = z.input<typeof UpdateTableRow>;

export const MoveTableRow = z.object({
  afterId: Id.nullable().default(null),
  beforeId: Id.nullable().default(null),
});

export const TableRowIds = z.object({ rowIds: z.array(Id).min(1).max(1000) });

export const TableRowComment = z.object({
  id: Id,
  rowId: Id,
  author: UserSummary.nullable(),
  text: z.string(),
  createdAt: Timestamp,
});
export type TableRowComment = z.infer<typeof TableRowComment>;

export const AddTableRowComment = z.object({ text: z.string().trim().min(1).max(4000) });

export const TableRowChange = z.object({
  fieldId: z.string(),
  fieldName: z.string(),
  from: CellValue,
  to: CellValue,
});

export const TableRowHistoryItem = z.object({
  id: Id,
  kind: z.enum(['created', 'updated', 'deleted', 'restored']),
  actor: UserSummary.nullable(),
  changes: z.array(TableRowChange),
  createdAt: Timestamp,
});
export type TableRowHistoryItem = z.infer<typeof TableRowHistoryItem>;

export const ImportTable = z.object({
  fileName: z.string().max(255),
  /** `data:<mime>;base64,…` of a .csv or .xlsx file. */
  dataURL: z.string().max(Math.ceil((TABLE_LIMITS.importBytes * 4) / 3) + 300),
  /** new: a table named after the file; append: add rows to tableId, columns matched by name. */
  mode: z.enum(['new', 'append']),
  tableId: Id.optional(),
  name: Name.optional(),
});

export const TableImportResult = z.object({
  tableId: Id,
  rowsAdded: z.number().int(),
  fieldsCreated: z.number().int(),
  /** Columns of the file no field matched (append). */
  skippedColumns: z.array(z.string()),
});

export const TableAttachmentTarget = z.object({ spaceId: Id, folderId: Id });

/** WS: something in the table changed; rowIds null = schema or many rows (refetch all). */
export const TablesWsEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('tables.changed'),
    tableId: Id,
    rev: z.number().int(),
    rowIds: z.array(Id).nullable(),
  }),
]);
export type TablesWsEvent = z.infer<typeof TablesWsEvent>;

/** Non-JSON routes outside the endpoint table. */
export const TABLES_RAW_PATHS = {
  /** GET ?viewId=&format=csv|xlsx, session: the view's rows as a file. */
  export: '/api/v1/tables/:tableId/export',
} as const;
