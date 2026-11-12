import {
  closestCenter,
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type KeyboardCoordinateGetter,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  horizontalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { paths, type BoardCard, type BoardColumn, type BoardDetail } from '@crewhall/shared';
import { Button, cn, Icon, IconButton, Textarea } from '@crewhall/ui';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { ActionContextMenu, type ActionEntry } from '@/components/common/ActionMenu';
import { parseQuickCard } from '@/lib/boards/composer';
import { cardRef } from '@/lib/boards/filters';
import { useI18n } from '@/lib/i18n/I18nContext';
import { middleClickOpens } from '@/lib/newTab';
import { CardTile } from './CardTile';
import { type CardMenu } from './cardMenu';
import { ColumnMenuButton, useColumnMenu } from './ColumnMenu';
import { WipCount } from './parts';

export interface MoveIntent {
  cardId: string;
  columnId: string;
  afterId: string | null;
  beforeId: string | null;
}

export interface ColumnMoveIntent {
  columnId: string;
  afterId: string | null;
  beforeId: string | null;
}

export interface NewCardIntent {
  columnId: string;
  title: string;
  labels: string[];
  assigneeIds: string[];
  open: boolean;
}

type Lanes = Record<string, string[]>;

function lanesOf(columns: BoardColumn[], cards: BoardCard[]): Lanes {
  const lanes: Lanes = Object.fromEntries(columns.map((c) => [c.id, [] as string[]]));
  for (const c of cards) lanes[c.columnId]?.push(c.id);
  return lanes;
}

const findLane = (lanes: Lanes, id: string) =>
  id in lanes ? id : Object.keys(lanes).find((k) => lanes[k]!.includes(id));

/** Sortable ids of columns; the lane inside keeps the plain column id as card drop target. */
const COL = 'col:';
const colKey = (id: string) => `${COL}${id}`;
const isColKey = (id: string) => id.startsWith(COL);
const colOf = (key: string) => key.slice(COL.length);

type DragKind = 'card' | 'column';
const kindOf = (data: { current?: Record<string, unknown> } | undefined): DragKind =>
  data?.current?.kind === 'column' ? 'column' : 'card';

/**
 * Columns only collide with columns (nearest centre, so a wide drag feels even);
 * cards with cards and lanes (nearest corners, which handles empty lanes).
 */
const collide: CollisionDetection = (args) => {
  const kind = kindOf(args.active.data);
  const droppableContainers = args.droppableContainers.filter(
    (c) => (kind === 'column') === isColKey(String(c.id)),
  );
  return (kind === 'column' ? closestCenter : closestCorners)({ ...args, droppableContainers });
};

/**
 * Keyboard moves: a picked-up column steps to the neighbouring column's slot (left and
 * right only); cards use the sortable default, which walks cards and lanes.
 */
const keyboardCoordinates: KeyboardCoordinateGetter = (event, args) => {
  const { active, collisionRect, droppableRects, droppableContainers } = args.context;
  if (!active || kindOf(active.data) !== 'column') return sortableKeyboardCoordinates(event, args);
  if (!collisionRect || (event.code !== 'ArrowLeft' && event.code !== 'ArrowRight')) return;
  event.preventDefault();
  const slots = droppableContainers
    .getEnabled()
    .filter((c) => isColKey(String(c.id)))
    .map((c) => droppableRects.get(c.id))
    .filter((r): r is NonNullable<typeof r> => !!r)
    .sort((a, b) => a.left - b.left);
  // The slot under the ghost by centre (the tilted overlay's box is a few px wider).
  const centre = collisionRect.left + collisionRect.width / 2;
  let at = 0;
  slots.forEach((r, i) => {
    const d = Math.abs(r.left + r.width / 2 - centre);
    if (d < Math.abs(slots[at]!.left + slots[at]!.width / 2 - centre)) at = i;
  });
  const target = slots[at + (event.code === 'ArrowRight' ? 1 : -1)];
  return target ? { x: target.left, y: collisionRect.top } : undefined;
};

/** What a column hands its header: pointer drag on the whole header, keys on the grip. */
export interface ColumnHandle {
  enabled: boolean;
  attributes: DraggableAttributes;
  listeners: DraggableSyntheticListeners;
}

/**
 * Kanban (design 6.1, 6.2, 6.4, 6.8). Drag with the pointer or the keyboard; the dragged
 * card tilts, the others make room. Dropping over a WIP limit is allowed and shown as a
 * warning. Filters hide cards but keep their order: a drop is placed between the visible
 * neighbours, which the server resolves among all cards. Managers reorder columns by
 * dragging the header (or the grip with the keyboard); the others slide aside.
 */
export function Kanban({
  detail,
  visible,
  filtered,
  canEdit,
  canManage,
  onOpen,
  onMove,
  onMoveColumn,
  onAdd,
  onAddColumn,
  cardMenu,
}: {
  detail: BoardDetail;
  visible: BoardCard[];
  filtered: boolean;
  canEdit: boolean;
  canManage: boolean;
  onOpen: (card: BoardCard) => void;
  onMove: (m: MoveIntent) => void;
  onMoveColumn: (m: ColumnMoveIntent) => void;
  onAdd: (c: NewCardIntent) => Promise<void>;
  onAddColumn: (name: string) => void;
  /** Right-click menu of a card (none: the browser's own). */
  cardMenu?: CardMenu;
}) {
  const { t } = useI18n();
  const { columns, board } = detail;
  const colById = useMemo(() => new Map(columns.map((c) => [c.id, c])), [columns]);
  // A dragged column's siblings slide by transform; the order changes on drop.
  const [activeCol, setActiveCol] = useState<string | null>(null);
  const byId = useMemo(() => new Map(detail.cards.map((c) => [c.id, c])), [detail.cards]);
  // While dragging, the lanes are local (cards make room); otherwise they follow the data.
  const [dragLanes, setDragLanes] = useState<Lanes | null>(null);
  const serverLanes = useMemo(() => lanesOf(columns, visible), [columns, visible]);
  const lanes = dragLanes ?? serverLanes;
  const setLanes = (fn: (prev: Lanes) => Lanes) => setDragLanes((prev) => fn(prev ?? serverLanes));
  const [activeId, setActiveId] = useState<string | null>(null);
  const [origin, setOrigin] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () =>
      new Set(
        columns
          .filter((c) => c.isDone && detail.cards.filter((x) => x.columnId === c.id).length > 6)
          .map((c) => c.id),
      ),
  );
  const [focusId, setFocusId] = useState<string | null>(null);
  // "Kart ekle" from a lane's right-click menu opens that lane's composer (a new number each time).
  const [compose, setCompose] = useState<{ columnId: string; n: number } | null>(null);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: keyboardCoordinates,
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space'] },
    }),
  );

  const totalIn = (colId: string) => detail.cards.filter((c) => c.columnId === colId).length;

  const onDragStart = (e: DragStartEvent) => {
    if (kindOf(e.active.data) === 'column') {
      setActiveCol(colOf(String(e.active.id)));
      return;
    }
    setActiveId(String(e.active.id));
    setDragLanes(serverLanes);
    setOrigin(findLane(serverLanes, String(e.active.id)) ?? null);
  };

  const onDragOver = (e: DragOverEvent) => {
    if (kindOf(e.active.data) === 'column') return;
    const id = String(e.active.id);
    const overId = e.over ? String(e.over.id) : null;
    if (!overId) return;
    const from = findLane(lanes, id);
    const to = findLane(lanes, overId);
    if (!from || !to || from === to) return;
    setLanes((prev) => {
      const src = prev[from]!.filter((x) => x !== id);
      const dst = [...prev[to]!];
      const i = overId in prev ? dst.length : Math.max(0, dst.indexOf(overId));
      dst.splice(i, 0, id);
      return { ...prev, [from]: src, [to]: dst };
    });
  };

  const onDragEnd = (e: DragEndEvent) => {
    if (kindOf(e.active.data) === 'column') {
      setActiveCol(null);
      const overKey = e.over ? String(e.over.id) : null;
      if (overKey && isColKey(overKey)) moveColumnTo(colOf(String(e.active.id)), colOf(overKey));
      return;
    }
    const id = String(e.active.id);
    const overId = e.over ? String(e.over.id) : null;
    setActiveId(null);
    setDragLanes(null);
    if (!overId) return;
    const lane = findLane(lanes, id);
    if (!lane) return;
    let list = lanes[lane]!;
    if (!(overId in lanes) && overId !== id) {
      const oldIndex = list.indexOf(id);
      const newIndex = list.indexOf(overId);
      if (newIndex >= 0 && oldIndex >= 0) {
        list = [...list];
        list.splice(oldIndex, 1);
        list.splice(newIndex, 0, id);
      }
    }
    const idx = list.indexOf(id);
    const card = byId.get(id);
    const before = list[idx + 1] ?? null;
    const after = list[idx - 1] ?? null;
    const unchanged =
      card &&
      card.columnId === lane &&
      origin === lane &&
      sameNeighbours(visible, card, after, before);
    if (!unchanged) onMove({ cardId: id, columnId: lane, afterId: after, beforeId: before });
  };

  /** Puts the column where `targetId` is now; its new neighbours become the placement. */
  const moveColumnTo = (columnId: string, targetId: string) => {
    const ids = columns.map((c) => c.id);
    const from = ids.indexOf(columnId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0 || from === to) return;
    const next = arrayMove(ids, from, to);
    const i = next.indexOf(columnId);
    onMoveColumn({ columnId, afterId: next[i - 1] ?? null, beforeId: next[i + 1] ?? null });
  };

  /** Ctrl ← → on the column grip moves it one place without picking it up. */
  const onColumnKey = (e: KeyboardEvent, col: BoardColumn) => {
    if (!(e.ctrlKey || e.metaKey) || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    const i = columns.findIndex((c) => c.id === col.id);
    const target = columns[i + (e.key === 'ArrowLeft' ? -1 : 1)];
    if (!target) return;
    e.preventDefault();
    moveColumnTo(col.id, target.id);
    setFocusCol(col.id);
  };

  /** Ctrl ← → changes column, Ctrl ↑ ↓ the order (design 6.2). */
  const onCardKey = (e: KeyboardEvent, card: BoardCard) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onOpen(card);
      return;
    }
    if (!canEdit || !(e.ctrlKey || e.metaKey)) return;
    const lane = findLane(lanes, card.id);
    if (!lane) return;
    const ci = columns.findIndex((c) => c.id === lane);
    const list = lanes[lane]!;
    const i = list.indexOf(card.id);
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const next = columns[ci + (e.key === 'ArrowLeft' ? -1 : 1)];
      if (!next) return;
      e.preventDefault();
      const target = lanes[next.id]!;
      onMove({
        cardId: card.id,
        columnId: next.id,
        afterId: target.at(-1) ?? null,
        beforeId: null,
      });
      setFocusId(card.id);
    } else if (e.key === 'ArrowUp' && i > 0) {
      e.preventDefault();
      onMove({
        cardId: card.id,
        columnId: lane,
        afterId: list[i - 2] ?? null,
        beforeId: list[i - 1]!,
      });
      setFocusId(card.id);
    } else if (e.key === 'ArrowDown' && i < list.length - 1) {
      e.preventDefault();
      onMove({
        cardId: card.id,
        columnId: lane,
        afterId: list[i + 1]!,
        beforeId: list[i + 2] ?? null,
      });
      setFocusId(card.id);
    }
  };

  // Keyboard moves keep the focus on the moved card or column grip.
  useEffect(() => {
    if (!focusId) return;
    document.querySelector<HTMLElement>(`[data-card-id="${focusId}"]`)?.focus();
  }, [focusId, lanes]);
  const [focusCol, setFocusCol] = useState<string | null>(null);
  useEffect(() => {
    if (!focusCol) return;
    document.querySelector<HTMLElement>(`[data-column-grip="${focusCol}"]`)?.focus();
  }, [focusCol, columns]);

  const nameOf = (id: string | number) => {
    const key = String(id);
    if (isColKey(key)) return colById.get(colOf(key))?.name ?? '';
    return byId.get(key)?.title ?? colById.get(key)?.name ?? '';
  };
  /** Screen reader lines in the UI language (dnd-kit's defaults are English). */
  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      kindOf(active.data) === 'column'
        ? t('boards.dnd.pickedColumn', { name: nameOf(active.id) })
        : t('boards.dnd.pickedCard', { name: nameOf(active.id) }),
    onDragOver: ({ active, over }) => {
      if (!over) return undefined;
      if (kindOf(active.data) === 'column') {
        const position = columns.findIndex((c) => c.id === colOf(String(over.id))) + 1;
        return t('boards.dnd.overColumn', { name: nameOf(active.id), position });
      }
      return t('boards.dnd.over', { name: nameOf(over.id) });
    },
    onDragEnd: ({ active }) => t('boards.dnd.dropped', { name: nameOf(active.id) }),
    onDragCancel: ({ active }) => t('boards.dnd.cancelled', { name: nameOf(active.id) }),
  };

  const active = activeId ? byId.get(activeId) : undefined;
  const activeLane = activeId ? findLane(lanes, activeId) : undefined;
  const draggedCol = activeCol ? colById.get(activeCol) : undefined;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collide}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      accessibility={{
        announcements,
        screenReaderInstructions: { draggable: t('boards.dnd.instructions') },
      }}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={() => {
        setActiveId(null);
        setDragLanes(null);
        setActiveCol(null);
      }}
    >
      <SortableContext
        items={columns.map((c) => colKey(c.id))}
        strategy={horizontalListSortingStrategy}
      >
        <div
          className="flex min-h-0 flex-1 items-start gap-3 overflow-x-auto pb-2"
          aria-label={board.name}
        >
          {columns.map((col) => {
            const ids = lanes[col.id] ?? [];
            const isCollapsed = collapsed.has(col.id) && activeLane !== col.id;
            const willExceed =
              activeId !== null &&
              activeLane === col.id &&
              origin !== col.id &&
              col.wipLimit !== null &&
              totalIn(col.id) + 1 > col.wipLimit;
            return (
              <SortableColumn key={col.id} column={col} disabled={!canManage}>
                {(handle, gripRef) =>
                  isCollapsed ? (
                    <CollapsedColumn
                      column={col}
                      count={totalIn(col.id)}
                      handle={handle}
                      onExpand={() =>
                        setCollapsed((s) => {
                          const n = new Set(s);
                          n.delete(col.id);
                          return n;
                        })
                      }
                    />
                  ) : (
                    <Lane
                      column={col}
                      handle={handle}
                      gripRef={gripRef}
                      onGripKey={(e) => onColumnKey(e, col)}
                      ids={ids}
                      total={totalIn(col.id)}
                      filtered={filtered}
                      warn={willExceed}
                      canEdit={canEdit}
                      canManage={canManage}
                      detail={detail}
                      onCollapse={() => setCollapsed((s) => new Set(s).add(col.id))}
                      onNewCard={() =>
                        setCompose((c) => ({ columnId: col.id, n: (c?.n ?? 0) + 1 }))
                      }
                    >
                      {ids.map((id) => {
                        const card = byId.get(id);
                        return card ? (
                          <SortableCard
                            key={id}
                            card={card}
                            detail={detail}
                            done={col.isDone}
                            disabled={!canEdit}
                            onOpen={() => onOpen(card)}
                            onKeyDown={(e) => onCardKey(e, card)}
                            menu={cardMenu}
                          />
                        ) : null;
                      })}
                      {canEdit ? (
                        <Composer
                          column={col}
                          detail={detail}
                          first={detail.cards.length === 0 && col.id === columns[0]?.id}
                          openSignal={compose?.columnId === col.id ? compose.n : 0}
                          onAdd={onAdd}
                        />
                      ) : null}
                    </Lane>
                  )
                }
              </SortableColumn>
            );
          })}
          {canManage ? <AddColumn onAdd={onAddColumn} /> : null}
        </div>
      </SortableContext>
      <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }}>
        {active ? (
          <div className="w-[272px]">
            <CardTile card={active} settings={board.settings} overlay />
          </div>
        ) : draggedCol ? (
          <ColumnGhost
            column={draggedCol}
            total={totalIn(draggedCol.id)}
            cards={(serverLanes[draggedCol.id] ?? [])
              .map((id) => byId.get(id))
              .filter((c): c is BoardCard => !!c)}
            detail={detail}
          />
        ) : null}
      </DragOverlay>
      <span className="sr-only" aria-live="polite">
        {t('boards.card.dragHint')} {canManage ? t('boards.column.dragHint') : ''}
      </span>
    </DndContext>
  );
}

function sameNeighbours(
  visible: BoardCard[],
  card: BoardCard,
  after: string | null,
  before: string | null,
) {
  const lane = visible.filter((c) => c.columnId === card.columnId);
  const i = lane.findIndex((c) => c.id === card.id);
  return (lane[i - 1]?.id ?? null) === after && (lane[i + 1]?.id ?? null) === before;
}

/** A column on the board as a sortable item; renders its lane or collapsed strip. */
function SortableColumn({
  column,
  disabled,
  children,
}: {
  column: BoardColumn;
  disabled: boolean;
  /** The grip ref (focus target for the keyboard sensor) is passed apart from the handle. */
  children: (handle: ColumnHandle, gripRef: (el: HTMLElement | null) => void) => ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: colKey(column.id), data: { kind: 'column' }, disabled });
  return (
    <div
      ref={setNodeRef}
      data-column-id={column.id}
      className={cn(
        'flex max-h-full shrink-0 rounded-2xl',
        isDragging && 'outline-2 -outline-offset-2 outline-accent outline-dashed [&>*]:opacity-30',
      )}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      {children({ enabled: !disabled, attributes, listeners }, setActivatorNodeRef)}
    </div>
  );
}

/** Ghost under the pointer while a column moves: its header and first cards, tilted. */
function ColumnGhost({
  column,
  total,
  cards,
  detail,
}: {
  column: BoardColumn;
  total: number;
  cards: BoardCard[];
  detail: BoardDetail;
}) {
  const { t } = useI18n();
  return (
    <section
      aria-hidden
      className="flex w-[288px] rotate-[1.5deg] cursor-grabbing flex-col rounded-2xl bg-bg2 p-2 shadow-[0_0_0_1px_var(--line2),var(--shadow)]"
    >
      <header className="flex h-9 items-center gap-1.5 px-1.5">
        <Icon name="grip" size={14} className="text-fg3" />
        <h3 className="truncate text-[13.5px] font-bold text-fg">{column.name}</h3>
        <WipCount count={total} limit={column.wipLimit} />
      </header>
      <div className="flex flex-col gap-2 p-0.5">
        {cards.slice(0, 4).map((c) => (
          <CardTile key={c.id} card={c} settings={detail.board.settings} done={column.isDone} />
        ))}
        {cards.length > 4 ? (
          <span className="px-1.5 text-[11.5px] font-semibold text-fg3">
            {t('boards.column.more', { count: cards.length - 4 })}
          </span>
        ) : null}
      </div>
    </section>
  );
}

function Lane({
  column,
  handle,
  gripRef,
  onGripKey,
  ids,
  total,
  filtered,
  warn,
  canEdit,
  canManage,
  detail,
  children,
  onCollapse,
  onNewCard,
}: {
  column: BoardColumn;
  ids: string[];
  total: number;
  filtered: boolean;
  warn: boolean;
  canEdit: boolean;
  canManage: boolean;
  detail: BoardDetail;
  children: React.ReactNode;
  onCollapse: () => void;
  onNewCard: () => void;
  handle: ColumnHandle;
  gripRef: (el: HTMLElement | null) => void;
  onGripKey: (e: KeyboardEvent) => void;
}) {
  const { t } = useI18n();
  const { setNodeRef, isOver } = useDroppable({ id: column.id, disabled: !canEdit });
  const { onPointerDown, onKeyDown } = (handle.listeners ?? {}) as {
    onPointerDown?: (e: React.PointerEvent) => void;
    onKeyDown?: (e: KeyboardEvent) => void;
  };
  const over = column.wipLimit !== null && total > column.wipLimit;
  const columnMenu = useColumnMenu(column, detail);
  // Header: the column's menu. Empty area of the lane: a new card, then the column's menu.
  const headerEntries = canManage ? columnMenu.entries : [];
  const laneEntries: ActionEntry[] = [
    ...(canEdit
      ? [
          {
            kind: 'item',
            key: 'newCard',
            icon: 'plus',
            label: t('boards.toolbar.addCard'),
            onSelect: onNewCard,
          } satisfies ActionEntry,
        ]
      : []),
    ...(canEdit && canManage ? [{ kind: 'sep', key: 'sNew' } satisfies ActionEntry] : []),
    ...headerEntries,
  ];
  const withMenu = (entries: ActionEntry[], el: ReactElement) =>
    entries.length ? <ActionContextMenu entries={entries}>{el}</ActionContextMenu> : el;
  return (
    <section
      aria-label={column.name}
      className={cn(
        'flex max-h-full w-[288px] shrink-0 flex-col rounded-2xl bg-bg2/70 p-2 transition-shadow',
        (warn || over) && 'shadow-[0_0_0_2px_var(--warning)]',
        isOver && !warn && 'shadow-[0_0_0_2px_var(--line2)]',
      )}
    >
      {canManage ? columnMenu.dialog : null}
      {withMenu(
        headerEntries,
        <header
          // The whole header drags the column; buttons inside still click (5 px threshold).
          onPointerDown={handle.enabled ? onPointerDown : undefined}
          className={cn(
            'group/colhead flex h-9 shrink-0 items-center gap-1.5 px-1.5',
            handle.enabled && 'cursor-grab touch-none active:cursor-grabbing',
          )}
        >
          {handle.enabled ? (
            <button
              ref={gripRef}
              type="button"
              data-column-grip={column.id}
              {...handle.attributes}
              aria-label={t('boards.column.dragHandle', { name: column.name })}
              onKeyDown={(e) => {
                onGripKey(e);
                if (!e.defaultPrevented) onKeyDown?.(e);
              }}
              className="-ml-1 flex h-6 w-4 shrink-0 cursor-grab items-center justify-center rounded text-fg3 opacity-50 group-hover/colhead:opacity-100 hover:text-fg focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-accent active:cursor-grabbing"
            >
              <Icon name="grip" size={14} />
            </button>
          ) : null}
          <h3
            className="truncate text-[13.5px] font-bold text-fg"
            onDoubleClick={canManage ? columnMenu.rename : undefined}
          >
            {column.name}
          </h3>
          {column.isDone ? <Icon name="checkC" size={14} className="text-success" /> : null}
          {filtered ? (
            <span className="text-[11.5px] font-bold text-fg3 tn">
              {ids.length} / {total}
            </span>
          ) : (
            <WipCount count={total} limit={column.wipLimit} />
          )}
          <span className="ml-auto flex items-center">
            {column.isDone ? (
              <IconButton size="xs" aria-label={t('boards.column.collapse')} onClick={onCollapse}>
                <Icon name="chevL" size={14} />
              </IconButton>
            ) : null}
            {canManage ? <ColumnMenuButton entries={columnMenu.entries} /> : null}
          </span>
        </header>,
      )}
      {warn && column.wipLimit !== null ? (
        <p className="mx-1.5 mb-1.5 rounded-md bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] px-2 py-1 text-[11.5px] font-semibold text-warning">
          {t('boards.column.wipOver', { limit: column.wipLimit, next: total + 1 })}
        </p>
      ) : null}
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {withMenu(
          laneEntries,
          <div
            ref={setNodeRef}
            data-lane={column.id}
            className="flex min-h-[64px] flex-col gap-2 overflow-y-auto p-0.5"
          >
            {ids.length === 0 ? (
              <div className="flex h-16 items-center justify-center rounded-lg border border-dashed border-line2 px-3 text-center text-xs text-fg3">
                {filtered && total > 0
                  ? t('boards.filters.noMatch')
                  : column.isDone
                    ? t('boards.column.emptyDone')
                    : t('boards.column.empty')}
              </div>
            ) : null}
            {children}
          </div>,
        )}
      </SortableContext>
    </section>
  );
}

function CollapsedColumn({
  column,
  count,
  handle,
  onExpand,
}: {
  column: BoardColumn;
  count: number;
  handle: ColumnHandle;
  onExpand: () => void;
}) {
  const { t } = useI18n();
  const { setNodeRef } = useDroppable({ id: column.id });
  const { onPointerDown } = (handle.listeners ?? {}) as {
    onPointerDown?: (e: React.PointerEvent) => void;
  };
  return (
    <button
      ref={setNodeRef}
      type="button"
      onPointerDown={handle.enabled ? onPointerDown : undefined}
      onClick={onExpand}
      aria-label={`${column.name} · ${t('boards.column.expand')}`}
      className="flex w-11 shrink-0 flex-col items-center gap-2 rounded-2xl bg-bg2/70 py-3 hover:bg-bg2"
    >
      <span className="text-[11.5px] font-bold text-fg3 tn">{count}</span>
      <span className="text-[13px] font-bold text-fg [writing-mode:vertical-rl]">
        {column.name}
      </span>
    </button>
  );
}

function SortableCard({
  card,
  detail,
  done,
  disabled,
  onOpen,
  onKeyDown,
  menu,
}: {
  card: BoardCard;
  detail: BoardDetail;
  done: boolean;
  disabled: boolean;
  onOpen: () => void;
  onKeyDown: (e: KeyboardEvent) => void;
  menu?: CardMenu;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
    data: { kind: 'card' },
    disabled,
  });
  // dnd-kit's mouse sensor ignores the right button, so the menu never starts a drag.
  const tile = (
    <CardTile
      ref={setNodeRef}
      card={card}
      settings={detail.board.settings}
      done={done}
      dragging={isDragging}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      {...middleClickOpens(
        paths.boardCard(detail.board.id, cardRef(detail.board.settings.key, card.number)),
      )}
      onKeyDown={(e) => {
        onKeyDown(e);
        if (!e.defaultPrevented) listeners?.onKeyDown?.(e);
      }}
    />
  );
  return menu ? (
    <ActionContextMenu entries={menu(card, { enter: true })}>{tile}</ActionContextMenu>
  ) : (
    tile
  );
}

/** Inline add (design 6.8): Enter adds and keeps the box, Shift Enter adds and opens, Esc closes. */
function Composer({
  column,
  detail,
  first,
  openSignal,
  onAdd,
}: {
  column: BoardColumn;
  detail: BoardDetail;
  first: boolean;
  /** Changes when the lane's right-click menu asks for a new card. */
  openSignal: number;
  onAdd: (c: NewCardIntent) => Promise<void>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(first);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const [signal, setSignal] = useState(openSignal);
  if (signal !== openSignal) {
    setSignal(openSignal);
    if (openSignal) setOpen(true);
  }
  // The closing menu hands the focus back to where it was; take it after that.
  useEffect(() => {
    if (!openSignal) return;
    const id = window.setTimeout(() => box.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [openSignal]);
  const submit = async (openAfter: boolean) => {
    const parsed = parseQuickCard(text, detail.board.settings.labels, detail.people);
    if (!parsed.title) return;
    setBusy(true);
    try {
      await onAdd({ columnId: column.id, ...parsed, open: openAfter });
      setText('');
      if (openAfter) setOpen(false);
    } finally {
      setBusy(false);
    }
  };
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-9 shrink-0 items-center gap-1.5 rounded-md px-2 text-[13px] font-semibold text-fg2 hover:bg-surface hover:text-fg"
      >
        <Icon name="plus" size={15} />
        {t('boards.toolbar.addCard')}
      </button>
    );
  }
  return (
    <div className="flex shrink-0 flex-col gap-2 rounded-lg bg-surface p-2 shadow-[0_0_0_1px_var(--line2)]">
      <Textarea
        ref={box}
        autoFocus
        rows={2}
        value={text}
        disabled={busy}
        aria-label={t('boards.toolbar.addCard')}
        placeholder={t('boards.composer.placeholder')}
        onChange={(e) => setText(e.target.value)}
        // The browser's own menu (paste) here, not the lane's.
        onContextMenu={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void submit(e.shiftKey);
          } else if (e.key === 'Escape') {
            setOpen(false);
            setText('');
          }
        }}
        className="min-h-0 resize-none border-0 p-1 shadow-none"
      />
      <div className="flex items-center gap-1.5">
        <Button size="xs" variant="inv" loading={busy} onClick={() => void submit(false)}>
          {t('boards.composer.add')}
        </Button>
        <Button size="xs" variant="gh" onClick={() => setOpen(false)}>
          {t('boards.composer.cancel')}
        </Button>
        <span className="ml-auto text-[11px] text-fg3">{t('boards.composer.openHint')}</span>
      </div>
    </div>
  );
}

function AddColumn({ onAdd }: { onAdd: (name: string) => void }) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="flex h-11 w-[220px] shrink-0 items-center gap-1.5 rounded-2xl border border-dashed border-line2 px-3 text-[13px] font-semibold text-fg2 hover:bg-bg2 hover:text-fg"
      >
        <Icon name="plus" size={15} />
        {t('boards.column.add')}
      </button>
    );
  }
  return (
    <form
      className="flex w-[260px] shrink-0 flex-col gap-2 self-start rounded-2xl bg-bg2/70 p-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onAdd(name.trim());
        setName('');
        setEditing(false);
      }}
    >
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}
        placeholder={t('boards.column.namePlaceholder')}
        aria-label={t('boards.column.namePlaceholder')}
        className="h-9 rounded-md bg-surface px-2.5 text-[13.5px] outline-none shadow-[0_0_0_1px_var(--line2)]"
      />
      <div className="flex gap-1.5">
        <Button size="xs" variant="inv" type="submit">
          {t('boards.column.add')}
        </Button>
        <Button size="xs" variant="gh" type="button" onClick={() => setEditing(false)}>
          {t('boards.composer.cancel')}
        </Button>
      </div>
    </form>
  );
}
