import { def, Empty, items, type EndpointDef } from '../endpoint-def';
import {
  AddTableRowComment,
  CreateTable,
  CreateTableField,
  CreateTableRow,
  CreateTableView,
  TableImportResult,
  ImportTable,
  MoveTableRow,
  QueryTableRows,
  Table,
  TableAttachmentTarget,
  TableField,
  TableRow,
  TableRowComment,
  TableRowHistoryItem,
  TableRowIds,
  TableRowsPage,
  TableSummary,
  TableView,
  UpdateTable,
  UpdateTableField,
  UpdateTableRow,
  UpdateTableView,
} from '../schemas/tables';

/**
 * Tables module contract (sonraki-isler.md › Tablolar). Only the tables session edits this file;
 * see docs/contracts/moduller.md. File export is outside the table: TABLES_RAW_PATHS.
 */
export const tablesEndpoints = {
  // ---- Tables ---------------------------------------------------------------------------
  listTables: def({
    method: 'GET',
    path: '/api/v1/spaces/:spaceId/tables',
    auth: 'session',
    response: items(TableSummary),
  }),
  createTable: def({
    method: 'POST',
    path: '/api/v1/spaces/:spaceId/tables',
    auth: 'session',
    body: CreateTable,
    response: Table,
  }),
  /** A .csv or .xlsx file as a new table, or rows added to an existing one. */
  importTable: def({
    method: 'POST',
    path: '/api/v1/spaces/:spaceId/tables/import',
    auth: 'session',
    body: ImportTable,
    response: TableImportResult,
  }),
  /**
   * A table for a form's answers: a field per question (same name and a matching type), named
   * after the form. Needs forms.manage on the form and tables.edit in its space.
   */
  createFormTable: def({
    method: 'POST',
    path: '/api/v1/forms/:formId/table',
    auth: 'session',
    response: Table,
  }),
  /** Fields, views and the row count; rows come from queryTableRows. */
  getTable: def({
    method: 'GET',
    path: '/api/v1/tables/:tableId',
    auth: 'session',
    response: Table,
  }),
  updateTable: def({
    method: 'PATCH',
    path: '/api/v1/tables/:tableId',
    auth: 'session',
    body: UpdateTable,
    response: Table,
  }),
  /** For good, with rows, comments and history. */
  deleteTable: def({
    method: 'DELETE',
    path: '/api/v1/tables/:tableId',
    auth: 'session',
    response: Empty,
  }),
  /** Folder for uploaded attachment cells ("<table> · Ekler" in the space). */
  getTableAttachmentFolder: def({
    method: 'POST',
    path: '/api/v1/tables/:tableId/attachment-folder',
    auth: 'session',
    response: TableAttachmentTarget,
  }),

  // ---- Fields ---------------------------------------------------------------------------
  createTableField: def({
    method: 'POST',
    path: '/api/v1/tables/:tableId/fields',
    auth: 'session',
    body: CreateTableField,
    response: TableField,
  }),
  updateTableField: def({
    method: 'PATCH',
    path: '/api/v1/tables/:tableId/fields/:fieldId',
    auth: 'session',
    body: UpdateTableField,
    response: TableField,
  }),
  /** The primary field cannot go; lookups, rollups and views using it are cleared. */
  deleteTableField: def({
    method: 'DELETE',
    path: '/api/v1/tables/:tableId/fields/:fieldId',
    auth: 'session',
    response: Empty,
  }),

  // ---- Views ----------------------------------------------------------------------------
  createTableView: def({
    method: 'POST',
    path: '/api/v1/tables/:tableId/views',
    auth: 'session',
    body: CreateTableView,
    response: TableView,
  }),
  updateTableView: def({
    method: 'PATCH',
    path: '/api/v1/tables/:tableId/views/:viewId',
    auth: 'session',
    body: UpdateTableView,
    response: TableView,
  }),
  /** The last view cannot go. */
  deleteTableView: def({
    method: 'DELETE',
    path: '/api/v1/tables/:tableId/views/:viewId',
    auth: 'session',
    response: Empty,
  }),

  // ---- Rows -----------------------------------------------------------------------------
  /** Filtered, searched, sorted and grouped on the server; offset pages. */
  queryTableRows: def({
    method: 'GET',
    path: '/api/v1/tables/:tableId/rows',
    auth: 'session',
    query: QueryTableRows,
    response: TableRowsPage,
  }),
  getTableRow: def({
    method: 'GET',
    path: '/api/v1/tables/:tableId/rows/:rowId',
    auth: 'session',
    response: TableRow,
  }),
  createTableRow: def({
    method: 'POST',
    path: '/api/v1/tables/:tableId/rows',
    auth: 'session',
    body: CreateTableRow,
    response: TableRow,
  }),
  /** Only the given fields change (cell by cell; the last writer of a cell wins). */
  updateTableRow: def({
    method: 'PATCH',
    path: '/api/v1/tables/:tableId/rows/:rowId',
    auth: 'session',
    body: UpdateTableRow,
    response: TableRow,
  }),
  moveTableRow: def({
    method: 'POST',
    path: '/api/v1/tables/:tableId/rows/:rowId/move',
    auth: 'session',
    body: MoveTableRow,
    response: TableRow,
  }),
  /** Rows are hidden, not erased: restoreTableRows brings them back. */
  deleteTableRows: def({
    method: 'POST',
    path: '/api/v1/tables/:tableId/bulk-delete',
    auth: 'session',
    body: TableRowIds,
    response: Empty,
  }),
  restoreTableRows: def({
    method: 'POST',
    path: '/api/v1/tables/:tableId/bulk-restore',
    auth: 'session',
    body: TableRowIds,
    response: Empty,
  }),
  listTableRowComments: def({
    method: 'GET',
    path: '/api/v1/tables/:tableId/rows/:rowId/comments',
    auth: 'session',
    response: items(TableRowComment),
  }),
  addTableRowComment: def({
    method: 'POST',
    path: '/api/v1/tables/:tableId/rows/:rowId/comments',
    auth: 'session',
    body: AddTableRowComment,
    response: TableRowComment,
  }),
  /** Own comments; table editors may remove any. */
  deleteTableRowComment: def({
    method: 'DELETE',
    path: '/api/v1/tables/:tableId/comments/:commentId',
    auth: 'session',
    response: Empty,
  }),
  listTableRowHistory: def({
    method: 'GET',
    path: '/api/v1/tables/:tableId/rows/:rowId/history',
    auth: 'session',
    response: items(TableRowHistoryItem),
  }),
} as const satisfies Record<string, EndpointDef>;
