import {
  DndContext,
  pointerWithin,
  rectIntersection,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
} from '@dnd-kit/core';
import { type BoardCard, type BoardDetail, type Sprint } from '@crewhall/shared';
import { Button, Checkbox, cn, Icon, IconButton, SelectAllCheckbox, toast } from '@crewhall/ui';
import { useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { type BoardActions } from '@/lib/boards/actions';
import { cardRef } from '@/lib/boards/filters';
import { formatDate } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { MultiPicker, type PickOption } from './pickers';
import { AvatarStack, Labels } from './parts';
import { BurndownPanel, CloseSprintDialog, SprintDialog, sprintWeight } from './sprints';

const BACKLOG = 'backlog';

/** Sections are tall: the one under the pointer wins; the keyboard falls back to overlap. */
const collision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length ? hits : rectIntersection(args);
};

interface Section {
  id: string;
  sprint: Sprint | null;
  cards: BoardCard[];
}

/**
 * Backlog view (kararlar 2026-10-29): the running sprint, the planned ones and the backlog,
 * one under the other. Cards are dragged between them (or moved with the row menu, or a
 * selection at once); sprints are made, edited, started and closed here.
 */
export function BacklogView({
  detail,
  visible,
  canEdit,
  canManage,
  actions,
  onOpen,
}: {
  detail: BoardDetail;
  visible: BoardCard[];
  canEdit: boolean;
  canManage: boolean;
  actions: BoardActions;
  onOpen: (card: BoardCard) => void;
}) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState<BoardCard | null>(null);
  const [editing, setEditing] = useState<Sprint | 'new' | null>(null);
  const [closing, setClosing] = useState<Sprint | null>(null);
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor),
  );
  const key = (c: BoardCard) => cardRef(detail.board.settings.key, c.number);
  const sprints = detail.sprints ?? [];
  const active = sprints.find((s) => s.status === 'active');
  const open = sprints.filter((s) => s.status !== 'closed');
  // Done cards stay with their sprint on the board; planning is about what is left.
  const doneCols = new Set(detail.columns.filter((c) => c.isDone).map((c) => c.id));
  const sections: Section[] = [
    ...open.map((s) => ({
      id: s.id,
      sprint: s,
      cards: visible.filter((c) => c.sprintId === s.id),
    })),
    {
      id: BACKLOG,
      sprint: null,
      cards: visible.filter((c) => !c.sprintId && !doneCols.has(c.columnId)),
    },
  ];
  const nameOf = (id: string) =>
    id === BACKLOG ? t('boards.sprints.backlog') : (open.find((s) => s.id === id)?.name ?? '');
  const targets: PickOption[] = sections.map((s) => ({
    id: s.id,
    search: nameOf(s.id),
    node: nameOf(s.id),
  }));

  const plan = (ids: string[], to: string) => {
    const sprintId = to === BACKLOG ? null : to;
    if (ids.length === 1) void actions.planCard(ids[0]!, sprintId);
    else void actions.bulk({ cardIds: ids, sprintId });
    setSelected(new Set());
  };

  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    const card = detail.cards.find((c) => c.id === e.active.id);
    const to = e.over?.id;
    if (!card || typeof to !== 'string' || (card.sprintId ?? BACKLOG) === to) return;
    plan(selected.has(card.id) ? [...selected] : [card.id], to);
  };

  const announcements: Announcements = {
    onDragStart: ({ active: a }) => {
      const c = detail.cards.find((x) => x.id === a.id);
      return c ? t('boards.dnd.pickedCard', { name: key(c) }) : '';
    },
    onDragOver: ({ over }) => (over ? t('boards.dnd.over', { name: nameOf(String(over.id)) }) : ''),
    onDragEnd: ({ active: a, over }) => {
      const c = detail.cards.find((x) => x.id === a.id);
      return c && over
        ? t('boards.sprints.dropped', { key: key(c), target: nameOf(String(over.id)) })
        : '';
    },
    onDragCancel: ({ active: a }) => {
      const c = detail.cards.find((x) => x.id === a.id);
      return c ? t('boards.dnd.cancelled', { name: key(c) }) : '';
    },
  };

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="relative flex min-h-0 flex-1 flex-col gap-3 overflow-auto pb-16">
      {canEdit ? (
        <div className="flex items-center gap-2">
          <p className="text-[13px] text-fg3">{t('boards.sprints.manageHint')}</p>
          <Button size="sm" variant="out" className="ml-auto" onClick={() => setEditing('new')}>
            <Icon name="plus" size={15} />
            {t('boards.sprints.new')}
          </Button>
        </div>
      ) : null}
      <DndContext
        sensors={canEdit ? sensors : []}
        collisionDetection={collision}
        accessibility={{
          announcements,
          screenReaderInstructions: { draggable: t('boards.dnd.instructions') },
        }}
        onDragStart={(e) => setDragging(detail.cards.find((c) => c.id === e.active.id) ?? null)}
        onDragCancel={() => setDragging(null)}
        onDragEnd={onDragEnd}
      >
        {sections.map((sec) => (
          <SectionBox
            key={sec.id}
            section={sec}
            detail={detail}
            folded={folded.has(sec.id)}
            onFold={() =>
              setFolded((f) => {
                const n = new Set(f);
                if (n.has(sec.id)) n.delete(sec.id);
                else n.add(sec.id);
                return n;
              })
            }
            selectAll={
              canEdit && sec.cards.length ? (
                <SelectAllCheckbox
                  state={
                    sec.cards.every((c) => selected.has(c.id))
                      ? 'all'
                      : sec.cards.some((c) => selected.has(c.id))
                        ? 'some'
                        : 'none'
                  }
                  onChange={(all) =>
                    setSelected((s) => {
                      const n = new Set(s);
                      for (const c of sec.cards) {
                        if (all) n.add(c.id);
                        else n.delete(c.id);
                      }
                      return n;
                    })
                  }
                  label={t('boards.sprints.selectAllIn', {
                    name: sec.sprint?.name ?? t('boards.sprints.backlog'),
                  })}
                />
              ) : null
            }
            tools={
              sec.sprint ? (
                <SprintTools
                  sprint={sec.sprint}
                  canEdit={canEdit}
                  canManage={canManage}
                  anotherActive={Boolean(active && active.id !== sec.sprint.id)}
                  onEdit={() => setEditing(sec.sprint)}
                  onClose={() => setClosing(sec.sprint)}
                  actions={actions}
                />
              ) : null
            }
          >
            {sec.cards.map((c) => (
              <Row
                key={c.id}
                card={c}
                cardKey={key(c)}
                detail={detail}
                canEdit={canEdit}
                selected={selected.has(c.id)}
                onToggle={() => toggle(c.id)}
                onOpen={() => onOpen(c)}
                move={
                  <MultiPicker
                    single
                    align="end"
                    trigger={
                      <IconButton
                        size="sm"
                        aria-label={t('boards.sprints.moveCard', { key: key(c) })}
                      >
                        <Icon name="arrowR" size={15} />
                      </IconButton>
                    }
                    options={targets.filter((x) => x.id !== sec.id)}
                    value={[]}
                    onChange={(v) => v[0] && plan([c.id], v[0])}
                  />
                }
              />
            ))}
          </SectionBox>
        ))}
        <DragOverlay dropAnimation={null}>
          {dragging ? (
            <div className="flex h-10 items-center gap-3 rounded-md bg-surface px-3 text-[13.5px] font-semibold shadow-overlay">
              <span className="font-mono text-xs text-fg3">{key(dragging)}</span>
              {dragging.title}
              {selected.has(dragging.id) && selected.size > 1 ? (
                <span className="rounded-full bg-accent px-1.5 text-xs font-bold text-accent-fg">
                  {selected.size}
                </span>
              ) : null}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
      {selected.size ? (
        <div className="sticky bottom-3 mx-auto flex items-center gap-2 rounded-full bg-fg py-1.5 pr-1.5 pl-4 text-bg shadow-overlay">
          <span className="text-[13px] font-semibold">
            {t('boards.sprints.selected', { count: selected.size })}
          </span>
          <MultiPicker
            single
            trigger={
              <Button size="xs" variant="gh" className="text-bg enabled:hover:bg-white/10">
                {t('boards.sprints.moveTo')}
              </Button>
            }
            options={targets}
            value={[]}
            onChange={(v) => v[0] && plan([...selected], v[0])}
          />
          <button
            type="button"
            aria-label={t('boards.list.clearSelection')}
            onClick={() => setSelected(new Set())}
            className="flex size-7 items-center justify-center rounded-full hover:bg-white/10"
          >
            <Icon name="x" size={15} />
          </button>
        </div>
      ) : null}
      {editing ? (
        <SprintDialog
          detail={detail}
          sprint={editing === 'new' ? undefined : editing}
          actions={actions}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {closing ? (
        <CloseSprintDialog
          detail={detail}
          sprint={closing}
          actions={actions}
          onClose={() => setClosing(null)}
        />
      ) : null}
    </div>
  );
}

function SectionBox({
  section,
  detail,
  folded,
  onFold,
  selectAll,
  tools,
  children,
}: {
  section: Section;
  detail: BoardDetail;
  folded: boolean;
  onFold: () => void;
  selectAll: ReactNode;
  tools: ReactNode;
  children: ReactNode;
}) {
  const { t, locale } = useI18n();
  const { setNodeRef, isOver } = useDroppable({ id: section.id });
  const { sprint, cards } = section;
  const unit = detail.board.settings.fields.points ? 'points' : 'cards';
  const sum = cards.reduce((n, c) => n + sprintWeight(detail, c), 0);
  const day = (d: string) => formatDate(d, locale, { day: 'numeric', month: 'short' });
  return (
    <section
      ref={setNodeRef}
      aria-label={sprint?.name ?? t('boards.sprints.backlog')}
      className={cn(
        'flex flex-col rounded-2xl bg-bg2/60 p-2 transition-colors',
        isOver && 'bg-accent10 ring-2 ring-accent',
      )}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1.5">
        {selectAll}
        <button
          type="button"
          onClick={onFold}
          aria-expanded={!folded}
          className="flex items-center gap-1.5 text-[14px] font-bold text-fg"
        >
          <Icon name={folded ? 'chevR' : 'chevD'} size={14} className="text-fg3" />
          {sprint?.name ?? t('boards.sprints.backlog')}
        </button>
        {sprint ? (
          <>
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[11px] font-bold',
                sprint.status === 'active' ? 'bg-accent text-accent-fg' : 'bg-bg text-fg2',
              )}
            >
              {t(`boards.sprints.status.${sprint.status}`)}
            </span>
            <span className="text-xs text-fg2">
              {t('boards.sprint.range', { start: day(sprint.startsOn), end: day(sprint.endsOn) })}
            </span>
          </>
        ) : (
          <span className="text-xs text-fg3">{t('boards.sprints.backlogHint')}</span>
        )}
        <span className="text-xs font-semibold text-fg3 tn">
          {t('boards.sprints.cards', { count: cards.length })}
          {unit === 'points' ? ` · ${t('boards.sprints.units.points', { count: sum })}` : ''}
        </span>
        <span className="ml-auto flex items-center gap-1">{tools}</span>
        {sprint?.goal ? <p className="w-full pl-5 text-[12.5px] text-fg2">{sprint.goal}</p> : null}
      </header>
      {folded ? null : (
        <>
          {sprint?.status === 'active' ? (
            <div className="mx-2 mb-2 max-w-[420px] rounded-lg bg-bg p-3">
              <BurndownPanel sprintId={sprint.id} />
            </div>
          ) : null}
          <ul className="flex flex-col gap-px">{children}</ul>
          {cards.length === 0 ? (
            <p className="px-3 py-4 text-center text-[13px] text-fg3">
              {sprint ? t('boards.sprints.empty') : t('boards.sprints.backlogEmpty')}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

function SprintTools({
  sprint,
  canEdit,
  canManage,
  anotherActive,
  onEdit,
  onClose,
  actions,
}: {
  sprint: Sprint;
  canEdit: boolean;
  canManage: boolean;
  anotherActive: boolean;
  onEdit: () => void;
  onClose: () => void;
  actions: BoardActions;
}) {
  const { t } = useI18n();
  return (
    <>
      {sprint.status === 'planned' && canManage ? (
        <Button
          size="xs"
          variant="out"
          disabled={anotherActive}
          title={anotherActive ? t('errors.board_sprint_active') : undefined}
          onClick={async () => {
            const out = await actions.sprint(() =>
              api.call('startBoardSprint', { params: { sprintId: sprint.id } }),
            );
            if (out) toast(t('boards.sprints.started', { name: sprint.name }));
          }}
        >
          <Icon name="play" size={13} />
          {t('boards.sprints.start')}
        </Button>
      ) : null}
      {sprint.status === 'active' && canManage ? (
        <Button size="xs" variant="out" onClick={onClose}>
          {t('boards.sprints.close')}
        </Button>
      ) : null}
      {canEdit ? (
        <IconButton size="sm" aria-label={t('boards.sprints.edit')} onClick={onEdit}>
          <Icon name="pencil" size={14} />
        </IconButton>
      ) : null}
      {sprint.status === 'planned' && canEdit ? (
        <IconButton
          size="sm"
          aria-label={t('boards.sprints.delete')}
          onClick={() => {
            if (window.confirm(t('boards.sprints.deleteConfirm', { name: sprint.name }))) {
              void actions.sprint(() =>
                api.call('deleteBoardSprint', { params: { sprintId: sprint.id } }),
              );
            }
          }}
        >
          <Icon name="trash" size={14} />
        </IconButton>
      ) : null}
    </>
  );
}

function Row({
  card,
  cardKey,
  detail,
  canEdit,
  selected,
  onToggle,
  onOpen,
  move,
}: {
  card: BoardCard;
  cardKey: string;
  detail: BoardDetail;
  canEdit: boolean;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
  move: ReactNode;
}) {
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: card.id,
    disabled: !canEdit,
  });
  const column = detail.columns.find((c) => c.id === card.columnId);
  return (
    <li
      ref={setNodeRef}
      className={cn(
        'group flex h-11 items-center gap-3 rounded-md bg-bg px-2 hover:bg-surface',
        selected && 'bg-accent10',
        isDragging && 'opacity-40',
      )}
    >
      {canEdit ? (
        <>
          <span
            {...attributes}
            {...listeners}
            aria-label={t('boards.sprints.dragCard', { key: cardKey })}
            className="flex size-6 cursor-grab items-center justify-center rounded-xs text-fg3 hover:bg-bg2 active:cursor-grabbing"
          >
            <Icon name="grip" size={14} />
          </span>
          <Checkbox
            checked={selected}
            onCheckedChange={onToggle}
            aria-label={t('boards.sprints.selectCard', { key: cardKey })}
          />
        </>
      ) : null}
      <span className="w-[76px] shrink-0 font-mono text-[12px] text-fg3">{cardKey}</span>
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          'min-w-0 flex-1 truncate text-left text-[13.5px] font-semibold text-fg hover:underline',
          card.doneAt && 'text-fg3 line-through',
        )}
      >
        {card.title}
      </button>
      {card.blockedBy && !card.doneAt ? (
        <span
          title={t('boards.links.blockedHint', { count: card.blockedBy })}
          className="flex shrink-0 items-center gap-1 text-[11.5px] font-bold text-warning"
        >
          <Icon name="lock" size={12} />
          {t('boards.links.blocked')}
        </span>
      ) : null}
      <Labels ids={card.labels} labels={detail.board.settings.labels} />
      {column ? (
        <span className="hidden shrink-0 rounded-full bg-bg2 px-2 py-0.5 text-[11.5px] font-semibold text-fg2 sm:inline">
          {column.name}
        </span>
      ) : null}
      <AvatarStack people={card.assignees} />
      {detail.board.settings.fields.points ? (
        <span className="w-8 shrink-0 text-right text-xs font-bold text-fg2 tn">
          {card.points ?? '—'}
        </span>
      ) : null}
      {canEdit ? move : null}
    </li>
  );
}
