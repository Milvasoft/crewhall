import {
  type RowGroup,
  type TableField,
  type TableRow,
  type TableView,
  type ViewConfigInput,
} from '@crewhall/shared';
import {
  cn,
  Icon,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '@crewhall/ui';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import { fieldIcon, viewFields } from '@/lib/tables/fields';
import { CellEditor } from './CellEditor';
import { CellView, ChoiceChip } from './CellView';
import { useTableCtx } from './context';
import { isComputed } from '@crewhall/shared';

const ROW_H = 36;
const NUM_W = 56;
const ADD_W = 44;
const OVERSCAN = 8;

type Entry = { kind: 'group'; group: RowGroup } | { kind: 'row'; index: number };

/**
 * The grid view (virtual scroll): only the rows in sight are rendered, with fixed row height;
 * pages load as the window reaches them. Cells select with a click or the arrow keys, Enter (or a
 * double click) edits, Delete clears. Group headers come from the server's groups.
 */
export function GridView({
  view,
  rows,
  total,
  groups,
  hasMore,
  loadMore,
  onOpenRow,
  onEditField,
  onAddField,
  onUpdateView,
}: {
  view: TableView;
  rows: TableRow[];
  total: number;
  groups: RowGroup[] | null;
  hasMore: boolean;
  loadMore: () => void;
  onOpenRow: (row: TableRow) => void;
  onEditField: (field: TableField) => void;
  onAddField: () => void;
  onUpdateView: (config: ViewConfigInput) => void;
}) {
  const { t } = useI18n();
  const { table, canEdit, updateCell, addRow } = useTableCtx();
  const fields = viewFields(table.fields, view);
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const [sel, setSel] = useState<{ r: number; c: number } | null>(null);
  const [editing, setEditing] = useState<{ r: number; c: number } | null>(null);
  // Widths while a column is being dragged; the saved ones live on the view.
  const [dragging, setDragging] = useState<Record<string, number>>({});

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    const starts = new Map((groups ?? []).map((g) => [g.start, g]));
    for (let i = 0; i < total; i++) {
      const g = starts.get(i);
      if (g) out.push({ kind: 'group', group: g });
      out.push({ kind: 'row', index: i });
    }
    return out;
  }, [total, groups]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight || 600));
    ro.observe(el);
    setHeight(el.clientHeight || 600);
    return () => ro.disconnect();
  }, []);

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(entries.length, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN);
  const visible = entries.slice(first, last);
  const needRow = visible.reduce((m, e) => (e.kind === 'row' ? Math.max(m, e.index) : m), -1);
  useEffect(() => {
    if (hasMore && needRow >= rows.length - 20) loadMore();
  }, [needRow, rows.length, hasMore, loadMore]);

  const width = (f: TableField) => dragging[f.id] ?? view.config.widths[f.id] ?? (f.primary ? 240 : 180);
  const template = `${NUM_W}px ${fields.map((f) => `${width(f)}px`).join(' ')} ${ADD_W}px`;
  const totalWidth = NUM_W + fields.reduce((s, f) => s + width(f), 0) + ADD_W;

  const startResize = (f: TableField, startX: number) => {
    const start = width(f);
    let next = start;
    const move = (e: PointerEvent) => {
      next = Math.min(800, Math.max(80, start + e.clientX - startX));
      setDragging({ [f.id]: next });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (next !== start) onUpdateView({ widths: { ...view.config.widths, [f.id]: Math.round(next) } });
      setDragging({});
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const editable = (f: TableField) => canEdit && !isComputed(f.type);
  const onKey = (e: KeyboardEvent) => {
    if (!sel || editing) return;
    const move = (dr: number, dc: number) => {
      e.preventDefault();
      setSel({ r: Math.max(0, Math.min(rows.length - 1, sel.r + dr)), c: Math.max(0, Math.min(fields.length - 1, sel.c + dc)) });
    };
    if (e.key === 'ArrowDown') move(1, 0);
    else if (e.key === 'ArrowUp') move(-1, 0);
    else if (e.key === 'ArrowRight' || e.key === 'Tab') move(0, e.shiftKey ? -1 : 1);
    else if (e.key === 'ArrowLeft') move(0, -1);
    else if (e.key === 'Enter') {
      const f = fields[sel.c];
      const row = rows[sel.r];
      if (!f || !row) return;
      e.preventDefault();
      if (f.type === 'checkbox' && editable(f)) void updateCell(row, f.id, row.values[f.id] !== true);
      else if (editable(f)) setEditing(sel);
      else onOpenRow(row);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && rows[sel.r] && fields[sel.c]) {
      const f = fields[sel.c]!;
      if (editable(f)) void updateCell(rows[sel.r]!, f.id, f.type === 'checkbox' ? false : null);
    } else if (e.key === 'Escape') setSel(null);
  };

  // Keep the selected cell in view.
  useEffect(() => {
    if (!sel || !scroller.current) return;
    const idx = entries.findIndex((en) => en.kind === 'row' && en.index === sel.r);
    const top = idx * ROW_H;
    const el = scroller.current;
    if (top < el.scrollTop + ROW_H) el.scrollTop = Math.max(0, top - ROW_H);
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top - el.clientHeight + 2 * ROW_H;
  }, [sel, entries]);

  const groupField = view.config.groupBy ? table.fields.find((f) => f.id === view.config.groupBy) : undefined;

  return (
    <div
      ref={scroller}
      role="grid"
      aria-label={view.name}
      aria-rowcount={total + 1}
      tabIndex={0}
      onKeyDown={onKey}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      className="relative min-h-0 flex-1 overflow-auto rounded-xl bg-surface shadow-[0_0_0_1px_var(--line)] outline-none focus-visible:shadow-[0_0_0_2px_var(--fg)]"
    >
      <div style={{ width: totalWidth, minWidth: '100%' }}>
        <div
          role="row"
          className="sticky top-0 z-10 grid border-b border-line bg-bg text-xs font-semibold text-fg2"
          style={{ gridTemplateColumns: template, height: ROW_H }}
        >
          <div role="columnheader" className="flex items-center justify-center text-fg3">
            #
          </div>
          {fields.map((f) => (
            <div key={f.id} role="columnheader" className="group relative flex min-w-0 items-center border-l border-line">
              <Menu>
                <MenuTrigger asChild>
                  <button type="button" className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-2.5 text-left hover:bg-bg2">
                    <Icon name={fieldIcon(f.type)} size={13} className="shrink-0" />
                    <span className="truncate">{f.name}</span>
                  </button>
                </MenuTrigger>
                <MenuContent align="start">
                  {canEdit ? (
                    <MenuItem onSelect={() => onEditField(f)}>
                      <Icon name="edit" size={14} />
                      {t('tables.grid.editField')}
                    </MenuItem>
                  ) : null}
                  <MenuItem onSelect={() => onUpdateView({ sorts: [{ fieldId: f.id, dir: 'asc' }] })}>
                    <Icon name="sort" size={14} />
                    {t('tables.grid.sortAsc')}
                  </MenuItem>
                  <MenuItem onSelect={() => onUpdateView({ sorts: [{ fieldId: f.id, dir: 'desc' }] })}>
                    <Icon name="sort" size={14} />
                    {t('tables.grid.sortDesc')}
                  </MenuItem>
                  <MenuItem onSelect={() => onUpdateView({ groupBy: f.id })}>
                    <Icon name="layers" size={14} />
                    {t('tables.grid.groupBy')}
                  </MenuItem>
                  {!f.primary ? (
                    <>
                      <MenuSeparator />
                      <MenuItem onSelect={() => onUpdateView({ hidden: [...view.config.hidden, f.id] })}>
                        <Icon name="eyeOff" size={14} />
                        {t('tables.grid.hide')}
                      </MenuItem>
                    </>
                  ) : null}
                </MenuContent>
              </Menu>
              {canEdit ? (
                <span
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={t('tables.grid.resize', { name: f.name })}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    startResize(f, e.clientX);
                  }}
                  className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize opacity-0 group-hover:bg-line2 group-hover:opacity-100"
                />
              ) : null}
            </div>
          ))}
          <div className="flex items-center justify-center border-l border-line">
            {canEdit ? (
              <IconButton size="xs" tone="plain" aria-label={t('tables.grid.addField')} onClick={onAddField}>
                <Icon name="plus" size={14} />
              </IconButton>
            ) : null}
          </div>
        </div>
        <div style={{ height: entries.length * ROW_H, position: 'relative' }}>
          {visible.map((en, k) => {
            const top = (first + k) * ROW_H;
            if (en.kind === 'group') {
              const g = en.group;
              const choice = groupField?.options.choices?.find((c) => c.id === g.key);
              return (
                <div
                  key={`g-${g.key}-${g.start}`}
                  className="absolute left-0 flex w-full items-center gap-2 border-b border-line bg-bg2 px-3 text-xs font-semibold"
                  style={{ top, height: ROW_H }}
                >
                  {choice ? (
                    <ChoiceChip label={choice.label} color={choice.color} />
                  ) : groupField && g.key && groupField.type === 'person' ? (
                    <CellView field={groupField} value={[g.key]} compact />
                  ) : (
                    <span>{g.key || t('tables.grid.empty')}</span>
                  )}
                  <span className="text-fg3">{g.count}</span>
                </div>
              );
            }
            const row = rows[en.index];
            return (
              <div
                key={row?.id ?? `p-${en.index}`}
                role="row"
                aria-rowindex={en.index + 2}
                className="absolute left-0 grid border-b border-line hover:bg-bg2/50"
                style={{ top, height: ROW_H, gridTemplateColumns: template, width: totalWidth, minWidth: '100%' }}
              >
                <div className="group/num flex items-center justify-center text-xs text-fg3 tabular-nums">
                  {row ? (
                    <>
                      <span className="group-hover/num:hidden">{en.index + 1}</span>
                      <button
                        type="button"
                        aria-label={t('tables.grid.openRow')}
                        onClick={() => onOpenRow(row)}
                        className="hidden size-6 items-center justify-center rounded-md text-fg hover:bg-capsule group-hover/num:flex"
                      >
                        <Icon name="ext" size={13} />
                      </button>
                    </>
                  ) : null}
                </div>
                {fields.map((f, c) => {
                  const selected = sel?.r === en.index && sel.c === c;
                  const isEditing = editing?.r === en.index && editing.c === c;
                  if (!row) return <div key={f.id} className="m-2 rounded bg-bg2" />;
                  return (
                    <Popover
                      key={f.id}
                      open={isEditing}
                      onOpenChange={(o) => {
                        if (!o) setEditing(null);
                      }}
                    >
                      <PopoverAnchor asChild>
                        <div
                          role="gridcell"
                          aria-selected={selected}
                          onClick={() => {
                            setSel({ r: en.index, c });
                            if (f.type === 'checkbox' && editable(f) && selected) {
                              void updateCell(row, f.id, row.values[f.id] !== true);
                            }
                          }}
                          onDoubleClick={() => {
                            if (f.type === 'checkbox') return;
                            if (editable(f)) setEditing({ r: en.index, c });
                            else onOpenRow(row);
                          }}
                          className={cn(
                            'flex min-w-0 items-center overflow-hidden border-l border-line px-2.5 text-[13.5px]',
                            selected && 'shadow-[inset_0_0_0_2px_var(--fg)]',
                          )}
                        >
                          <CellView field={f} value={row.values[f.id]} compact />
                        </div>
                      </PopoverAnchor>
                      <PopoverContent align="start" className="w-auto min-w-[240px] p-2" onOpenAutoFocus={(e) => e.preventDefault()}>
                        <CellEditor
                          field={f}
                          value={row.values[f.id]}
                          onCommit={(v) => void updateCell(row, f.id, v)}
                          onDone={() => {
                            setEditing(null);
                            scroller.current?.focus();
                          }}
                        />
                      </PopoverContent>
                    </Popover>
                  );
                })}
                <div />
              </div>
            );
          })}
        </div>
        {canEdit ? (
          <button
            type="button"
            onClick={() => void addRow()}
            className="sticky left-0 flex h-9 w-full items-center gap-2 px-4 text-sm font-medium text-fg2 hover:bg-bg2 hover:text-fg"
          >
            <Icon name="plus" size={15} />
            {t('tables.grid.addRow')}
          </button>
        ) : null}
        {total === 0 ? <p className="sticky left-0 px-4 py-6 text-center text-sm text-fg3">{t('tables.grid.noRows')}</p> : null}
      </div>
    </div>
  );
}
