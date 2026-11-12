import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth';
import { organizations } from './org';
import { spaces } from './space';
import { id, textC, textTr, timestamps, tz } from './types';

/**
 * Tables (sonraki-isler.md › Tablolar). Owned by the tables session.
 *
 * Field settings, row values (by field id) and view settings are JSON validated by the schemas in
 * @crewhall/shared (TableFieldOptions, CellValue, ViewConfig). Computed values (formula, lookup,
 * rollup) are never stored. Positions are fractional keys compared in byte order.
 */

export type TableCellData =
  | string
  | number
  | boolean
  | string[]
  | { nodeId: string; name: string; mime: string | null; sizeBytes: number }[]
  | (string | number | boolean | null)[]
  | null;

export interface TableFieldOptionsData {
  choices?: { id: string; label: string; color: string }[];
  precision?: number;
  currency?: string;
  includeTime?: boolean;
  max?: number;
  multiple?: boolean;
  tableId?: string;
  relationFieldId?: string;
  targetFieldId?: string;
  fn?: string;
  formula?: string;
}

export interface TableViewConfigData {
  filterMode: 'and' | 'or';
  filters: { fieldId: string; op: string; value: string | string[] | null }[];
  sorts: { fieldId: string; dir: 'asc' | 'desc' }[];
  groupBy: string | null;
  hidden: string[];
  order: string[];
  widths: Record<string, number>;
  kanbanFieldId: string | null;
  dateFieldId: string | null;
  endDateFieldId: string | null;
  coverFieldId: string | null;
}

export const dataTables = pgTable(
  'data_tables',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    name: textTr('name').notNull(),
    description: text('description'),
    icon: text('icon'),
    /** Grows with every change (WS `tables.changed`). */
    rev: integer('rev').notNull().default(0),
    /** Drive folder of attachment cells, made on first upload. */
    attachmentFolderId: uuid('attachment_folder_id'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [index('data_tables_space_idx').on(t.spaceId, t.updatedAt)],
);

export const tableFields = pgTable(
  'table_fields',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    tableId: uuid('table_id')
      .notNull()
      .references(() => dataTables.id, { onDelete: 'cascade' }),
    name: textTr('name').notNull(),
    type: text('type').notNull(),
    options: jsonb('options').$type<TableFieldOptionsData>().notNull().default({}),
    description: text('description'),
    primary: boolean('primary').notNull().default(false),
    position: textC('position').notNull(),
    ...timestamps(),
  },
  (t) => [index('table_fields_table_idx').on(t.tableId, t.position)],
);

export const tableViews = pgTable(
  'table_views',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    tableId: uuid('table_id')
      .notNull()
      .references(() => dataTables.id, { onDelete: 'cascade' }),
    name: textTr('name').notNull(),
    type: text('type', { enum: ['grid', 'kanban', 'calendar', 'gallery', 'timeline'] }).notNull(),
    config: jsonb('config').$type<TableViewConfigData>().notNull(),
    position: textC('position').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [index('table_views_table_idx').on(t.tableId, t.position)],
);

export const tableRows = pgTable(
  'table_rows',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    tableId: uuid('table_id')
      .notNull()
      .references(() => dataTables.id, { onDelete: 'cascade' }),
    values: jsonb('values').$type<Record<string, TableCellData>>().notNull().default({}),
    position: textC('position').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    deletedAt: tz('deleted_at'),
    ...timestamps(),
  },
  (t) => [
    index('table_rows_live_idx')
      .on(t.tableId, t.position)
      .where(sql`${t.deletedAt} is null`),
    index('table_rows_values_gin').using('gin', t.values),
  ],
);

export const tableRowComments = pgTable(
  'table_row_comments',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    tableId: uuid('table_id')
      .notNull()
      .references(() => dataTables.id, { onDelete: 'cascade' }),
    rowId: uuid('row_id')
      .notNull()
      .references(() => tableRows.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    text: text('text').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [index('table_row_comments_row_idx').on(t.rowId, t.createdAt)],
);

export const tableRowHistory = pgTable(
  'table_row_history',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    tableId: uuid('table_id')
      .notNull()
      .references(() => dataTables.id, { onDelete: 'cascade' }),
    rowId: uuid('row_id')
      .notNull()
      .references(() => tableRows.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    kind: text('kind', { enum: ['created', 'updated', 'deleted', 'restored'] }).notNull(),
    changes: jsonb('changes')
      .$type<{ fieldId: string; fieldName: string; from: TableCellData; to: TableCellData }[]>()
      .notNull()
      .default([]),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [index('table_row_history_row_idx').on(t.rowId, t.createdAt)],
);
