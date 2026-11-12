import {
  TABLES_RAW_PATHS,
  type Table,
  type TableRow,
  type TableRowsPage,
  type TablesWsEvent,
} from '@crewhall/shared';
import {
  infiniteQueryOptions,
  queryOptions,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import { config } from '@/config';
import { api } from '@/lib/api';

/** Tables queries (sonraki-isler.md › Tablolar) and the `tables.changed` handler. */

export const tableKeys = {
  all: ['tables'] as const,
  list: (spaceId: string) => ['tables', 'list', spaceId] as const,
  table: (tableId: string) => ['tables', 'table', tableId] as const,
  rows: (tableId: string) => ['tables', 'rows', tableId] as const,
  view: (tableId: string, viewId: string | null, q: string, range: string) =>
    ['tables', 'rows', tableId, viewId, q, range] as const,
  row: (tableId: string, rowId: string) => ['tables', 'row', tableId, rowId] as const,
  comments: (tableId: string, rowId: string) => ['tables', 'comments', tableId, rowId] as const,
  history: (tableId: string, rowId: string) => ['tables', 'history', tableId, rowId] as const,
};

export const PAGE = 200;

export const tablesQuery = (spaceId: string) =>
  queryOptions({
    queryKey: tableKeys.list(spaceId),
    queryFn: ({ signal }) => api.call('listTables', { params: { spaceId }, signal }),
    staleTime: 30_000,
  });

export const tableQuery = (tableId: string) =>
  queryOptions({
    queryKey: tableKeys.table(tableId),
    queryFn: ({ signal }) => api.call('getTable', { params: { tableId }, signal }),
    staleTime: 15_000,
    retry: false,
  });

/** Pages of a view's rows, fetched as the grid scrolls. */
export const rowsQuery = (
  tableId: string,
  viewId: string | null,
  q: string,
  range?: { from: string; to: string },
) =>
  infiniteQueryOptions({
    queryKey: tableKeys.view(tableId, viewId, q, range ? `${range.from}..${range.to}` : ''),
    queryFn: ({ pageParam, signal }) =>
      api.call('queryTableRows', {
        params: { tableId },
        query: {
          limit: range ? 500 : PAGE,
          ...(viewId ? { viewId } : {}),
          ...(q ? { q } : {}),
          ...(range ? range : {}),
          ...(pageParam ? { cursor: pageParam } : {}),
        },
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 10_000,
  });

export const rowQuery = (tableId: string, rowId: string) =>
  queryOptions({
    queryKey: tableKeys.row(tableId, rowId),
    queryFn: ({ signal }) => api.call('getTableRow', { params: { tableId, rowId }, signal }),
    retry: false,
  });

/** Puts a written row into every cached page it appears in (instant feedback before refetch). */
export function patchRow(qc: QueryClient, row: TableRow) {
  qc.setQueriesData<InfiniteData<TableRowsPage>>({ queryKey: tableKeys.rows(row.tableId) }, (data) =>
    data
      ? {
          ...data,
          pages: data.pages.map((p) => ({
            ...p,
            items: p.items.map((r) => (r.id === row.id ? row : r)),
          })),
        }
      : data,
  );
  qc.setQueryData(tableKeys.row(row.tableId, row.id), row);
}

export function setTableCache(qc: QueryClient, table: Table) {
  qc.setQueryData(tableKeys.table(table.id), table);
  void qc.invalidateQueries({ queryKey: tableKeys.list(table.spaceId) });
}

/** Someone changed the table: refetch rows (and the schema when it was not about rows). */
export function handleTablesEvent(qc: QueryClient, e: TablesWsEvent) {
  const cached = qc.getQueryData<Table>(tableKeys.table(e.tableId));
  if (cached && cached.rev >= e.rev && e.rowIds !== null) return;
  if (e.rowIds === null) void qc.invalidateQueries({ queryKey: tableKeys.table(e.tableId) });
  void qc.invalidateQueries({ queryKey: tableKeys.rows(e.tableId) });
  for (const id of e.rowIds ?? []) {
    void qc.invalidateQueries({ queryKey: tableKeys.row(e.tableId, id) });
    void qc.invalidateQueries({ queryKey: tableKeys.comments(e.tableId, id) });
    void qc.invalidateQueries({ queryKey: tableKeys.history(e.tableId, id) });
  }
}

export const exportUrl = (tableId: string, viewId: string | null, format: 'csv' | 'xlsx') =>
  `${config.apiUrl.replace(/\/$/, '')}${TABLES_RAW_PATHS.export.replace(':tableId', tableId)}?format=${format}${viewId ? `&viewId=${viewId}` : ''}`;
