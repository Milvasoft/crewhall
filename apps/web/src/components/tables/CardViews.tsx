import { type TableAttachment, type TableField, type TableRow, type TableView, type ViewConfigInput } from '@crewhall/shared';
import { Button, cn, EmptyState, Icon, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@crewhall/ui';
import { useState, type DragEvent } from 'react';
import { rawPreviewUrl } from '@/features/drive/urls';
import { useI18n } from '@/lib/i18n/I18nContext';
import { isEmptyCell, viewFields } from '@/lib/tables/fields';
import { CellView, ChoiceChip } from './CellView';
import { useTableCtx } from './context';

interface CardViewProps {
  view: TableView;
  rows: TableRow[];
  hasMore: boolean;
  loadMore: () => void;
  onOpenRow: (row: TableRow) => void;
  onUpdateView: (config: ViewConfigInput) => void;
}

const DRAG_TYPE = 'application/x-crewhall-row';

/** The card of kanban and gallery: cover image, title, a few visible fields. */
function RowCard({
  view,
  row,
  onOpen,
  draggable,
  cover = true,
}: {
  view: TableView;
  row: TableRow;
  onOpen: () => void;
  draggable?: boolean;
  cover?: boolean;
}) {
  const { t } = useI18n();
  const { table } = useTableCtx();
  const fields = viewFields(table.fields, view);
  const primary = fields.find((f) => f.primary);
  const coverField = table.fields.find((f) => f.id === view.config.coverFieldId && f.type === 'attachment');
  const image = coverField
    ? ((row.values[coverField.id] as TableAttachment[] | undefined) ?? []).find((a) => a.mime?.startsWith('image/'))
    : undefined;
  const shown = fields
    .filter((f) => !f.primary && f.id !== view.config.kanbanFieldId && f.id !== coverField?.id)
    .filter((f) => !isEmptyCell(row.values[f.id]))
    .slice(0, 4);
  return (
    <button
      type="button"
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, row.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={onOpen}
      className="flex w-full flex-col overflow-hidden rounded-xl bg-surface text-left shadow-[0_0_0_1px_var(--line)] hover:shadow-[0_0_0_1px_var(--line2),var(--shSm)]"
    >
      {cover && coverField ? (
        <div className="flex aspect-[16/9] w-full items-center justify-center bg-bg2">
          {image ? (
            <img src={rawPreviewUrl(image.nodeId, 'thumb_256')} alt="" className="size-full object-cover" loading="lazy" />
          ) : (
            <Icon name="image" size={22} className="text-fg3" />
          )}
        </div>
      ) : null}
      <div className="flex flex-col gap-1.5 p-3">
        <span className="text-sm font-semibold break-words text-fg">
          {(primary && String(row.values[primary.id] ?? '')) || t('tables.cell.untitled')}
        </span>
        {shown.map((f) => (
          <span key={f.id} className="flex min-w-0 items-center gap-1.5 text-xs text-fg2">
            <span className="shrink-0 text-fg3">{f.name}</span>
            <span className="flex min-w-0 items-center overflow-hidden">
              <CellView field={f} value={row.values[f.id]} compact />
            </span>
          </span>
        ))}
      </div>
    </button>
  );
}

function MoreButton({ hasMore, loadMore }: { hasMore: boolean; loadMore: () => void }) {
  const { t } = useI18n();
  return hasMore ? (
    <Button size="xs" variant="gh" className="self-center" onClick={loadMore}>
      {t('tables.views.loadMore')}
    </Button>
  ) : null;
}

/** Pick a field for a view setting (kanban column field, dates, cover). */
export function ViewFieldSelect({
  label,
  fields,
  value,
  onChange,
  allowNone,
}: {
  label: string;
  fields: TableField[];
  value: string | null;
  onChange: (id: string | null) => void;
  allowNone?: boolean;
}) {
  const { t } = useI18n();
  return (
    <label className="flex items-center gap-2 text-xs text-fg2">
      {label}
      <Select value={value ?? '__none__'} onValueChange={(v) => onChange(v === '__none__' ? null : v)}>
        <SelectTrigger size="sm" className="h-8 w-[170px]" aria-label={label}>
          <SelectValue placeholder={t('tables.toolbar.none')} />
        </SelectTrigger>
        <SelectContent>
          {allowNone ? <SelectItem value="__none__">{t('tables.toolbar.none')}</SelectItem> : null}
          {fields.map((f) => (
            <SelectItem key={f.id} value={f.id}>
              {f.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}

/** Kanban: a column per choice of a single-select field; drag a card to change its value. */
export function KanbanView({ view, rows, hasMore, loadMore, onOpenRow, onUpdateView }: CardViewProps) {
  const { t } = useI18n();
  const { table, canEdit, updateCell, addRow } = useTableCtx();
  const [over, setOver] = useState<string | null>(null);
  const selects = table.fields.filter((f) => f.type === 'single_select');
  const field = selects.find((f) => f.id === view.config.kanbanFieldId) ?? selects[0];
  const attachments = table.fields.filter((f) => f.type === 'attachment');
  if (!field) {
    return <EmptyState className="m-auto" icon="board" title={t('tables.views.needSelect')} description={t('tables.views.needSelectBody')} />;
  }
  const columns = [
    ...(field.options.choices ?? []).map((c) => ({ id: c.id, label: c.label, color: c.color })),
    { id: '', label: t('tables.views.noValue'), color: 'gray' as const },
  ];
  const byColumn = new Map<string, TableRow[]>(columns.map((c) => [c.id, []]));
  for (const r of rows) {
    const v = r.values[field.id];
    (byColumn.get(typeof v === 'string' && byColumn.has(v) ? v : '') ?? []).push(r);
  }
  const drop = (e: DragEvent, columnId: string) => {
    e.preventDefault();
    setOver(null);
    const id = e.dataTransfer.getData(DRAG_TYPE);
    const row = rows.find((r) => r.id === id);
    if (row && (row.values[field.id] ?? '') !== columnId) void updateCell(row, field.id, columnId || null);
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap gap-3">
        <ViewFieldSelect
          label={t('tables.views.groupField')}
          fields={selects}
          value={field.id}
          onChange={(id) => canEdit && onUpdateView({ kanbanFieldId: id })}
        />
        {attachments.length ? (
          <ViewFieldSelect
            label={t('tables.views.cover')}
            fields={attachments}
            value={view.config.coverFieldId}
            allowNone
            onChange={(id) => canEdit && onUpdateView({ coverFieldId: id })}
          />
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2">
        {columns.map((c) => {
          const items = byColumn.get(c.id) ?? [];
          if (c.id === '' && items.length === 0) return null;
          return (
            <section
              key={c.id || 'none'}
              aria-label={c.label}
              onDragOver={(e) => {
                if (!canEdit || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
                e.preventDefault();
                setOver(c.id);
              }}
              onDragLeave={() => setOver((o) => (o === c.id ? null : o))}
              onDrop={(e) => drop(e, c.id)}
              className={cn(
                'flex w-[272px] shrink-0 flex-col gap-2 rounded-2xl bg-bg2 p-2 transition-shadow',
                over === c.id && 'shadow-[inset_0_0_0_2px_var(--accent)]',
              )}
            >
              <header className="flex items-center gap-2 px-1 pt-1">
                <ChoiceChip label={c.label} color={c.color} />
                <span className="text-xs text-fg3 tabular-nums">{items.length}</span>
              </header>
              <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
                {items.map((r) => (
                  <RowCard key={r.id} view={view} row={r} draggable={canEdit} onOpen={() => onOpenRow(r)} />
                ))}
              </div>
              {canEdit ? (
                <Button
                  size="xs"
                  variant="gh"
                  className="justify-start"
                  onClick={() => void addRow(c.id ? { [field.id]: c.id } : {}).then((r) => r && onOpenRow(r))}
                >
                  <Icon name="plus" size={14} />
                  {t('tables.views.addCard')}
                </Button>
              ) : null}
            </section>
          );
        })}
      </div>
      <MoreButton hasMore={hasMore} loadMore={loadMore} />
    </div>
  );
}

/** Gallery: cards in a grid, the cover field's first image on top. */
export function GalleryView({ view, rows, hasMore, loadMore, onOpenRow, onUpdateView }: CardViewProps) {
  const { t } = useI18n();
  const { table, canEdit } = useTableCtx();
  const attachments = table.fields.filter((f) => f.type === 'attachment');
  return (
    <div className="flex flex-col gap-3">
      {attachments.length ? (
        <ViewFieldSelect
          label={t('tables.views.cover')}
          fields={attachments}
          value={view.config.coverFieldId}
          allowNone
          onChange={(id) => canEdit && onUpdateView({ coverFieldId: id })}
        />
      ) : null}
      {rows.length ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
          {rows.map((r) => (
            <RowCard key={r.id} view={view} row={r} onOpen={() => onOpenRow(r)} />
          ))}
        </div>
      ) : (
        <p className="py-10 text-center text-sm text-fg3">{t('tables.grid.noRows')}</p>
      )}
      <MoreButton hasMore={hasMore} loadMore={loadMore} />
    </div>
  );
}
