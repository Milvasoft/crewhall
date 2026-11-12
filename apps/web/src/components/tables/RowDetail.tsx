import {
  COMPUTED_FIELD_TYPES,
  type CellValue,
  type TableField,
  type TableRow,
  type TableRowHistoryItem,
} from '@crewhall/shared';
import {
  Avatar,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Icon,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  toast,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { formatRelative } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useMe } from '@/lib/session';
import { rowQuery, tableKeys } from '@/lib/tables/api';
import { fieldIcon, isEmptyCell } from '@/lib/tables/fields';
import { CellEditor } from './CellEditor';
import { CellView } from './CellView';
import { useTableCtx } from './context';

/** Field types edited in place in the detail; the others open a picker. */
const INLINE = new Set(['text', 'long_text', 'url', 'email', 'phone', 'number', 'currency', 'date', 'checkbox', 'rating']);

/** A row opened large (`?row=`): every field, comments and the change history. */
export function RowDetail({ rowId, onClose }: { rowId: string; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { table, canEdit } = useTableCtx();
  const row = useQuery(rowQuery(table.id, rowId));
  const primary = table.fields.find((f) => f.primary);
  const remove = useMutation({
    mutationFn: () => api.call('deleteTableRows', { params: { tableId: table.id }, body: { rowIds: [rowId] } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: tableKeys.rows(table.id) });
      onClose();
      toast(t('tables.row.deleted'), {
        action: {
          label: t('tables.row.undo'),
          onClick: () =>
            void api
              .call('restoreTableRows', { params: { tableId: table.id }, body: { rowIds: [rowId] } })
              .then(() => qc.invalidateQueries({ queryKey: tableKeys.rows(table.id) })),
        },
      });
    },
    onError: (e) => toast(t(errorKey(e))),
  });
  const title = row.data && primary ? String(row.data.values[primary.id] ?? '') : '';

  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent width={760} className="gap-3 p-0" aria-describedby={undefined}>
        <div className="flex items-center gap-2 border-b border-line px-6 pt-5 pb-3">
          <DialogTitle className="min-w-0 flex-1 truncate text-h font-semibold">
            {title || t('tables.cell.untitled')}
          </DialogTitle>
          {canEdit ? (
            <IconButton size="sm" tone="plain" aria-label={t('tables.row.delete')} onClick={() => remove.mutate()}>
              <Icon name="trash" size={16} />
            </IconButton>
          ) : null}
          <IconButton size="sm" tone="plain" aria-label={t('tables.row.close')} onClick={onClose}>
            <Icon name="x" size={16} />
          </IconButton>
        </div>
        {row.isLoading ? (
          <div className="flex flex-col gap-3 px-6 pb-6">
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
          </div>
        ) : row.data ? (
          <div className="grid min-h-0 gap-0 md:grid-cols-[1fr_280px]">
            <div className="flex min-w-0 flex-col gap-3 overflow-y-auto px-6 pb-6">
              {table.fields.map((f) => (
                <FieldRow key={f.id} field={f} row={row.data} />
              ))}
            </div>
            <div className="flex min-w-0 flex-col border-line px-4 pb-6 max-md:border-t max-md:pt-3 md:border-l">
              <Tabs defaultValue="comments" className="flex min-h-0 flex-1 flex-col gap-3">
                <TabsList>
                  <TabsTrigger value="comments">{t('tables.row.comments')}</TabsTrigger>
                  <TabsTrigger value="history">{t('tables.row.history')}</TabsTrigger>
                </TabsList>
                <TabsContent value="comments" className="flex min-h-0 flex-1 flex-col">
                  <Comments rowId={rowId} />
                </TabsContent>
                <TabsContent value="history" className="min-h-0 flex-1">
                  <History rowId={rowId} />
                </TabsContent>
              </Tabs>
            </div>
          </div>
        ) : (
          <p className="px-6 pb-6 text-sm text-fg3">{t('tables.row.missing')}</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function FieldRow({ field, row }: { field: TableField; row: TableRow }) {
  const { canEdit, updateCell } = useTableCtx();
  const value = row.values[field.id];
  const computed = COMPUTED_FIELD_TYPES.includes(field.type);
  const editable = canEdit && !computed;
  const commit = (v: CellValue) => {
    if (JSON.stringify(v) !== JSON.stringify(value ?? null)) void updateCell(row, field.id, v);
  };
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-1.5 text-xs font-semibold text-fg2">
        <Icon name={fieldIcon(field.type)} size={13} />
        {field.name}
      </span>
      {field.description ? <span className="text-xs text-fg3">{field.description}</span> : null}
      {editable && INLINE.has(field.type) ? (
        <CellEditor key={JSON.stringify(value ?? null)} field={field} value={value} onCommit={commit} autoFocus={false} />
      ) : editable ? (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="flex min-h-10 items-center rounded-lg bg-bg2 px-3 py-1.5 text-left text-sm hover:bg-capsule"
            >
              {isEmptyCell(value) ? <span className="text-fg3">—</span> : <CellView field={field} value={value} />}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-auto p-2">
            <CellEditor field={field} value={value} onCommit={commit} />
          </PopoverContent>
        </Popover>
      ) : (
        <div className="flex min-h-10 items-center rounded-lg px-3 py-1.5 text-sm shadow-[inset_0_0_0_1px_var(--line)]">
          {isEmptyCell(value) && field.type !== 'checkbox' ? <span className="text-fg3">—</span> : <CellView field={field} value={value} />}
        </div>
      )}
    </div>
  );
}

function Comments({ rowId }: { rowId: string }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const me = useMe();
  const { table } = useTableCtx();
  const [text, setText] = useState('');
  const key = tableKeys.comments(table.id, rowId);
  const list = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.call('listTableRowComments', { params: { tableId: table.id, rowId }, signal }),
  });
  const add = useMutation({
    mutationFn: () => api.call('addTableRowComment', { params: { tableId: table.id, rowId }, body: { text } }),
    onSuccess: () => {
      setText('');
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast(t(errorKey(e))),
  });
  const remove = useMutation({
    mutationFn: (commentId: string) => api.call('deleteTableRowComment', { params: { tableId: table.id, commentId } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
    onError: (e) => toast(t(errorKey(e))),
  });
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex max-h-[360px] min-h-0 flex-col gap-3 overflow-y-auto">
        {(list.data?.items ?? []).map((c) => (
          <div key={c.id} className="group flex gap-2">
            <Avatar name={c.author?.name ?? '?'} src={c.author?.imageUrl} size="sm" />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="flex items-center gap-1.5 text-xs">
                <span className="font-semibold text-fg">{c.author?.name}</span>
                <span className="text-fg3">{formatRelative(c.createdAt, locale)}</span>
                {c.author?.id === me?.user.id ? (
                  <button
                    type="button"
                    className="ml-auto text-fg3 opacity-0 group-hover:opacity-100 hover:text-danger focus-visible:opacity-100"
                    aria-label={t('tables.row.deleteComment')}
                    onClick={() => remove.mutate(c.id)}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                ) : null}
              </span>
              <p className="text-sm break-words whitespace-pre-wrap text-fg">{c.text}</p>
            </div>
          </div>
        ))}
        {list.data && list.data.items.length === 0 ? <p className="text-xs text-fg3">{t('tables.row.noComments')}</p> : null}
      </div>
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) add.mutate();
        }}
      >
        <Textarea
          aria-label={t('tables.row.commentPlaceholder')}
          placeholder={t('tables.row.commentPlaceholder')}
          value={text}
          rows={2}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
          }}
        />
        <Button size="xs" variant="inv" type="submit" className="self-end" disabled={!text.trim() || add.isPending}>
          {t('tables.row.send')}
        </Button>
      </form>
    </div>
  );
}

function History({ rowId }: { rowId: string }) {
  const { t, locale } = useI18n();
  const { table } = useTableCtx();
  const list = useQuery({
    queryKey: tableKeys.history(table.id, rowId),
    queryFn: ({ signal }) => api.call('listTableRowHistory', { params: { tableId: table.id, rowId }, signal }),
  });
  return (
    <div className="flex max-h-[420px] flex-col gap-3 overflow-y-auto">
      {(list.data?.items ?? []).map((h) => (
        <div key={h.id} className="flex gap-2">
          <Avatar name={h.actor?.name ?? '?'} src={h.actor?.imageUrl} size="sm" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-xs">
              <span className="font-semibold text-fg">{h.actor?.name ?? t('tables.row.system')}</span>{' '}
              <span className="text-fg2">{t(`tables.history.${h.kind}`)}</span>
            </span>
            <HistoryChanges item={h} />
            <span className="text-[11px] text-fg3">{formatRelative(h.createdAt, locale)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function HistoryChanges({ item }: { item: TableRowHistoryItem }) {
  const { table } = useTableCtx();
  if (item.kind !== 'updated') return null;
  return (
    <ul className="flex flex-col gap-1">
      {item.changes.map((c) => {
        const field = table.fields.find((f) => f.id === c.fieldId);
        return (
          <li key={c.fieldId} className="flex flex-wrap items-center gap-1 text-xs text-fg2">
            <span className="font-semibold">{field?.name ?? c.fieldName}:</span>
            {field ? (
              <>
                <span className="line-through opacity-70">
                  {isEmptyCell(c.from) ? '—' : <CellView field={field} value={c.from} compact />}
                </span>
                <Icon name="arrowR" size={11} />
                {isEmptyCell(c.to) ? '—' : <CellView field={field} value={c.to} compact />}
              </>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
