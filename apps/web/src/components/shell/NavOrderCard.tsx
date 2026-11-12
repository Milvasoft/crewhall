import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button, cn, Icon, IconButton, Kbd, toast } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { SettingsCard } from '@/components/admin/Settings';
import { useI18n } from '@/lib/i18n/I18nContext';
import { moveId, uiPrefsQuery } from '@/lib/shell/navOrder';
import { comboLabel, recordCombo, shortcutOf } from '@/lib/shell/shortcuts';
import { useRailPrefs } from '@/lib/shell/useRailPrefs';
import { useRailEntries, type RailEntry } from './Rail';
import { RailIcon } from './RailIcon';

/** Phone: home plus this many entries are bottom tabs (MobileTabBar), the rest sit under "Diğer". */
const PHONE_TABS = 3;

/**
 * Hesabım › Görünüm › "Sol menü": drag (or the arrows) to order the left menu, the eye to hide an
 * entry, the key button to give it a shortcut. It saves at once and follows the person to the
 * desktop app and other browsers; the phone app keeps its own bar. Home stays first and shown.
 */
export function NavOrderCard() {
  const { t } = useI18n();
  const { modules, extra } = useRailEntries({ includeHidden: true });
  const { data: prefs } = useQuery(uiPrefsQuery);
  const entries = modules.filter((m) => m.id !== 'home');
  const home = modules.find((m) => m.id === 'home');
  const ids = entries.map((e) => e.id);
  const hidden = new Set(prefs?.railHidden ?? []);
  const shortcuts = prefs?.railShortcuts;
  const save = useRailPrefs();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const labelOf = (id: string | number) => entries.find((e) => e.id === String(id))?.label ?? '';
  const announcements: Announcements = {
    onDragStart: ({ active }) => t('forms.dnd.picked', { label: labelOf(active.id) }),
    onDragOver: ({ active, over }) =>
      over
        ? t('forms.dnd.over', { label: labelOf(active.id), target: labelOf(over.id) })
        : undefined,
    onDragEnd: ({ active }) => t('forms.dnd.dropped', { label: labelOf(active.id) }),
    onDragCancel: () => t('forms.dnd.cancelled'),
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from >= 0 && to >= 0) save.mutate({ railOrder: arrayMove(ids, from, to) });
  };
  const toggleHidden = (id: string) =>
    save.mutate({
      railHidden: hidden.has(id) ? [...hidden].filter((x) => x !== id) : [...hidden, id],
    });
  /** Who else answers to this combination, by name. */
  const takenBy = (id: string, combo: string) =>
    [...modules, ...extra].find((e) => e.id !== id && shortcutOf(e.id, shortcuts) === combo)?.label;
  const setShortcut = (id: string, combo: string) =>
    save.mutate({ railShortcuts: { ...shortcuts, [id]: combo } });
  const rowProps = (e: RailEntry) => ({
    entry: e,
    hidden: hidden.has(e.id),
    combo: shortcutOf(e.id, shortcuts),
    takenBy: (combo: string) => takenBy(e.id, combo),
    onHide: () => toggleHidden(e.id),
    onShortcut: (combo: string) => setShortcut(e.id, combo),
  });

  return (
    <SettingsCard title={t('account.appearance.menuOrder')}>
      <p className="m-0 pb-3 text-sm text-fg2">{t('account.appearance.menuOrderHint')}</p>
      {home ? (
        <ul className="m-0 mb-1.5 flex list-none flex-col gap-1.5 p-0">
          <FixedRow {...rowProps(home)} canHide={false} />
        </ul>
      ) : null}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        accessibility={{
          announcements,
          screenReaderInstructions: { draggable: t('forms.dnd.instructions') },
        }}
        onDragEnd={onDragEnd}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <ol aria-label={t('account.appearance.menuOrder')} className="flex flex-col gap-1.5">
            {entries.map((e, i) => (
              <NavRow
                key={e.id}
                {...rowProps(e)}
                index={i}
                count={entries.length}
                onMove={(by) => save.mutate({ railOrder: moveId(ids, e.id, by) })}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
      {extra.length ? (
        <ul className="m-0 mt-1.5 flex list-none flex-col gap-1.5 p-0">
          {extra.map((e) => (
            <FixedRow key={e.id} {...rowProps(e)} canHide />
          ))}
        </ul>
      ) : null}
      <div className="flex justify-end pt-3 pb-1">
        <Button
          size="sm"
          variant="gh"
          onClick={() => save.mutate({ railOrder: [], railHidden: [], railShortcuts: {} })}
        >
          <Icon name="undo" size={14} />
          {t('account.appearance.menuOrderReset')}
        </Button>
      </div>
    </SettingsCard>
  );
}

interface RowProps {
  entry: RailEntry;
  hidden: boolean;
  combo: string;
  takenBy: (combo: string) => string | undefined;
  onHide: () => void;
  onShortcut: (combo: string) => void;
}

function RowTools({
  entry,
  hidden,
  combo,
  takenBy,
  onHide,
  onShortcut,
  canHide = true,
}: RowProps & { canHide?: boolean }) {
  const { t } = useI18n();
  return (
    <>
      <ShortcutButton label={entry.label} combo={combo} takenBy={takenBy} onChange={onShortcut} />
      {canHide ? (
        <IconButton
          size="sm"
          tone="plain"
          aria-pressed={hidden}
          aria-label={t(hidden ? 'account.appearance.menuShow' : 'account.appearance.menuHide', {
            label: entry.label,
          })}
          onClick={onHide}
        >
          <Icon name={hidden ? 'eyeOff' : 'eye'} size={15} />
        </IconButton>
      ) : (
        <span className="size-8 shrink-0" />
      )}
    </>
  );
}

/** Press the keys: a letter means "G then that letter", Alt Shift plus a key stays as pressed. */
function ShortcutButton({
  label,
  combo,
  takenBy,
  onChange,
}: {
  label: string;
  combo: string;
  takenBy: (combo: string) => string | undefined;
  onChange: (combo: string) => void;
}) {
  const { t } = useI18n();
  const [recording, setRecording] = useState(false);
  const onKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return;
    if (e.key === 'Escape') {
      setRecording(false);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Backspace' || e.key === 'Delete') {
      onChange('');
      setRecording(false);
      return;
    }
    const got = recordCombo(e);
    if ('waiting' in got) return;
    if ('reserved' in got) {
      toast(t('account.appearance.menuKeyReserved'));
      return;
    }
    const other = takenBy(got.combo);
    if (other) {
      toast(t('account.appearance.menuKeyTaken', { name: other }));
      return;
    }
    onChange(got.combo);
    setRecording(false);
  };
  const keys = comboLabel(combo);
  return (
    <button
      type="button"
      aria-label={t('account.appearance.menuKey', { label })}
      aria-pressed={recording}
      onClick={() => setRecording((r) => !r)}
      onBlur={() => setRecording(false)}
      onKeyDown={onKeyDown}
      className={cn(
        'flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-fg2 hover:bg-surface pointer-coarse:hidden',
        recording && 'bg-surface text-fg shadow-line2',
      )}
    >
      {recording ? (
        t('account.appearance.menuKeyPress')
      ) : keys.length ? (
        keys.map((k) => <Kbd key={k}>{k}</Kbd>)
      ) : (
        <Icon name="key" size={14} />
      )}
    </button>
  );
}

/** Home, portal and admin: their place in the rail is fixed. */
function FixedRow({ canHide, ...row }: RowProps & { canHide: boolean }) {
  return (
    <li
      className={cn(
        'flex items-center gap-2 rounded-xl bg-bg2 py-1 pr-1 pl-1',
        row.hidden && 'opacity-60',
      )}
    >
      <span className="size-8 shrink-0" />
      <RailIcon entry={row.entry} size={17} className="shrink-0 text-fg2" />
      <span className="min-w-0 flex-1 truncate text-sm font-semibold">{row.entry.label}</span>
      <RowTools {...row} canHide={canHide} />
      {/* Lines up with the arrows of the rows that can move. */}
      <span className="w-[68px] shrink-0" />
    </li>
  );
}

function NavRow({
  index,
  count,
  onMove,
  ...row
}: RowProps & {
  index: number;
  count: number;
  onMove: (by: -1 | 1) => void;
}) {
  const { t } = useI18n();
  const { entry } = row;
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: entry.id,
  });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'flex items-center gap-2 rounded-xl bg-bg2 py-1 pr-1 pl-1',
        isDragging && 'relative z-10 opacity-80 shadow-overlay',
        row.hidden && 'opacity-60',
      )}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={t('account.appearance.menuDrag', { label: entry.label })}
        className="flex size-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-fg3 hover:bg-surface hover:text-fg"
      >
        <Icon name="grip" size={16} />
      </button>
      <RailIcon entry={entry} size={17} className="shrink-0 text-fg2" />
      <span className="min-w-0 flex-1 truncate text-sm font-semibold">{entry.label}</span>
      {index < PHONE_TABS ? (
        <span className="hidden text-xs text-fg3 sm:inline">
          {t('account.appearance.menuPhoneTab')}
        </span>
      ) : null}
      <RowTools {...row} />
      <IconButton
        size="sm"
        tone="plain"
        aria-label={t('account.appearance.menuUp', { label: entry.label })}
        disabled={index === 0}
        onClick={() => onMove(-1)}
      >
        <Icon name="chevU" size={15} />
      </IconButton>
      <IconButton
        size="sm"
        tone="plain"
        aria-label={t('account.appearance.menuDown', { label: entry.label })}
        disabled={index === count - 1}
        onClick={() => onMove(1)}
      >
        <Icon name="chevD" size={15} />
      </IconButton>
    </li>
  );
}
