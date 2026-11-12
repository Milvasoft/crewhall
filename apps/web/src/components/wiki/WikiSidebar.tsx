import { pagePath, type PageTreeItem, type Space } from '@crewhall/shared';
import { cn, Icon, toast } from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { createContext, useContext, useState, type DragEvent, type KeyboardEvent } from 'react';
import { invalidateDrive } from '@/features/drive/api';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { NavItem, SpaceSidebar } from '@/components/spaces/SpaceSidebar';
import { spaceName } from '@/components/spaces/spaceUtils';
import { useI18n } from '@/lib/i18n/I18nContext';
import { pageTreeQuery, treeAncestors, treeChildren, wikiKeys } from '@/lib/wiki/api';
import { openWikiDialog } from './dialogs';
import { useCreatePage } from './useCreatePage';
import { TreeChevron, TreeReveal } from '@/components/common/TreeReveal';
import { ActionContextMenu } from '@/components/common/ActionMenu';
import { usePageTreeMenu, type PageTreeMenu } from './treeMenu';

/** Where a dragged page lands relative to the row under the pointer. */
type DropZone = 'before' | 'after' | 'inside';
type MoveTarget = { parentId: string | null } | { afterId: string } | { beforeId: string };

interface TreeDnd {
  dragId: string | null;
  over: { id: string; zone: DropZone } | null;
  start(id: string): void;
  hover(id: string, zone: DropZone | null): void;
  end(): void;
  /** False when the target is the dragged page itself or one of its descendants. */
  canDrop(targetId: string): boolean;
  move(id: string, target: MoveTarget): void;
}

const TreeDndContext = createContext<TreeDnd | null>(null);
const TreeMenuContext = createContext<PageTreeMenu | null>(null);

/** F2 renames and Del trashes the focused page, as its right-click menu says. */
function rowKeys(menu: PageTreeMenu | null, item: PageTreeItem, e: KeyboardEvent<HTMLElement>) {
  if (!menu || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false;
  if (e.key === 'F2') menu.rename(item);
  else if (e.key === 'Delete') menu.trash(item);
  else return false;
  e.preventDefault();
  return true;
}

/** Top and bottom quarters of a row drop next to it; the middle drops inside it. */
function zoneAt(e: DragEvent<HTMLElement>): DropZone {
  const r = e.currentTarget.getBoundingClientRect();
  const y = e.clientY - r.top;
  if (r.height <= 0) return 'inside';
  if (y < r.height / 4) return 'before';
  if (y > (r.height * 3) / 4) return 'after';
  return 'inside';
}

/**
 * Sidebar of the pages module (design 5.1): search, recent and favorite pages (Drive's lists),
 * the space's page tree, templates, trash.
 */
export function WikiSidebar({ space, activeId }: { space: Space | undefined; activeId?: string }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const tree = useQuery({ ...pageTreeQuery(space?.id ?? ''), enabled: Boolean(space) });
  const items = tree.data?.items ?? [];
  const children = treeChildren(items);
  // Pages a move put something into stay open, so the moved page remains visible.
  const [revealed, setRevealed] = useState<string[]>([]);
  const open = new Set([
    ...(activeId ? [...treeAncestors(items, activeId), activeId] : []),
    ...revealed,
  ]);
  const create = useCreatePage();
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<TreeDnd['over']>(null);
  const menu = usePageTreeMenu({
    space,
    items,
    activeId,
    canCreate: Boolean(tree.data?.canCreate),
  });

  const dnd: TreeDnd = {
    dragId,
    over,
    start: (id) => setDragId(id),
    hover: (id, zone) =>
      setOver((cur) => {
        if (zone === null) return cur?.id === id ? null : cur;
        return cur?.id === id && cur.zone === zone ? cur : { id, zone };
      }),
    end: () => {
      setDragId(null);
      setOver(null);
    },
    canDrop: (targetId) =>
      dragId !== null && targetId !== dragId && !treeAncestors(items, targetId).includes(dragId),
    move: (id, target) => {
      if (!space) return;
      const into = 'parentId' in target ? target.parentId : null;
      if (into) setRevealed((cur) => (cur.includes(into) ? cur : [...cur, into]));
      void (async () => {
        try {
          await api.call('movePage', { params: { nodeId: id }, body: target });
          await qc.invalidateQueries({ queryKey: wikiKeys.tree(space.id) });
          void qc.invalidateQueries({ queryKey: wikiKeys.page(id) });
          invalidateDrive(qc);
          // Keyboard moves keep the focus on the moved page.
          requestAnimationFrame(() =>
            document.querySelector<HTMLElement>(`[data-tree-page="${id}"] a`)?.focus(),
          );
        } catch (e) {
          toast(t(errorKey(e)));
        }
      })();
    },
  };

  return (
    <TreeDndContext.Provider value={dnd}>
      <TreeMenuContext.Provider value={menu}>
        <SpaceSidebar
          space={space}
          onSelect={(s) =>
            void navigate({ to: '/pages/$spaceSlug', params: { spaceSlug: s.slug } })
          }
        >
          <ActionContextMenu entries={menu.emptyEntries}>
            <div
              data-page-tree=""
              className="mt-2 flex min-h-0 flex-1 flex-col gap-px overflow-y-auto"
            >
              <NavItem icon="search" to="/pages/search" label={t('wiki.nav.search')} />
              <NavItem icon="clock" to="/pages/recent" label={t('wiki.nav.recent')} />
              <NavItem icon="star" to="/pages/favorites" label={t('wiki.nav.favorites')} />
              <span className="eyebrow mt-3 mb-1 flex items-center px-2.5">
                {space ? spaceName(space, t) : t('wiki.nav.pages')}
              </span>
              {tree.isPending ? (
                <span className="px-2.5 py-1 text-cap text-fg3">{t('wiki.nav.loading')}</span>
              ) : items.length === 0 ? (
                <span className="px-2.5 py-1 text-cap text-fg3">{t('wiki.nav.empty')}</span>
              ) : (
                (children.get(null) ?? []).map((item) => (
                  <TreeNode
                    key={item.id}
                    spaceId={space?.id ?? ''}
                    item={item}
                    depth={0}
                    childrenOf={children}
                    openIds={open}
                    activeId={activeId}
                  />
                ))
              )}
              {space && tree.data?.canCreate ? (
                <button
                  type="button"
                  onClick={() => void create(space.id, null)}
                  className="flex h-[var(--nv-h)] shrink-0 items-center gap-2.5 rounded-sm px-2.5 text-[13.5px] font-medium text-fg2 hover:bg-bg2 hover:text-fg"
                >
                  <Icon name="plus" size={16} />
                  {t('wiki.nav.newPage')}
                </button>
              ) : null}
              {space ? (
                <button
                  type="button"
                  onClick={() =>
                    openWikiDialog({ kind: 'templates', spaceId: space.id, parentId: null })
                  }
                  className="flex h-[var(--nv-h)] shrink-0 items-center gap-2.5 rounded-sm px-2.5 text-[13.5px] font-medium text-fg2 hover:bg-bg2 hover:text-fg"
                >
                  <Icon name="layers" size={16} />
                  {t('wiki.nav.templates')}
                </button>
              ) : null}
              {space ? (
                <NavItem
                  icon="trash"
                  to="/drive/$spaceSlug/trash"
                  params={{ spaceSlug: space.slug }}
                  label={t('wiki.nav.trash')}
                />
              ) : null}
            </div>
          </ActionContextMenu>
        </SpaceSidebar>
      </TreeMenuContext.Provider>
    </TreeDndContext.Provider>
  );
}

function PageLink({
  item,
  depth,
  active,
  movable,
  onRename,
}: {
  item: PageTreeItem;
  depth: number;
  active: boolean;
  movable?: boolean;
  /** Double-clicking the title renames the page. */
  onRename?: () => void;
}) {
  return (
    <Link
      aria-keyshortcuts={
        movable ? 'Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight F2 Delete' : undefined
      }
      to="/p/$pageRef"
      params={{ pageRef: pagePath(item).slice(3) }}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex h-[var(--nv-h)] shrink-0 items-center gap-2 rounded-sm pr-2.5 text-[13.5px] leading-[18px] font-medium text-fg2 hover:bg-bg2 hover:text-fg',
        active && 'bg-capsule font-semibold text-fg',
      )}
      style={{ paddingLeft: 10 + depth * 14 }}
    >
      {item.icon ? (
        <span className="w-4 shrink-0 text-center text-[14px] leading-none">{item.icon}</span>
      ) : (
        <Icon name="page" size={16} className="shrink-0" />
      )}
      <span
        className="min-w-0 flex-1 truncate"
        onDoubleClick={
          onRename
            ? (e) => {
                e.preventDefault();
                onRename();
              }
            : undefined
        }
      >
        {item.name}
      </span>
    </Link>
  );
}

function TreeNode({
  spaceId,
  item,
  depth,
  childrenOf,
  openIds,
  activeId,
}: {
  spaceId: string;
  item: PageTreeItem;
  depth: number;
  childrenOf: Map<string | null, PageTreeItem[]>;
  openIds: Set<string>;
  activeId?: string;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const isOpen = expanded ?? openIds.has(item.id);
  const kids = childrenOf.get(item.id) ?? [];
  const create = useCreatePage();
  const dnd = useContext(TreeDndContext);
  const menu = useContext(TreeMenuContext);
  const movable = item.myRole !== 'viewer';
  const siblings = childrenOf.get(item.parentId) ?? [];
  const index = siblings.findIndex((x) => x.id === item.id);
  const over = dnd?.over?.id === item.id ? dnd.over.zone : null;

  // Alt + arrows: up / down among siblings, right into the previous sibling, left out of the parent.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (rowKeys(menu, item, e)) return;
    if (!dnd || !movable || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const prev = siblings[index - 1];
    const next = siblings[index + 1];
    let target: MoveTarget | null = null;
    if (e.key === 'ArrowUp' && prev) target = { beforeId: prev.id };
    else if (e.key === 'ArrowDown' && next) target = { afterId: next.id };
    else if (e.key === 'ArrowRight' && prev) target = { parentId: prev.id };
    else if (e.key === 'ArrowLeft' && item.parentId) target = { afterId: item.parentId };
    if (!target) return;
    e.preventDefault();
    dnd.move(item.id, target);
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!dnd?.dragId || !dnd.canDrop(item.id)) return;
    const zone = zoneAt(e);
    // A page the person may only read gets no children.
    if (zone === 'inside' && !movable) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    dnd.hover(item.id, zone);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!dnd?.dragId || !dnd.canDrop(item.id)) return;
    e.preventDefault();
    const zone = zoneAt(e);
    const id = dnd.dragId;
    dnd.end();
    if (zone === 'inside') {
      if (!movable) return;
      setExpanded(true);
      dnd.move(id, { parentId: item.id });
    } else dnd.move(id, zone === 'before' ? { beforeId: item.id } : { afterId: item.id });
  };

  const addChild = () => {
    setExpanded(true);
    void create(spaceId, item.id);
  };

  return (
    <>
      <ActionContextMenu entries={menu?.pageEntries(item, () => setExpanded(true)) ?? []}>
        <div
          className={cn(
            'group relative flex items-center rounded-sm',
            over === 'inside' && 'bg-bg2 shadow-[inset_0_0_0_1.5px_var(--accent)]',
            dnd?.dragId === item.id && 'opacity-50',
          )}
          data-tree-page={item.id}
          data-drop={over ?? undefined}
          draggable={movable}
          onDragStart={(e) => {
            if (!movable || !dnd) return;
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('application/x-crewhall-page', item.id);
            dnd.start(item.id);
          }}
          onDragEnd={() => dnd?.end()}
          onDragOver={onDragOver}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              dnd?.hover(item.id, null);
            }
          }}
          onDrop={onDrop}
          onKeyDown={onKeyDown}
        >
          {over === 'before' || over === 'after' ? (
            <span
              aria-hidden="true"
              className={cn(
                'pointer-events-none absolute right-1 h-0.5 rounded-full bg-accent',
                over === 'before' ? '-top-px' : '-bottom-px',
              )}
              style={{ left: 8 + depth * 14 }}
            />
          ) : null}
          {item.hasChildren ? (
            <button
              type="button"
              aria-label={t(isOpen ? 'wiki.nav.collapse' : 'wiki.nav.expand', { name: item.name })}
              aria-expanded={isOpen}
              onClick={() => setExpanded(!isOpen)}
              className="absolute z-10 flex size-4 items-center justify-center text-fg3"
              style={{ left: depth * 14 - 4 }}
            >
              <TreeChevron open={isOpen} />
            </button>
          ) : null}
          <div className="min-w-0 flex-1">
            <PageLink
              item={item}
              depth={depth}
              active={item.id === activeId}
              movable={movable}
              onRename={menu?.canEdit(item) ? () => menu.rename(item) : undefined}
            />
          </div>
          {item.myRole !== 'viewer' ? (
            <button
              type="button"
              aria-label={t('wiki.nav.addChild', { name: item.name })}
              onClick={addChild}
              className="absolute right-1 hidden size-6 items-center justify-center rounded-sm text-fg3 group-hover:flex hover:bg-capsule hover:text-fg"
            >
              <Icon name="plus" size={14} />
            </button>
          ) : null}
        </div>
      </ActionContextMenu>
      <TreeReveal open={isOpen}>
        {kids.map((k) => (
          <TreeNode
            key={k.id}
            spaceId={spaceId}
            item={k}
            depth={depth + 1}
            childrenOf={childrenOf}
            openIds={openIds}
            activeId={activeId}
          />
        ))}
      </TreeReveal>
    </>
  );
}
