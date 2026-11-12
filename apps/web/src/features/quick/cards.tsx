import { type Card, type DriveNode, type SpaceColor } from '@crewhall/shared';
import {
  Button,
  Checkbox,
  cn,
  Icon,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Segmented,
  Tag,
} from '@crewhall/ui';
import { useNavigate } from '@tanstack/react-router';
import { RichEditor, type RichEditorHandle } from '@crewhall/editor/react';
import '@crewhall/editor/styles.css';
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { editorLabels } from '@/components/portal/PortalEditor';
import { AssignedList } from '@/components/boards/AssignedList';
import { ColorPicker } from '@/components/spaces/ColorPicker';
import { spaceName } from '@/components/spaces/spaceUtils';
import { badgeOf, nodeIcon } from '@/features/drive/fileKinds';
import { nodeLocation } from '@/features/drive/paths';
import { rawPreviewUrl } from '@/features/drive/urls';
import { formatBytes, formatRelative, formatTime } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { newId } from '@/lib/ids';
import { useSpaces } from '@/lib/useSpaces';
import { CardFrame, CardHeader, DOT_BG, NO_DRAG } from './cardFrame';
import { ChatCard, MeetingCard, PageCard, VaultItemCard } from './moduleCards';
import { useQuick, type CardConfigOf } from './context';
import { Favicon, HealthDot, openLink } from './LinkBits';
import { noteFromDoc, noteToDoc } from './noteDoc';

const ALL_COLORS: SpaceColor[] = ['s1', 's2', 's3', 's4', 's5', 's6'];

type Of<T extends Card['type']> = Extract<Card, { type: T }>;

export function CardView({ card }: { card: Card }) {
  switch (card.type) {
    case 'link':
      return <LinkCard card={card} />;
    case 'link_group':
      return <LinkGroupCard card={card} />;
    case 'note':
      return <NoteCard card={card} />;
    case 'todo':
      return <TodoCard card={card} />;
    case 'node':
      return <NodeCard card={card} />;
    case 'board_assigned':
      return <BoardAssignedCard card={card} />;
    case 'page':
      return <PageCard card={card} />;
    case 'chat':
      return <ChatCard card={card} />;
    case 'meeting':
      return <MeetingCard card={card} />;
    case 'vault_item':
      return <VaultItemCard card={card} />;
  }
}

/** "Bana atananlar" (design 6.9): open board cards assigned to me, from the boards module. */
function BoardAssignedCard({ card }: { card: Of<'board_assigned'> }) {
  const { t } = useI18n();
  const { scope, spaceId, limit } = card.config;
  const title = scope === 'due' ? t('boards.assigned.dueTitle') : t('boards.assigned.card');
  return (
    <CardFrame card={card} label={title}>
      <div className="flex items-center gap-2">
        <Icon name="board" size={16} className="text-fg2" />
        <span className="truncate text-cap font-semibold">{title}</span>
      </div>
      <div className={cn('-mx-1.5 min-h-0 flex-1 overflow-y-auto', NO_DRAG)}>
        <AssignedList compact scope={scope} spaceId={spaceId ?? undefined} limit={limit} />
      </div>
    </CardFrame>
  );
}

// ---- link (2.1 tiles) ----

function LinkCard({ card }: { card: Of<'link'> }) {
  const { editing } = useQuick();
  const item = card.config.item;
  const link = card.links[item.linkId];
  return (
    <CardFrame card={card} label={item.title} className="justify-center px-3.5 py-3">
      <a
        href={link?.url}
        target="_blank"
        rel="noopener noreferrer"
        draggable={false}
        onClick={(e) => {
          e.preventDefault();
          if (!editing && link) openLink(link);
        }}
        className="flex min-w-0 items-center gap-3 rounded-md outline-offset-4"
      >
        <Favicon title={item.title} url={item.iconUrl ?? link?.faviconUrl}>
          {link ? <HealthDot link={link} title={item.title} /> : null}
        </Favicon>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[13.5px] leading-[18px] font-semibold">{item.title}</span>
          <span className="truncate text-xs text-fg3">{item.description ?? link?.host}</span>
        </span>
      </a>
    </CardFrame>
  );
}

// ---- link group (2.1, 2.5) ----

/** "Boyut" of a link group: row height, icon and text size (undefined = normal). */
const DENSITY = {
  compact: {
    row: 'h-8',
    icon: 'xs',
    text: 'text-xs',
    gridCols: 'grid-cols-5',
    gridIcon: 'md',
    gridText: 'text-[11px]',
  },
  normal: {
    row: 'h-10',
    icon: 'sm',
    text: 'text-cap',
    gridCols: 'grid-cols-4',
    gridIcon: 'grid',
    gridText: 'text-xs',
  },
  large: {
    row: 'h-12',
    icon: 'md',
    text: 'text-sm',
    gridCols: 'grid-cols-3',
    gridIcon: 'lg',
    gridText: 'text-cap',
  },
} as const;

function LinkGroupCard({ card }: { card: Of<'link_group'> }) {
  const { t, locale } = useI18n();
  const q = useQuick();
  const c = card.config;
  const [tab, setTab] = useState(c.sections[0]?.id ?? '');
  const tabs = c.sectionsAsTabs && c.sections.length > 1;
  const current = c.sections.find((x) => x.id === tab) ?? c.sections[0];
  const shown = tabs && current ? [current] : c.sections;
  const total = c.sections.reduce((a, x) => a + x.items.length, 0);
  const size = DENSITY[c.density ?? 'normal'];

  const sorted = (items: (typeof c.sections)[number]['items']) => {
    if (c.sort === 'name') {
      return [...items].sort((a, b) => a.title.localeCompare(b.title, locale));
    }
    if (c.sort === 'popular') {
      return [...items].sort(
        (a, b) => (card.links[b.linkId]?.opens30d ?? 0) - (card.links[a.linkId]?.opens30d ?? 0),
      );
    }
    return items;
  };

  return (
    <CardFrame card={card} label={c.title}>
      <CardHeader
        dot={c.color}
        title={c.title}
        aside={
          tabs ? (
            <span
              className={cn(
                'flex min-w-0 max-w-[65%] shrink overflow-x-auto rounded-sm bg-bg2 p-0.5 [scrollbar-width:none]',
                NO_DRAG,
              )}
              role="tablist"
            >
              {c.sections.map((sec) => (
                <button
                  key={sec.id}
                  type="button"
                  role="tab"
                  aria-selected={current?.id === sec.id}
                  onClick={() => setTab(sec.id)}
                  className={cn(
                    'h-[22px] shrink-0 rounded-[6px] px-2 text-[11.5px] font-semibold whitespace-nowrap text-fg2',
                    current?.id === sec.id && 'bg-surface text-fg shadow-sm dark:bg-capsule',
                  )}
                >
                  {sec.title || t('quick.settings.untitled')}
                </button>
              ))}
            </span>
          ) : (
            <Tag className="shrink-0">{t('quick.group.count', { count: total })}</Tag>
          )
        }
      />
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        {shown.map((sec) => (
          <Fragment key={sec.id}>
            {!tabs && sec.title ? <span className="eyebrow">{sec.title}</span> : null}
            {c.view === 'grid' ? (
              <div className={cn('grid gap-2', size.gridCols)}>
                {sorted(sec.items).map((it) => {
                  const link = card.links[it.linkId];
                  return (
                    <LinkAnchor key={it.id} url={link?.url} onOpen={() => link && openLink(link)}>
                      <span
                        className={cn(
                          'flex min-w-0 flex-col items-center gap-1.5 text-center font-medium text-fg2',
                          size.gridText,
                        )}
                      >
                        <Favicon
                          title={it.title}
                          url={it.iconUrl ?? link?.faviconUrl}
                          size={size.gridIcon}
                        >
                          {link && c.showHealth ? (
                            <HealthDot
                              link={link}
                              title={it.title}
                              context={sec.title || c.title}
                              always
                            />
                          ) : null}
                        </Favicon>
                        <span className="w-full truncate">{it.title}</span>
                      </span>
                    </LinkAnchor>
                  );
                })}
              </div>
            ) : (
              <div className="flex flex-col">
                {sorted(sec.items).map((it, i) => {
                  const link = card.links[it.linkId];
                  return (
                    <LinkAnchor
                      key={it.id}
                      url={link?.url}
                      onOpen={() => link && openLink(link)}
                      className={cn(
                        'flex min-w-0 items-center gap-2.5 rounded-[9px] px-1.5 hover:bg-bg2',
                        size.row,
                        i > 0 && 'shadow-[0_-1px_0_var(--line)]',
                      )}
                    >
                      <Favicon
                        title={it.title}
                        url={it.iconUrl ?? link?.faviconUrl}
                        size={size.icon}
                      >
                        {link && c.showHealth ? (
                          <HealthDot
                            link={link}
                            title={it.title}
                            context={sec.title || c.title}
                            always
                          />
                        ) : null}
                      </Favicon>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className={cn('truncate font-semibold', size.text)}>{it.title}</span>
                        {c.showUrls && link ? (
                          <span className="truncate text-[11px] leading-[14px] text-fg3">
                            {link.url.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                          </span>
                        ) : null}
                      </span>
                    </LinkAnchor>
                  );
                })}
              </div>
            )}
          </Fragment>
        ))}
        {q.editing && q.canEdit && !card.pinnedFrom ? (
          <Button
            size="xs"
            variant="gh"
            className={cn('self-start', NO_DRAG)}
            onClick={() =>
              q.addLink({ groupCardId: card.id, sectionId: tabs ? current?.id : undefined })
            }
          >
            <Icon name="plus" size={14} />
            {t('quick.group.addLink')}
          </Button>
        ) : null}
      </div>
    </CardFrame>
  );
}

function LinkAnchor({
  url,
  onOpen,
  className,
  children,
}: {
  url: string | undefined;
  onOpen: () => void;
  className?: string;
  children: ReactNode;
}) {
  const { editing } = useQuick();
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      draggable={false}
      onClick={(e) => {
        e.preventDefault();
        if (!editing) onOpen();
      }}
      className={cn('min-w-0', className)}
    >
      {children}
    </a>
  );
}

// ---- note (2.6) ----

function noteStyle(color: SpaceColor): CSSProperties {
  return {
    background: `color-mix(in srgb, var(--${color}) 16%, var(--surface))`,
    boxShadow: 'none',
  };
}

function NoteCard({ card }: { card: Of<'note'> }) {
  const { t, locale } = useI18n();
  const q = useQuick();
  const c = card.config;
  const [writing, setWriting] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draft = useRef(c.text);
  // Normalizing a loaded note is not an edit: only typing, pasting or dropping saves.
  const touched = useRef(false);
  const editorRef = useRef<RichEditorHandle>(null);
  // Writable in edit mode too: a note just added from "Kart ekle" lands there, and its text
  // area is outside the drag handle (NO_DRAG).
  const editable = q.canEdit && !card.pinnedFrom;
  const title = noteTitle(c.text) ?? t('quick.note.title');
  const fg = { color: `color-mix(in srgb, var(--${c.color}) 55%, var(--fg))` };
  const labels = useMemo(() => editorLabels(t), [t]);

  // Follow server changes (another device, mobile) while not typing: remount with the new text.
  // After an own save the text is what the editor already shows.
  const [loaded, setLoaded] = useState(c.text);
  if (!writing && c.text !== loaded) setLoaded(c.text);
  const value = useMemo(() => noteToDoc(loaded), [loaded]);

  const save = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const text = draft.current;
    if (text === c.text) return;
    q.updateConfig(card, (prev) => ({ ...prev, text }));
    setSavedAt(new Date());
  };
  const touch = () => {
    touched.current = true;
  };

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return (
    <CardFrame
      card={card}
      label={title}
      style={noteStyle(c.color)}
      className={cn(writing && 'shadow-[inset_0_0_0_1.5px_var(--line2)]')}
    >
      <CardHeader
        icon="sticky"
        title={t('quick.note.title')}
        style={fg}
        aside={
          editable ? (
            <Popover>
              <PopoverTrigger asChild>
                <IconButton
                  size="xs"
                  tone="plain"
                  aria-label={t('quick.note.style')}
                  className={NO_DRAG}
                >
                  <span className={cn('size-3.5 rounded-full', DOT_BG[c.color])} />
                </IconButton>
              </PopoverTrigger>
              <PopoverContent align="end" className="flex w-[240px] flex-col gap-3 p-3.5">
                <span className="eyebrow">{t('quick.note.color')}</span>
                <ColorPicker
                  value={c.color}
                  colors={ALL_COLORS}
                  onChange={(color) => q.updateConfig(card, (prev) => ({ ...prev, color }))}
                />
                <span className="eyebrow">{t('quick.note.fontSize')}</span>
                <Segmented
                  value={c.fontSize}
                  onValueChange={(fontSize) =>
                    q.updateConfig(card, (prev) => ({ ...prev, fontSize }))
                  }
                  options={[
                    { value: 'normal', label: t('quick.note.normal') },
                    { value: 'large', label: t('quick.note.large') },
                  ]}
                />
              </PopoverContent>
            </Popover>
          ) : null
        }
      />
      <div
        role="group"
        aria-label={t('quick.note.text')}
        className={cn(
          'qc-note -ml-[14px] min-h-0 flex-1 overflow-y-auto text-fg',
          c.fontSize === 'large'
            ? 'text-[15px] leading-[22px] font-medium'
            : 'text-[13.5px] leading-[20px]',
          editable && 'cursor-text select-text',
          NO_DRAG,
        )}
        onFocus={() => setWriting(true)}
        onBlur={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          save();
          setWriting(false);
        }}
        onKeyDown={(e) => {
          touch();
          if (e.key === 'Escape') (document.activeElement as HTMLElement | null)?.blur();
        }}
        onPaste={touch}
        onDrop={touch}
        onMouseDown={touch}
      >
        <RichEditor
          key={loaded}
          variant="light"
          value={value}
          editable={editable}
          labels={labels}
          placeholder={t('quick.note.placeholder')}
          editorRef={editorRef}
          onChange={(doc) => {
            if (!touched.current) return;
            draft.current = noteFromDoc(doc);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(save, 800);
          }}
        />
      </div>
      {savedAt ? (
        <span className="shrink-0 text-[11px] leading-[14px]" style={fg}>
          {t('quick.note.saved', { time: formatTime(savedAt, locale) })}
        </span>
      ) : card.sourceMissing ? (
        <SourceMissing card={card} />
      ) : null}
    </CardFrame>
  );
}

function noteTitle(text: string): string | null {
  const first = text.split('\n')[0] ?? '';
  return /^#{1,3}\s+/.test(first) ? first.replace(/^#{1,3}\s+/, '') : null;
}

// ---- todo ----

function TodoCard({ card }: { card: Of<'todo'> }) {
  const { t } = useI18n();
  const q = useQuick();
  const c = card.config;
  const [text, setText] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const editable = q.canEdit && !card.pinnedFrom && !q.editing;
  const done = c.items.filter((x) => x.done).length;
  type Items = CardConfigOf<'todo'>['items'];
  const set = (fn: (items: Items) => Items) =>
    q.updateConfig(card, (prev) => ({ ...prev, items: fn(prev.items) }));

  return (
    <CardFrame card={card} label={c.title}>
      <CardHeader
        icon="todo"
        title={c.title}
        aside={
          <span className="shrink-0 text-xs font-medium text-fg3">
            {t('quick.todo.progress', { done, total: c.items.length })}
          </span>
        }
      />
      <ul className="m-0 flex min-h-0 flex-1 list-none flex-col gap-1 overflow-y-auto p-0">
        {c.items.map((it) => (
          <li key={it.id} className="group/todo flex min-h-7 items-center gap-2.5">
            <Checkbox
              checked={it.done}
              disabled={!editable}
              aria-label={it.text}
              className={NO_DRAG}
              onCheckedChange={(v) =>
                set((items) =>
                  items.map((x) =>
                    x.id === it.id
                      ? {
                          ...x,
                          done: v === true,
                          doneAt: v === true ? new Date().toISOString() : null,
                        }
                      : x,
                  ),
                )
              }
            />
            {editable && editingId === it.id ? (
              <TodoEdit
                value={it.text}
                label={t('quick.todo.itemText')}
                onDone={(next) => {
                  setEditingId(null);
                  if (next === null || next === it.text) return;
                  set((items) =>
                    next
                      ? items.map((x) => (x.id === it.id ? { ...x, text: next } : x))
                      : items.filter((x) => x.id !== it.id),
                  );
                }}
              />
            ) : editable ? (
              <button
                type="button"
                aria-label={t('quick.todo.editItem', { text: it.text })}
                onClick={() => setEditingId(it.id)}
                className={cn(
                  'min-w-0 flex-1 cursor-text truncate rounded-sm text-left text-cap font-medium outline-none focus-visible:shadow-[0_0_0_2px_var(--fg)]',
                  it.done && 'text-fg3 line-through',
                  NO_DRAG,
                )}
              >
                {it.text}
              </button>
            ) : (
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-cap font-medium',
                  it.done && 'text-fg3 line-through',
                )}
              >
                {it.text}
              </span>
            )}
            {editable && editingId !== it.id ? (
              <IconButton
                size="xs"
                tone="plain"
                aria-label={t('quick.todo.removeItem', { text: it.text })}
                className={cn('opacity-0 group-hover/todo:opacity-100 focus:opacity-100', NO_DRAG)}
                onClick={() => set((items) => items.filter((x) => x.id !== it.id))}
              >
                <Icon name="x" size={13} />
              </IconButton>
            ) : null}
          </li>
        ))}
      </ul>
      {editable ? (
        <form
          className={cn('flex shrink-0 items-center gap-2', NO_DRAG)}
          onSubmit={(e) => {
            e.preventDefault();
            const v = text.trim();
            if (!v) return;
            set((items) => [...items, { id: newId(), text: v, done: false, doneAt: null }]);
            setText('');
          }}
        >
          <Icon name="plus" size={15} className="text-fg3" />
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('quick.todo.add')}
            aria-label={t('quick.todo.add')}
            className="h-7 min-w-0 flex-1 bg-transparent text-cap outline-none placeholder:text-fg3"
          />
        </form>
      ) : null}
    </CardFrame>
  );
}

/**
 * In-place edit of a to-do item (H3): Enter or leaving the field saves, Escape cancels.
 * `onDone` gets the trimmed text ("" = delete the item) or null when cancelled.
 */
function TodoEdit({
  value,
  label,
  onDone,
}: {
  value: string;
  label: string;
  onDone: (next: string | null) => void;
}) {
  const [draft, setDraft] = useState(value);
  const finished = useRef(false);
  const finish = (next: string | null) => {
    if (finished.current) return;
    finished.current = true;
    onDone(next);
  };
  return (
    <input
      // Opened by the person's own click, so taking focus is expected.
      autoFocus
      value={draft}
      aria-label={label}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(draft.trim());
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          finish(null);
        }
      }}
      onBlur={() => finish(draft.trim())}
      className={cn(
        'h-7 min-w-0 flex-1 rounded-sm bg-bg2 px-1.5 text-cap font-medium outline-none',
        NO_DRAG,
      )}
    />
  );
}

// ---- Drive node (file, folder, page) ----

function NodeCard({ card }: { card: Of<'node'> }) {
  const { t, locale } = useI18n();
  const q = useQuick();
  const navigate = useNavigate();
  const { items: spaces } = useSpaces();
  const node = card.node;

  if (!node) {
    return (
      <CardFrame
        card={card}
        label={t('quick.node.locked')}
        className="items-center justify-center text-center"
      >
        <Icon name="lock" size={20} className="text-fg3" />
        <span className="text-cap font-semibold">{t('quick.node.locked')}</span>
        <span className="text-xs text-fg3">{t('quick.node.lockedHint')}</span>
        {q.canEdit ? (
          <Button size="xs" variant="gh" className={NO_DRAG} onClick={() => q.remove(card)}>
            {t('quick.node.removeCard')}
          </Button>
        ) : null}
      </CardFrame>
    );
  }

  const space = spaces.find((s) => s.id === node.spaceId);
  const open = (n: DriveNode) => {
    if (q.editing) return;
    const slug = spaces.find((s) => s.id === n.spaceId)?.slug;
    if (slug) void navigate(nodeLocation(n, slug));
  };
  const spaceLabel = space ? spaceName(space, t) : '';

  if (node.type === 'file' && card.layout.h === 1) {
    return (
      <CardFrame card={card} label={node.name} className="justify-center px-3.5 py-3">
        <button
          type="button"
          onClick={() => open(node)}
          className="flex min-w-0 items-center gap-3 text-left"
        >
          <FileBadge node={node} />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[13.5px] leading-[18px] font-semibold">{node.name}</span>
            <span className="truncate text-xs text-fg3">
              {formatBytes(node.sizeBytes, locale)} · {spaceLabel}
            </span>
          </span>
        </button>
      </CardFrame>
    );
  }

  if (node.type === 'file') {
    return (
      <CardFrame card={card} label={node.name} className="p-0">
        <button
          type="button"
          onClick={() => open(node)}
          className="flex min-h-0 flex-1 flex-col text-left"
        >
          <span className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-bg2">
            {node.preview === 'ready' ? (
              <img
                src={rawPreviewUrl(node.id, 'thumb_256', node.version ?? undefined)}
                alt=""
                className="size-full object-cover"
              />
            ) : (
              <Icon name={nodeIcon(node)} size={28} className="text-fg3" />
            )}
          </span>
          <span className="flex shrink-0 flex-col px-3.5 py-2.5">
            <span className="truncate text-cap font-semibold">{node.name}</span>
            <span className="truncate text-xs text-fg3">
              {formatBytes(node.sizeBytes, locale)} · {spaceLabel}
            </span>
          </span>
        </button>
      </CardFrame>
    );
  }

  if (node.type === 'folder') {
    return (
      <CardFrame card={card} label={node.name}>
        <CardHeader
          icon="folder"
          title={node.name}
          aside={<span className="shrink-0 text-xs font-medium text-fg3">{spaceLabel}</span>}
        />
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {card.children.length === 0 ? (
            <span className="text-xs text-fg3">{t('quick.node.emptyFolder')}</span>
          ) : (
            card.children.map((ch) => (
              <button
                key={ch.id}
                type="button"
                onClick={() => open(ch)}
                className="flex h-9 min-w-0 shrink-0 items-center gap-2.5 rounded-[9px] px-1.5 text-left hover:bg-bg2"
              >
                <FileBadge node={ch} small />
                <span className="min-w-0 flex-1 truncate text-cap font-medium">{ch.name}</span>
                {ch.type === 'file' ? (
                  <span className="shrink-0 text-[11px] text-fg3 tn">
                    {formatBytes(ch.sizeBytes, locale)}
                  </span>
                ) : null}
              </button>
            ))
          )}
        </div>
        <Button
          size="xs"
          variant="gh"
          className={cn('self-start', NO_DRAG)}
          onClick={() => open(node)}
        >
          {t('quick.node.openFolder')}
        </Button>
      </CardFrame>
    );
  }

  // Pages, boards and drawings arrive with their modules; the card shows where they live.
  return (
    <CardFrame card={card} label={node.name}>
      <CardHeader
        icon={nodeIcon(node)}
        title={node.name}
        aside={<span className="shrink-0 text-xs font-medium text-fg3">{spaceLabel}</span>}
      />
      <button
        type="button"
        onClick={() => open(node)}
        className="flex min-h-0 flex-1 flex-col items-start gap-1 text-left"
      >
        <span className="text-cap text-fg2">{t(`drive.types.${node.type}`)}</span>
        <span className="text-xs text-fg3">
          {t('quick.node.updated', {
            name: node.updatedBy?.name.split(' ')[0] ?? '',
            when: formatRelative(node.updatedAt, locale),
          })}
        </span>
      </button>
    </CardFrame>
  );
}

/** Extension badge ("PDF", "ZIP") or the type icon. */
export function FileBadge({
  node,
  small,
}: {
  node: Pick<DriveNode, 'type' | 'name' | 'mime'>;
  small?: boolean;
}) {
  const badge = node.type === 'file' ? badgeOf(node.name) : '';
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex shrink-0 items-center justify-center rounded-[7px] bg-bg2 font-bold text-fg2',
        small ? 'h-6 min-w-6 px-1 text-[9px]' : 'h-9 min-w-9 px-1.5 text-[10.5px]',
      )}
    >
      {badge || <Icon name={nodeIcon(node)} size={small ? 14 : 18} />}
    </span>
  );
}

function SourceMissing({ card }: { card: Card }) {
  const { t } = useI18n();
  const q = useQuick();
  return (
    <span className="flex shrink-0 items-center gap-2 text-[11px] text-fg2">
      {t('quick.pin.sourceMissing')}
      {q.canEdit ? (
        <Button size="xs" variant="gh" className={NO_DRAG} onClick={() => q.detach(card)}>
          {t('quick.menu.detach')}
        </Button>
      ) : null}
    </span>
  );
}
