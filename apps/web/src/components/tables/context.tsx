import { type Table, type TableRow, type UserSummary } from '@crewhall/shared';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@crewhall/ui';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { spaceMembersQuery } from '@/lib/queries';
import { patchRow, tableKeys } from '@/lib/tables/api';

/**
 * What every view of a table shares: the table (fields, views), people of the space, titles of
 * related rows, and the row writes (with instant cache updates).
 */
interface TableCtxValue {
  table: Table;
  people: Map<string, UserSummary>;
  /** Related table id → row id → primary field text. */
  titles: Map<string, Map<string, string>>;
  canEdit: boolean;
  updateCell: (row: TableRow, fieldId: string, value: unknown) => Promise<TableRow | null>;
  addRow: (values?: Record<string, unknown>) => Promise<TableRow | null>;
}

const Ctx = createContext<TableCtxValue | null>(null);

export function useTableCtx() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTableCtx outside TableProvider');
  return v;
}

export function TableProvider({ table, children }: { table: Table; children: ReactNode }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const members = useQuery(spaceMembersQuery(table.spaceId));
  const relatedIds = [
    ...new Set(
      table.fields
        .filter((f) => f.type === 'relation' && f.options.tableId)
        .map((f) => f.options.tableId!),
    ),
  ];
  const related = useQueries({
    queries: relatedIds.map((id) => ({
      queryKey: [...tableKeys.rows(id), 'titles'],
      queryFn: async () => {
        const [tbl, rows] = await Promise.all([
          api.call('getTable', { params: { tableId: id } }),
          api.call('queryTableRows', { params: { tableId: id }, query: { limit: 500 } }),
        ]);
        const primary = tbl.fields.find((f) => f.primary);
        return new Map(rows.items.map((r) => [r.id, primary ? String(r.values[primary.id] ?? '') : r.id]));
      },
      staleTime: 30_000,
    })),
  });
  const people = useMemo(
    () => new Map((members.data?.items ?? []).map((m) => [m.user.id, m.user])),
    [members.data],
  );
  const titleKey = related.map((r) => r.dataUpdatedAt).join(',');
  const relatedKey = relatedIds.join(',');
  const titles = useMemo(
    () => new Map(relatedIds.map((id, i) => [id, related[i]?.data ?? new Map<string, string>()])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [titleKey, relatedKey],
  );

  const update = useMutation({
    mutationFn: (v: { rowId: string; values: Record<string, unknown> }) =>
      api.call('updateTableRow', {
        params: { tableId: table.id, rowId: v.rowId },
        body: { values: v.values as never },
      }),
    onSuccess: (row) => patchRow(qc, row),
    onError: (e) => toast(t(errorKey(e))),
  });
  const create = useMutation({
    mutationFn: (values: Record<string, unknown>) =>
      api.call('createTableRow', { params: { tableId: table.id }, body: { values: values as never } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: tableKeys.rows(table.id) }),
    onError: (e) => toast(t(errorKey(e))),
  });

  const value: TableCtxValue = {
    table,
    people,
    titles,
    canEdit: table.canEdit,
    updateCell: async (row, fieldId, v) => {
      // Optimistic: show the value at once; the server's answer replaces it.
      patchRow(qc, { ...row, values: { ...row.values, [fieldId]: v as never } });
      try {
        return await update.mutateAsync({ rowId: row.id, values: { [fieldId]: v } });
      } catch {
        patchRow(qc, row);
        return null;
      }
    },
    addRow: async (values = {}) => {
      try {
        return await create.mutateAsync(values);
      } catch {
        return null;
      }
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
