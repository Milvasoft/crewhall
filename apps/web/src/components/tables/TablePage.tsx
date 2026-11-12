import {
  type Table,
  type TableField,
  type TableRow,
  type TableView,
  type TableViewType,
  type ViewConfigInput,
} from '@crewhall/shared';
import {
  Button,
  cn,
  EmptyState,
  Icon,
  IconButton,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Skeleton,
  todayIso,
  toast,
  weekStartOf,
  type IconName,
} from '@crewhall/ui';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { ConfirmDialog } from '@/components/identity/parts';
import { Workspace } from '@/components/shell/Workspace';
import { spaceName } from '@/components/spaces/spaceUtils';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { monthGrid, timelineRange } from '@/lib/tables/dates';
import { rowsQuery, setTableCache, tableKeys, tableQuery } from '@/lib/tables/api';
import { useSpaces } from '@/lib/useSpaces';
import { GalleryView, KanbanView } from './CardViews';
import { TableProvider } from './context';
import { CalendarView, TimelineView } from './DateViews';
import { FieldDialog } from './FieldDialog';
import { GridView } from './GridView';
import { ImportDialog } from './NewTableDialog';
import { RowDetail } from './RowDetail';
import { TablesSidebar } from './TablesSidebar';
import { ViewToolbar } from './ViewToolbar';

export const VIEW_TYPES: { type: TableViewType; icon: IconName }[] = [
  { type: 'grid', icon: 'table' },
  { type: 'kanban', icon: 'board' },
  { type: 'calendar', icon: 'calendar' },
  { type: 'gallery', icon: 'grid' },
  { type: 'timeline', icon: 'sliders' },
];
const viewIcon = (type: TableViewType) => VIEW_TYPES.find((v) => v.type === type)?.icon ?? 'table';

/** A table (`/tables/t/:id?view=&row=`): view tabs, the toolbar and the chosen view. */
export function TablePage({
  tableId,
  viewId,
  rowId,
}: {
  tableId: string;
  viewId: string | undefined;
  rowId: string | undefined;
}) {
  const { t } = useI18n();
  const table = useQuery(tableQuery(tableId));
  const { items } = useSpaces();
  const space = items.find((s) => s.id === table.data?.spaceId);
  return (
    <Workspace
      sidebar={<TablesSidebar space={space} activeTableId={tableId} />}
      crumbs={[
        ...(space ? [{ label: spaceName(space, t) }] : []),
        {
          label: space ? (
            <Link to="/tables/$spaceSlug" params={{ spaceSlug: space.slug }} className="hover:underline">
              {t('tables.title')}
            </Link>
          ) : (
            t('tables.title')
          ),
        },
        ...(table.data ? [{ label: table.data.name }] : []),
      ]}
      bodyClassName="gap-3 md:py-4"
    >
      {table.isLoading ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-10 w-1/3" />
          <Skeleton className="h-64" />
        </div>
      ) : table.data ? (
        <TableProvider table={table.data}>
          <TableBody table={table.data} viewId={viewId} rowId={rowId} />
        </TableProvider>
      ) : (
        <EmptyState className="m-auto" icon="table" title={t('tables.notFound.title')} description={t('tables.notFound.body')} />
      )}
    </Workspace>
  );
}

function TableBody({ table, viewId, rowId }: { table: Table; viewId: string | undefined; rowId: string | undefined }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const view = table.views.find((v) => v.id === viewId) ?? table.views[0]!;
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [anchor, setAnchor] = useState(todayIso);
  const [fieldDialog, setFieldDialog] = useState<{ field: TableField | null } | null>(null);
  const [importing, setImporting] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setQ(qInput.trim()), 250);
    return () => window.clearTimeout(id);
  }, [qInput]);

  const go = useCallback(
    (search: { view?: string; row?: string }) =>
      void navigate({ to: '/tables/t/$tableId', params: { tableId: table.id }, search }),
    [navigate, table.id],
  );
  const openRow = (row: TableRow) => go({ view: view.id, row: row.id });

  const range =
    view.type === 'calendar'
      ? monthGrid(anchor, weekStartOf(locale))
      : view.type === 'timeline'
        ? timelineRange(anchor, weekStartOf(locale), 6)
        : null;
  const rows = useInfiniteQuery(rowsQuery(table.id, view.id, q, range ? { from: range.from, to: range.to } : undefined));
  const loaded = rows.data?.pages.flatMap((p) => p.items) ?? [];
  const first = rows.data?.pages[0];
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = rows;
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const updateView = useMutation({
    mutationFn: (v: { id: string; name?: string; config?: ViewConfigInput }) =>
      api.call('updateTableView', {
        params: { tableId: table.id, viewId: v.id },
        body: { ...(v.name ? { name: v.name } : {}), ...(v.config ? { config: v.config } : {}) },
      }),
    onMutate: (v) => {
      // The view changes at once; the rows refetch with the new query.
      setTableCache(qc, {
        ...table,
        views: table.views.map((x) =>
          x.id === v.id ? { ...x, name: v.name ?? x.name, config: { ...x.config, ...v.config } as TableView['config'] } : x,
        ),
      });
    },
    onSuccess: (saved) => {
      const cur = qc.getQueryData<Table>(tableKeys.table(table.id));
      if (cur) setTableCache(qc, { ...cur, views: cur.views.map((x) => (x.id === saved.id ? saved : x)) });
      void qc.invalidateQueries({ queryKey: tableKeys.rows(table.id) });
    },
    onError: (e) => {
      toast(t(errorKey(e)));
      void qc.invalidateQueries({ queryKey: tableKeys.table(table.id) });
    },
  });
  const onUpdateView = (config: ViewConfigInput) => updateView.mutate({ id: view.id, config });

  const createView = useMutation({
    mutationFn: (type: TableViewType) =>
      api.call('createTableView', { params: { tableId: table.id }, body: { name: t(`tables.viewTypes.${type}`), type } }),
    onSuccess: (v) => {
      setTableCache(qc, { ...table, views: [...table.views, v] });
      go({ view: v.id });
    },
    onError: (e) => toast(t(errorKey(e))),
  });
  const deleteView = useMutation({
    mutationFn: (id: string) => api.call('deleteTableView', { params: { tableId: table.id, viewId: id } }),
    onSuccess: (_, id) => {
      setTableCache(qc, { ...table, views: table.views.filter((v) => v.id !== id) });
      go({});
    },
    onError: (e) => toast(t(errorKey(e))),
  });

  return (
    <>
      <TableHeader table={table} />
      <div className="flex items-center gap-1 overflow-x-auto border-b border-line" role="tablist" aria-label={t('tables.views.label')}>
        {table.views.map((v) => (
          <ViewTab
            key={v.id}
            view={v}
            active={v.id === view.id}
            canEdit={table.canEdit}
            onSelect={() => go({ view: v.id })}
            onRename={(name) => updateView.mutate({ id: v.id, name })}
            onDelete={table.views.length > 1 ? () => deleteView.mutate(v.id) : undefined}
          />
        ))}
        {table.canEdit ? (
          <Menu>
            <MenuTrigger asChild>
              <Button size="xs" variant="gh" className="mb-1 shrink-0">
                <Icon name="plus" size={14} />
                {t('tables.views.add')}
              </Button>
            </MenuTrigger>
            <MenuContent align="start">
              {VIEW_TYPES.map((v) => (
                <MenuItem key={v.type} onSelect={() => createView.mutate(v.type)}>
                  <Icon name={v.icon} size={14} />
                  {t(`tables.viewTypes.${v.type}`)}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
        ) : null}
      </div>
      <ViewToolbar
        view={view}
        q={qInput}
        onQ={setQInput}
        onUpdateView={onUpdateView}
        onImport={() => setImporting(true)}
        total={first?.total ?? 0}
      />
      {rows.isLoading ? (
        <Skeleton className="h-64" />
      ) : view.type === 'grid' ? (
        <GridView
          view={view}
          rows={loaded}
          total={first?.total ?? 0}
          groups={first?.groups ?? null}
          hasMore={Boolean(hasNextPage)}
          loadMore={loadMore}
          onOpenRow={openRow}
          onEditField={(field) => setFieldDialog({ field })}
          onAddField={() => setFieldDialog({ field: null })}
          onUpdateView={onUpdateView}
        />
      ) : view.type === 'kanban' ? (
        <KanbanView view={view} rows={loaded} hasMore={Boolean(hasNextPage)} loadMore={loadMore} onOpenRow={openRow} onUpdateView={onUpdateView} />
      ) : view.type === 'gallery' ? (
        <GalleryView view={view} rows={loaded} hasMore={Boolean(hasNextPage)} loadMore={loadMore} onOpenRow={openRow} onUpdateView={onUpdateView} />
      ) : view.type === 'calendar' ? (
        <CalendarView view={view} rows={loaded} anchor={anchor} onAnchor={setAnchor} onOpenRow={openRow} onUpdateView={onUpdateView} />
      ) : (
        <TimelineView view={view} rows={loaded} anchor={anchor} onAnchor={setAnchor} onOpenRow={openRow} onUpdateView={onUpdateView} />
      )}
      {fieldDialog ? <FieldDialog field={fieldDialog.field} open onClose={() => setFieldDialog(null)} /> : null}
      <ImportDialog tableId={table.id} spaceId={table.spaceId} open={importing} onClose={() => setImporting(false)} />
      {rowId ? <RowDetail rowId={rowId} onClose={() => go({ view: view.id })} /> : null}
    </>
  );
}

function ViewTab({
  view,
  active,
  canEdit,
  onSelect,
  onRename,
  onDelete,
}: {
  view: TableView;
  active: boolean;
  canEdit: boolean;
  onSelect: () => void;
  onRename: (name: string) => void;
  onDelete?: () => void;
}) {
  const { t } = useI18n();
  const [renaming, setRenaming] = useState(false);
  if (renaming) {
    return (
      <Input
        autoFocus
        defaultValue={view.name}
        aria-label={t('tables.views.rename')}
        className="mb-1 h-8 w-40 text-[13px]"
        onBlur={(e) => {
          const name = e.target.value.trim();
          if (name && name !== view.name) onRename(name);
          setRenaming(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') setRenaming(false);
        }}
      />
    );
  }
  return (
    <div
      className={cn(
        'group -mb-px flex shrink-0 items-center gap-0.5 border-b-2 border-transparent',
        active && 'border-fg',
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        onClick={onSelect}
        onDoubleClick={() => canEdit && setRenaming(true)}
        className={cn('flex h-9 items-center gap-1.5 px-2.5 text-[13.5px] font-medium text-fg2 hover:text-fg', active && 'font-semibold text-fg')}
      >
        <Icon name={viewIcon(view.type)} size={15} />
        {view.name}
      </button>
      {canEdit && active ? (
        <Menu>
          <MenuTrigger asChild>
            <IconButton size="xs" tone="plain" aria-label={t('tables.views.options')}>
              <Icon name="chevD" size={13} />
            </IconButton>
          </MenuTrigger>
          <MenuContent align="start">
            <MenuItem onSelect={() => setRenaming(true)}>
              <Icon name="edit" size={14} />
              {t('tables.views.rename')}
            </MenuItem>
            {onDelete ? (
              <>
                <MenuSeparator />
                <MenuItem onSelect={onDelete} className="text-danger">
                  <Icon name="trash" size={14} />
                  {t('tables.views.delete')}
                </MenuItem>
              </>
            ) : null}
          </MenuContent>
        </Menu>
      ) : null}
    </div>
  );
}

/** Table name (renamed in place), description and the table menu. */
function TableHeader({ table }: { table: Table }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { items } = useSpaces();
  const space = items.find((s) => s.id === table.spaceId);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const update = useMutation({
    mutationFn: (name: string) => api.call('updateTable', { params: { tableId: table.id }, body: { name } }),
    onSuccess: (tbl) => setTableCache(qc, tbl),
    onError: (e) => toast(t(errorKey(e))),
  });
  const remove = useMutation({
    mutationFn: () => api.call('deleteTable', { params: { tableId: table.id } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: tableKeys.list(table.spaceId) });
      if (space) void navigate({ to: '/tables/$spaceSlug', params: { spaceSlug: space.slug } });
    },
    onError: (e) => toast(t(errorKey(e))),
  });
  return (
    <div className="flex items-center gap-2">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-bg2">
        <Icon name="table" size={18} />
      </span>
      {renaming ? (
        <Input
          autoFocus
          defaultValue={table.name}
          aria-label={t('tables.header.rename')}
          className="h-10 max-w-md text-title font-bold"
          onBlur={(e) => {
            const name = e.target.value.trim();
            if (name && name !== table.name) update.mutate(name);
            setRenaming(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') setRenaming(false);
          }}
        />
      ) : (
        <h1
          className={cn('min-w-0 truncate text-title font-bold', table.canEdit && 'cursor-text')}
          onDoubleClick={() => table.canEdit && setRenaming(true)}
        >
          {table.name}
        </h1>
      )}
      {table.canEdit ? (
        <Menu>
          <MenuTrigger asChild>
            <IconButton size="sm" tone="plain" aria-label={t('tables.header.menu')}>
              <Icon name="dots" size={16} />
            </IconButton>
          </MenuTrigger>
          <MenuContent align="start">
            <MenuItem onSelect={() => setRenaming(true)}>
              <Icon name="edit" size={14} />
              {t('tables.header.rename')}
            </MenuItem>
            <MenuSeparator />
            <MenuItem onSelect={() => setDeleting(true)} className="text-danger">
              <Icon name="trash" size={14} />
              {t('tables.header.delete')}
            </MenuItem>
          </MenuContent>
        </Menu>
      ) : null}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('tables.header.deleteTitle', { name: table.name })}
        body={t('tables.header.deleteBody')}
        confirm={t('tables.header.delete')}
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </div>
  );
}
