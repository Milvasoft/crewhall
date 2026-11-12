import { type Card } from '@crewhall/shared';
import { Button, cn, Icon, IconButton } from '@crewhall/ui';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragOverEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useState, type ReactNode } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import { type CardConfigOf } from './context';
import { Favicon, HealthDot } from './LinkBits';

type Group = Extract<Card, { type: 'link_group' }>;
type Sections = CardConfigOf<'link_group'>['sections'];

const sid = (id: string) => `s:${id}`;
const iid = (id: string) => `i:${id}`;
const raw = (id: UniqueIdentifier) => String(id).slice(2);
const isSection = (id: UniqueIdentifier) => String(id).startsWith('s:');

function sectionOf(sections: Sections, itemId: string) {
  return sections.find((s) => s.items.some((i) => i.id === itemId));
}

/** Moves a link to `toSection` at `index` (end when out of range); same section reorders. */
export function moveLink(
  sections: Sections,
  itemId: string,
  toSection: string,
  index: number,
): Sections {
  const from = sectionOf(sections, itemId);
  const moving = from?.items.find((i) => i.id === itemId);
  if (!from || !moving || !sections.some((s) => s.id === toSection)) return sections;
  return sections.map((s) => {
    const items = s.items.filter((i) => i.id !== itemId);
    if (s.id !== toSection) return s.id === from.id ? { ...s, items } : s;
    items.splice(index < 0 || index > items.length ? items.length : index, 0, moving);
    return { ...s, items };
  });
}

/** Moves a sub-section to `index`. */
export function moveSection(sections: Sections, sectionId: string, index: number): Sections {
  const from = sections.findIndex((s) => s.id === sectionId);
  if (from < 0) return sections;
  return arrayMove(sections, from, Math.max(0, Math.min(index, sections.length - 1)));
}

/**
 * Sub-sections and their links in the group settings: drag by the handle (mouse, touch after a
 * short press, or keyboard) to reorder links within and across sub-sections and the sub-sections
 * themselves; "Sıralama: Elle" shows exactly this order. A row opens the link for editing.
 */
export function GroupSections({
  card,
  onChange,
  onEdit,
  onAdd,
  onRemoveLink,
  onRenameSection,
  onRemoveSection,
}: {
  card: Group;
  onChange: (sections: Sections) => void;
  onEdit: (sectionId: string, itemId: string) => void;
  onAdd: (sectionId: string) => void;
  onRemoveLink: (sectionId: string, itemId: string) => void;
  onRenameSection: (sectionId: string, title: string) => void;
  onRemoveSection: (sectionId: string) => void;
}) {
  const { t } = useI18n();
  const c = card.config;
  // Working copy while a drag is in flight (cross-section moves show before the drop).
  const [drag, setDrag] = useState<Sections | null>(null);
  const [open, setOpen] = useState<Set<string>>(
    () => new Set(c.sections.slice(0, 1).map((s) => s.id)),
  );
  const sections = drag ?? c.sections;

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const nameOf = (id: UniqueIdentifier) => {
    const key = raw(id);
    if (isSection(id)) {
      return sections.find((s) => s.id === key)?.title || t('quick.settings.untitled');
    }
    return sections.flatMap((s) => s.items).find((i) => i.id === key)?.title ?? '';
  };
  const announcements: Announcements = {
    onDragStart: ({ active }) => t('quick.dnd.picked', { name: nameOf(active.id) }),
    onDragOver: ({ active, over }) =>
      over ? t('quick.dnd.over', { name: nameOf(active.id), target: nameOf(over.id) }) : undefined,
    onDragEnd: ({ active }) => t('quick.dnd.dropped', { name: nameOf(active.id) }),
    onDragCancel: ({ active }) => t('quick.dnd.cancelled', { name: nameOf(active.id) }),
  };

  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (!over || isSection(active.id) || !drag) return;
    const itemId = raw(active.id);
    const from = sectionOf(drag, itemId);
    const to = isSection(over.id)
      ? drag.find((s) => s.id === raw(over.id))
      : sectionOf(drag, raw(over.id));
    if (!from || !to || from.id === to.id) return;
    // Into another sub-section: at the hovered link, or at the end over its header.
    const at = isSection(over.id) ? -1 : to.items.findIndex((i) => i.id === raw(over.id));
    setDrag(moveLink(drag, itemId, to.id, at));
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    let next = drag ?? c.sections;
    if (over && active.id !== over.id) {
      if (isSection(active.id)) {
        const target = isSection(over.id) ? raw(over.id) : sectionOf(next, raw(over.id))?.id;
        const b = next.findIndex((s) => s.id === target);
        if (b >= 0) next = moveSection(next, raw(active.id), b);
      } else if (!isSection(over.id)) {
        const sec = sectionOf(next, raw(active.id));
        if (sec && sec.items.some((i) => i.id === raw(over.id))) {
          next = moveLink(
            next,
            raw(active.id),
            sec.id,
            sec.items.findIndex((i) => i.id === raw(over.id)),
          );
        }
      }
    }
    setDrag(null);
    if (JSON.stringify(next) !== JSON.stringify(c.sections)) onChange(next);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      accessibility={{
        announcements,
        screenReaderInstructions: { draggable: t('quick.dnd.instructions') },
      }}
      onDragStart={() => setDrag(c.sections)}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDrag(null)}
    >
      <SortableContext
        items={sections.map((s) => sid(s.id))}
        strategy={verticalListSortingStrategy}
      >
        {sections.map((s) => (
          <SortableSection
            key={s.id}
            id={s.id}
            title={s.title}
            count={s.items.length}
            open={open.has(s.id)}
            canRemove={sections.length > 1 && s.items.length === 0}
            showRemove={sections.length > 1}
            onToggle={() =>
              setOpen((prev) => {
                const n = new Set(prev);
                if (n.has(s.id)) n.delete(s.id);
                else n.add(s.id);
                return n;
              })
            }
            onRename={(title) => onRenameSection(s.id, title)}
            onRemove={() => onRemoveSection(s.id)}
          >
            <SortableContext
              items={s.items.map((i) => iid(i.id))}
              strategy={verticalListSortingStrategy}
            >
              <ul className="m-0 flex list-none flex-col border-t border-line p-1.5">
                {s.items.map((it) => {
                  const link = card.links[it.linkId];
                  return (
                    <SortableLink
                      key={it.id}
                      id={it.id}
                      sectionId={s.id}
                      title={it.title}
                      icon={
                        <Favicon title={it.title} url={it.iconUrl ?? link?.faviconUrl} size="sm">
                          {link && c.showHealth ? (
                            <HealthDot link={link} title={it.title} always />
                          ) : null}
                        </Favicon>
                      }
                      onEdit={() => onEdit(s.id, it.id)}
                      onRemove={() => onRemoveLink(s.id, it.id)}
                    />
                  );
                })}
                <li>
                  <Button size="xs" variant="gh" onClick={() => onAdd(s.id)}>
                    <Icon name="plus" size={14} />
                    {t('quick.group.addLink')}
                  </Button>
                </li>
              </ul>
            </SortableContext>
          </SortableSection>
        ))}
      </SortableContext>
    </DndContext>
  );
}

function SortableSection({
  id,
  title,
  count,
  open,
  canRemove,
  showRemove,
  onToggle,
  onRename,
  onRemove,
  children,
}: {
  id: string;
  title: string;
  count: number;
  open: boolean;
  canRemove: boolean;
  showRemove: boolean;
  onToggle: () => void;
  onRename: (title: string) => void;
  onRemove: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const {
    setNodeRef,
    attributes,
    listeners,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id: sid(id), data: { type: 'section' } });
  const name = title || t('quick.settings.untitled');
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        'flex flex-col rounded-lg bg-bg shadow-line',
        isDragging && 'relative z-10 shadow-overlay',
        isOver && !isDragging && 'shadow-[inset_0_0_0_1.5px_var(--fg)]',
      )}
    >
      <div className="flex items-center gap-1.5 px-1.5 py-1.5">
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label={t('quick.dnd.moveSection', { name })}
          className="flex size-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm text-fg3 hover:bg-bg2 hover:text-fg"
        >
          <Icon name="grip" size={14} />
        </button>
        <button
          type="button"
          aria-expanded={open}
          aria-label={t('quick.settings.toggleSection', { name })}
          onClick={onToggle}
          className="flex size-6 shrink-0 items-center justify-center text-fg3"
        >
          <Icon name={open ? 'chevD' : 'chevR'} size={14} />
        </button>
        <input
          defaultValue={title}
          maxLength={40}
          aria-label={t('quick.settings.sectionName')}
          placeholder={t('quick.settings.untitled')}
          onBlur={(e) => e.target.value !== title && onRename(e.target.value)}
          className="h-8 min-w-0 flex-1 bg-transparent text-cap font-semibold outline-none placeholder:text-fg3"
        />
        <span className="shrink-0 text-xs text-fg3">{t('quick.group.links', { count })}</span>
        {showRemove ? (
          <IconButton
            size="xs"
            tone="plain"
            aria-label={t('quick.settings.removeSection', { name: title })}
            disabled={!canRemove}
            onClick={onRemove}
          >
            <Icon name="trash" size={13} />
          </IconButton>
        ) : null}
      </div>
      {open ? children : null}
    </div>
  );
}

function SortableLink({
  id,
  sectionId,
  title,
  icon,
  onEdit,
  onRemove,
}: {
  id: string;
  sectionId: string;
  title: string;
  icon: ReactNode;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const {
    setNodeRef,
    attributes,
    listeners,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: iid(id), data: { type: 'item', sectionId } });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        'flex h-10 items-center gap-1.5 rounded-sm bg-bg px-0.5',
        isDragging && 'relative z-10 shadow-overlay',
      )}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={t('quick.dnd.moveLink', { name: title })}
        className="flex size-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm text-fg3 hover:bg-bg2 hover:text-fg"
      >
        <Icon name="grip" size={14} />
      </button>
      {icon}
      <button
        type="button"
        onClick={onEdit}
        className="h-full min-w-0 flex-1 truncate text-left text-cap hover:underline"
      >
        {title}
      </button>
      <IconButton
        size="xs"
        tone="plain"
        aria-label={t('quick.settings.editLink', { name: title })}
        onClick={onEdit}
      >
        <Icon name="edit" size={13} />
      </IconButton>
      <IconButton
        size="xs"
        tone="plain"
        aria-label={t('quick.settings.removeLink', { name: title })}
        onClick={onRemove}
      >
        <Icon name="x" size={13} />
      </IconButton>
    </li>
  );
}
