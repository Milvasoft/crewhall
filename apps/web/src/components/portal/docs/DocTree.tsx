import { type PortalTreeItem, type PortalVersion } from '@crewhall/shared';
import {
  cn,
  Icon,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  toast,
} from '@crewhall/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { invalidatePortal } from '@/lib/portal/api';
import { usePortalSite } from '@/lib/portal/context';
import { localeTag } from '@/lib/portal/format';
import { ChangeDot } from '@/components/portal/common';
import { ResizablePane } from '@/components/shell/ResizablePane';

interface Move {
  item: PortalTreeItem;
  parentGroupId: string | null;
  position: number;
}

/**
 * 10.2 doc tree of one version and language: version and language pickers, search, status
 * dots, drag-and-drop or menu moves (`position`, `parentGroupId` on the source doc).
 */
export function DocTree({
  items,
  loading,
  versions,
  version,
  locale,
  selected,
  onSelect,
  onVersion,
  onLocale,
  onNew,
  onMoved,
}: {
  items: PortalTreeItem[];
  loading: boolean;
  versions: PortalVersion[];
  version: string;
  locale: string;
  selected: string | undefined;
  onSelect: (groupId: string) => void;
  onVersion: (v: string) => void;
  onLocale: (l: string) => void;
  onNew: (kind: 'doc' | 'category') => void;
  onMoved: (groupId: string) => void;
}) {
  const { t } = useI18n();
  const { site } = usePortalSite();
  const qc = useQueryClient();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const canEdit = site.capabilities.edit;

  const byParent = useMemo(() => {
    const map = new Map<string | null, PortalTreeItem[]>();
    for (const it of items) {
      const list = map.get(it.parentGroupId) ?? [];
      list.push(it);
      map.set(it.parentGroupId, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.position - b.position);
    return map;
  }, [items]);
  const byGroup = useMemo(() => new Map(items.map((i) => [i.groupId, i])), [items]);

  // Ancestors of the selection start open; so does the first level.
  const autoOpen = useMemo(() => {
    const set = new Set<string>();
    for (const it of byParent.get(null) ?? []) if (it.kind === 'category') set.add(it.groupId);
    let cur = selected ? byGroup.get(selected) : undefined;
    while (cur?.parentGroupId) {
      set.add(cur.parentGroupId);
      cur = byGroup.get(cur.parentGroupId);
    }
    return set;
  }, [byParent, byGroup, selected]);

  const needle = query.trim().toLocaleLowerCase();
  const visible = useMemo(() => {
    if (!needle) return null;
    const keep = new Set<string>();
    for (const it of items) {
      if (`${it.title} ${it.slug}`.toLocaleLowerCase().includes(needle)) {
        let cur: PortalTreeItem | undefined = it;
        while (cur) {
          keep.add(cur.groupId);
          cur = cur.parentGroupId ? byGroup.get(cur.parentGroupId) : undefined;
        }
      }
    }
    return keep;
  }, [needle, items, byGroup]);

  const isOpen = (g: string) =>
    visible ? true : open.has(g) || (autoOpen.has(g) && !open.has(`-${g}`));
  const toggle = (g: string) =>
    setOpen((prev) => {
      const n = new Set(prev);
      if (isOpen(g)) {
        n.delete(g);
        n.add(`-${g}`);
      } else {
        n.add(g);
        n.delete(`-${g}`);
      }
      return n;
    });

  const move = useMutation({
    mutationFn: (m: Move) =>
      api.call('updatePortalDoc', {
        params: { docId: m.item.sourceId },
        body: { position: m.position, parentGroupId: m.parentGroupId },
      }),
    onSuccess: (_d, m) => {
      invalidatePortal(qc);
      onMoved(m.item.groupId);
    },
    onError: (e) => toast(t(errorKey(e))),
  });

  const isDescendant = (groupId: string, ancestor: string): boolean => {
    let cur = byGroup.get(groupId);
    while (cur?.parentGroupId) {
      if (cur.parentGroupId === ancestor) return true;
      cur = byGroup.get(cur.parentGroupId);
    }
    return false;
  };

  const siblingsOf = (it: PortalTreeItem) => byParent.get(it.parentGroupId) ?? [];

  const moveBy = (it: PortalTreeItem, dir: -1 | 1) => {
    const list = siblingsOf(it).filter((x) => x.groupId !== it.groupId);
    const idx = siblingsOf(it).findIndex((x) => x.groupId === it.groupId) + dir;
    if (idx < 0 || idx > list.length) return;
    move.mutate({ item: it, parentGroupId: it.parentGroupId, position: between(list, idx) });
  };

  const moveInto = (it: PortalTreeItem, parent: string | null) => {
    const list = (byParent.get(parent) ?? []).filter((x) => x.groupId !== it.groupId);
    move.mutate({ item: it, parentGroupId: parent, position: between(list, list.length) });
  };

  const dropOn = (target: PortalTreeItem) => {
    const it = dragging ? byGroup.get(dragging) : undefined;
    setDragging(null);
    setOver(null);
    if (!it || it.groupId === target.groupId) return;
    if (it.kind === 'category' && isDescendant(target.groupId, it.groupId)) return;
    if (target.kind === 'category' && target.groupId !== it.parentGroupId) {
      moveInto(it, target.groupId);
      return;
    }
    const list = siblingsOf(target).filter((x) => x.groupId !== it.groupId);
    const idx = list.findIndex((x) => x.groupId === target.groupId);
    move.mutate({ item: it, parentGroupId: target.parentGroupId, position: between(list, idx) });
  };

  const categories = items.filter((i) => i.kind === 'category');

  const renderRows = (parent: string | null, depth: number): React.ReactNode =>
    (byParent.get(parent) ?? [])
      .filter((it) => !visible || visible.has(it.groupId))
      .map((it) => {
        const kids = byParent.get(it.groupId)?.length ?? 0;
        const expanded = it.kind === 'category' && isOpen(it.groupId);
        const missing = it.id === null;
        return (
          <li
            key={it.groupId}
            role="treeitem"
            aria-expanded={it.kind === 'category' ? expanded : undefined}
            aria-selected={selected === it.groupId}
          >
            <div
              draggable={canEdit && !needle}
              onDragStart={(e) => {
                setDragging(it.groupId);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', it.groupId);
              }}
              onDragEnd={() => {
                setDragging(null);
                setOver(null);
              }}
              onDragOver={(e) => {
                if (!dragging) return;
                e.preventDefault();
                setOver(it.groupId);
              }}
              onDragLeave={() => setOver((o) => (o === it.groupId ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                dropOn(it);
              }}
              className={cn(
                'group flex h-[30px] items-center gap-1.5 rounded-sm pr-1 text-[13px] text-fg2 hover:bg-bg2 hover:text-fg',
                selected === it.groupId && 'bg-capsule font-semibold text-fg hover:bg-capsule',
                over === it.groupId &&
                  (it.kind === 'category'
                    ? 'shadow-[inset_0_0_0_1.5px_var(--fg)]'
                    : 'shadow-[inset_0_2px_0_0_var(--fg)]'),
                dragging === it.groupId && 'opacity-50',
              )}
              style={{ paddingLeft: 6 + depth * 14 }}
            >
              {it.kind === 'category' ? (
                <button
                  type="button"
                  aria-label={t(expanded ? 'portal.docs.collapse' : 'portal.docs.expand', {
                    name: it.title,
                  })}
                  onClick={() => toggle(it.groupId)}
                  className="flex size-4 shrink-0 items-center justify-center text-fg3"
                >
                  <Icon name={expanded ? 'chevD' : 'chevR'} size={12} />
                </button>
              ) : (
                <span className="size-4 shrink-0" />
              )}
              <button
                type="button"
                onClick={() => onSelect(it.groupId)}
                className={cn(
                  'flex min-w-0 flex-1 items-center gap-1.5 text-left',
                  missing && 'text-fg3 italic',
                  it.status === 'removed' && 'line-through',
                )}
              >
                {it.kind === 'category' ? (
                  <Icon name="folder" size={14} className="shrink-0 text-fg3" />
                ) : null}
                <span className="truncate">{it.sidebarLabel || it.title}</span>
                {it.unlisted ? (
                  <Icon name="eyeOff" size={12} className="shrink-0 text-fg3" />
                ) : null}
              </button>
              {missing ? (
                <span className="shrink-0 text-[10.5px] text-fg3">
                  {t('portal.docs.missingShort', { language: localeTag(locale) })}
                </span>
              ) : it.translation === 'outdated' ? (
                <span
                  role="img"
                  aria-label={t('portal.translate.outdated')}
                  className="size-2 shrink-0 rounded-full bg-warning"
                />
              ) : (
                <ChangeDot status={it.status} />
              )}
              {canEdit ? (
                <Menu>
                  <MenuTrigger asChild>
                    <IconButton
                      aria-label={t('portal.docs.rowMenu', { name: it.title })}
                      size="xs"
                      shape="sq"
                      tone="plain"
                      className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                    >
                      <Icon name="dots" size={14} />
                    </IconButton>
                  </MenuTrigger>
                  <MenuContent align="start">
                    <MenuItem icon="chevU" onSelect={() => moveBy(it, -1)}>
                      {t('portal.docs.moveUp')}
                    </MenuItem>
                    <MenuItem icon="chevD" onSelect={() => moveBy(it, 1)}>
                      {t('portal.docs.moveDown')}
                    </MenuItem>
                    <MenuSub>
                      <MenuSubTrigger icon="folder">{t('portal.docs.moveTo')}</MenuSubTrigger>
                      <MenuSubContent className="max-h-80 overflow-y-auto">
                        <MenuItem
                          disabled={it.parentGroupId === null}
                          onSelect={() => moveInto(it, null)}
                        >
                          {t('portal.docs.root')}
                        </MenuItem>
                        <MenuSeparator />
                        {categories
                          .filter(
                            (c) => c.groupId !== it.groupId && !isDescendant(c.groupId, it.groupId),
                          )
                          .map((c) => (
                            <MenuItem
                              key={c.groupId}
                              disabled={c.groupId === it.parentGroupId}
                              onSelect={() => moveInto(it, c.groupId)}
                            >
                              {c.title}
                            </MenuItem>
                          ))}
                      </MenuSubContent>
                    </MenuSub>
                  </MenuContent>
                </Menu>
              ) : null}
            </div>
            {expanded && kids ? <ul role="group">{renderRows(it.groupId, depth + 1)}</ul> : null}
          </li>
        );
      });

  return (
    <ResizablePane id="portal-doctree" side="left" defaultWidth={272}>
      <aside
        aria-label={t('portal.docs.tree')}
        className="flex w-full min-w-0 flex-col gap-2 overflow-hidden border-r border-line px-2.5 py-3"
      >
        <div className="flex gap-1.5">
          <Select value={version} onValueChange={onVersion}>
            <SelectTrigger
              size="sm"
              className="min-w-0 flex-1"
              aria-label={t('portal.docs.version')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {versions.map((v) => (
                <SelectItem key={v.id} value={v.name}>
                  {`${v.label} · ${t(`portal.versions.status.${v.status}`)}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={locale} onValueChange={onLocale}>
            <SelectTrigger size="sm" className="w-[76px]" aria-label={t('portal.docs.language')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {site.locales.map((l) => (
                <SelectItem key={l} value={l}>
                  {localeTag(l)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex gap-1.5">
          <div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md bg-bg2 px-2.5">
            <Icon name="search" size={15} className="text-fg2" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('portal.docs.search')}
              aria-label={t('portal.docs.search')}
              className="h-full min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg3"
            />
          </div>
          {canEdit && locale === site.defaultLocale ? (
            <Menu>
              <MenuTrigger asChild>
                <IconButton aria-label={t('portal.docs.new')} size="sm" shape="sq">
                  <Icon name="plus" size={16} />
                </IconButton>
              </MenuTrigger>
              <MenuContent align="end">
                <MenuItem icon="page" onSelect={() => onNew('doc')}>
                  {t('portal.docs.newDoc')}
                </MenuItem>
                <MenuItem icon="folder" onSelect={() => onNew('category')}>
                  {t('portal.docs.newCategory')}
                </MenuItem>
              </MenuContent>
            </Menu>
          ) : null}
        </div>
        <div
          className="min-h-0 flex-1 overflow-y-auto"
          onDragOver={(e) => dragging && e.preventDefault()}
        >
          {loading ? (
            <div className="flex flex-col gap-2 p-2">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          ) : !items.length ? (
            <p className="px-2 py-4 text-sm text-fg2">{t('portal.docs.emptyTree')}</p>
          ) : (
            <ul role="tree" aria-label={t('portal.docs.tree')} className="flex flex-col gap-px">
              {renderRows(null, 0)}
            </ul>
          )}
        </div>
      </aside>
    </ResizablePane>
  );
}

/** Position to insert at `index` of an ordered sibling list (fractional between neighbours). */
function between(list: PortalTreeItem[], index: number): number {
  const prev = list[index - 1];
  const next = list[index];
  if (prev && next) return (prev.position + next.position) / 2;
  if (next) return next.position - 10;
  if (prev) return prev.position + 10;
  return 10;
}
