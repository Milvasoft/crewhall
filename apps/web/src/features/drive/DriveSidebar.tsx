import {
  CONTAINER_NODE_TYPES,
  pagePath,
  type DriveNode,
  type Space,
  type SpaceRole,
} from '@crewhall/shared';
import { cn, Icon } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { NavItem, SpaceSidebar } from '@/components/spaces/SpaceSidebar';
import { spaceName } from '@/components/spaces/spaceUtils';
import { useI18n } from '@/lib/i18n/I18nContext';
import { ActionContextMenu, type ActionEntry } from '@/components/common/ActionMenu';
import { useNodeTypeEnabled } from '@/lib/identity/modules';
import { usePermissions } from '@/lib/session';
import { openDriveDialog, useNodeActions } from './actions';
import { nodeQuery, nodesQuery, quotaQuery, trashQuery } from './api';
import { canMoveInto, draggedNodes, endNodeDrag, isFileDrag, isNodeDrag } from './dnd';
import { nodeIcon } from './fileKinds';
import { useNodeMenu } from './nodeMenu';
import { folderLocation, nodeLocation } from './paths';
import { addUploads } from './uploads';
import { TreeChevron, TreeReveal } from '@/components/common/TreeReveal';

const containers = CONTAINER_NODE_TYPES as readonly string[];

/**
 * Drive sidebar (3.4): personal lists, the space's tree (folders and pages open; files, boards
 * and drawings are its leaves), trash and the org quota. Tree folders take file drops
 * from the desktop and Drive rows dragged from the list (move).
 */
export function DriveSidebar({
  space,
  activeFolderId,
}: {
  space: Space;
  activeFolderId?: string | null;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const quota = useQuery({ ...quotaQuery, retry: false });
  const trash = useQuery({ ...trashQuery(space.id), retry: false });
  const active = useQuery({ ...nodeQuery(activeFolderId ?? ''), enabled: Boolean(activeFolderId) });
  // Folders opened on the way stay open: the new folder's path loads after the click, and
  // without this its ancestors would fold up for that moment and open again.
  const open = openedIn(space.id);
  for (const p of active.data?.path ?? []) open.add(p.id);
  if (activeFolderId) open.add(activeFolderId);
  const actions = useNodeActions();
  const move: MoveInto = (nodes, parentId, name) =>
    actions.moveTo(nodes, { spaceId: space.id, parentId, name });
  // Trashing the open folder (or one above it) from the tree leaves its page: go to the parent
  // of the highest trashed one.
  const openPath = [...(active.data?.path.map((p) => p.id) ?? []), activeFolderId];
  const menu = useNodeMenu({
    ...actions,
    trash: (nodes) => {
      actions.trash(nodes);
      const top = openPath
        .map((pid) => nodes.find((n) => n.id === pid))
        .find((n): n is DriveNode => Boolean(n));
      if (top) void navigate(folderLocation(space.slug, top.parentId));
    },
  });
  // Another Drive screen (recent, trash, the root) mounts its own sidebar: it opens where the
  // last one was scrolled to instead of jumping to the top.
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const top = scrolled.get(space.id);
    if (scroller.current && top) scroller.current.scrollTop = top;
  }, [space.id]);

  return (
    <SpaceSidebar
      space={space}
      onSelect={(s) => void navigate({ to: '/drive/$spaceSlug', params: { spaceSlug: s.slug } })}
      storage={
        quota.data
          ? {
              usedBytes: quota.data.usedBytes,
              quotaBytes: quota.data.quotaBytes,
              warning: quota.data.warning,
            }
          : undefined
      }
    >
      <div
        ref={scroller}
        onScroll={(e) => scrolled.set(space.id, e.currentTarget.scrollTop)}
        className="mt-2 flex min-h-0 flex-1 flex-col gap-px overflow-y-auto"
      >
        <NavItem icon="clock" to="/drive/recent" label={t('drive.nav.recent')} />
        <Link
          to="/drive/recent"
          hash="favoriler"
          className="flex h-[var(--nv-h)] shrink-0 items-center gap-2.5 rounded-sm px-2.5 text-[13.5px] leading-[18px] font-medium text-fg2 hover:bg-bg2 hover:text-fg"
        >
          <Icon name="star" size={16} />
          {t('drive.nav.favorites')}
        </Link>
        <span className="eyebrow mt-3 mb-1 px-2.5">{spaceName(space, t)}</span>
        <TreeRow
          space={space}
          id={null}
          name={t('drive.nav.all')}
          icon="layers"
          depth={0}
          active={activeFolderId === null}
          openIds={open}
          activeId={activeFolderId ?? null}
          role={space.myRole}
          dropName={spaceName(space, t)}
          ancestorIds={[]}
          onMove={move}
          onRename={actions.rename}
          menu={menu}
        />
        <NavItem
          icon="trash"
          to="/drive/$spaceSlug/trash"
          params={{ spaceSlug: space.slug }}
          label={t('drive.nav.trash')}
          count={trash.data?.items.length || undefined}
        />
      </div>
    </SpaceSidebar>
  );
}

/** Tree folders opened by visiting them, per space; kept across Drive screens (they remount the sidebar). */
const opened = new Map<string, Set<string>>();
/** Scroll position of the tree, per space; kept across Drive screens like `opened`. */
const scrolled = new Map<string, number>();

function openedIn(spaceId: string): Set<string> {
  let ids = opened.get(spaceId);
  if (!ids) opened.set(spaceId, (ids = new Set()));
  return ids;
}

/**
 * Opens a node like a list row does: a file in the viewer, a page, board or drawing on its own
 * screen (a page with sub-pages too: its chevron shows them in the tree).
 */
function LeafLink({
  node,
  spaceSlug,
  className,
  onClick,
  children,
}: {
  node: DriveNode;
  spaceSlug: string;
  className: string;
  onClick?: (e: MouseEvent) => void;
  children: ReactNode;
}) {
  if (node.type === 'page') {
    return (
      <Link
        to="/p/$pageRef"
        params={{ pageRef: pagePath(node).slice(3) }}
        className={className}
        onClick={onClick}
      >
        {children}
      </Link>
    );
  }
  if (node.type === 'board') {
    return (
      <Link to="/b/$boardId" params={{ boardId: node.id }} className={className} onClick={onClick}>
        {children}
      </Link>
    );
  }
  if (node.type === 'drawing') {
    return (
      <Link
        to="/d/$drawingId"
        params={{ drawingId: node.id }}
        className={className}
        onClick={onClick}
      >
        {children}
      </Link>
    );
  }
  return (
    <Link {...nodeLocation(node, spaceSlug)} className={className} onClick={onClick}>
      {children}
    </Link>
  );
}

type MoveInto = (nodes: DriveNode[], parentId: string | null, name: string) => void;

function TreeRow({
  space,
  id,
  name,
  icon,
  depth,
  active,
  openIds,
  activeId,
  hasChildren = true,
  role,
  dropName = name,
  folder = true,
  leaf = false,
  ancestorIds,
  onMove,
  node,
  onRename,
  menu,
}: {
  space: Space;
  id: string | null;
  name: string;
  icon: Parameters<typeof Icon>[0]['name'];
  depth: number;
  active: boolean;
  openIds: Set<string>;
  activeId: string | null;
  hasChildren?: boolean;
  /** The person's role on this folder: moving into it needs edit rights. */
  role: SpaceRole;
  /** Name in the "moved to" toast (the space name for the root). */
  dropName?: string;
  /** Only folders and the root take moved nodes (pages hold pages). */
  folder?: boolean;
  /** A file, board or drawing: it opens where it lives and takes no drops. */
  leaf?: boolean;
  ancestorIds: readonly string[];
  onMove: MoveInto;
  /** The row's node, none on the root; a double click on it renames it. */
  node?: DriveNode;
  onRename?: (node: DriveNode) => void;
  /** The Drive right-click menu (3.12), the same one the list rows have. */
  menu: (nodes: DriveNode[]) => ActionEntry[];
}) {
  const { t } = useI18n();
  const { canSpace } = usePermissions();
  const [menuOpen, setMenuOpen] = useState(false);
  const canAdd = folder && canSpace('space.edit_content', role);
  const newFolder: ActionEntry[] = canAdd
    ? [
        {
          kind: 'item',
          key: 'newFolder',
          icon: 'folder',
          label: t('drive.newFolder.title'),
          onSelect: () => openDriveDialog({ kind: 'newFolder', spaceId: space.id, parentId: id }),
        },
      ]
    : [];
  const entries: ActionEntry[] = node
    ? [...newFolder, ...(canAdd ? [{ kind: 'sep' as const, key: 'new' }] : []), ...menu([node])]
    : newFolder;
  const movable = (nodes: DriveNode[]) =>
    folder &&
    canSpace('space.edit_content', role) &&
    canMoveInto(nodes, { spaceId: space.id, id, ancestorIds });
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const [over, setOver] = useState(false);
  const isOpen = expanded ?? (id === null || openIds.has(id));
  const children = useQuery({ ...nodesQuery(space.id, id), enabled: isOpen && hasChildren });
  // Pages, boards and drawings leave the tree while their module is off, as in the list.
  const typeOn = useNodeTypeEnabled();
  const kids = (children.data ?? []).filter((n) => typeOn(n.type));
  const to = id ? '/drive/$spaceSlug/folder/$folderId' : '/drive/$spaceSlug';
  const params = id ? { spaceSlug: space.slug, folderId: id } : { spaceSlug: space.slug };
  const linkClass = 'flex h-full min-w-0 flex-1 items-center gap-2.5 pr-2.5 pl-1.5';
  // The first click opens the item and may remount this row, so a dblclick event would not
  // arrive: the second click of a double click renames.
  const onLinkClick =
    node && onRename && canSpace('space.edit_content', role)
      ? (e: MouseEvent) => {
          if (e.detail !== 2) return;
          e.preventDefault();
          onRename(node);
        }
      : undefined;
  const label = (
    <>
      <Icon name={icon} size={16} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">{name}</span>
    </>
  );

  return (
    <>
      <ActionContextMenu entries={entries} onOpenChange={setMenuOpen}>
        <div
          className={cn(
            'flex h-[var(--nv-h)] shrink-0 items-center rounded-sm text-[13.5px] leading-[18px] font-medium text-fg2 hover:bg-bg2 hover:text-fg',
            menuOpen && 'bg-bg2 text-fg',
            active && 'bg-capsule font-semibold text-fg',
            over && 'bg-capsule text-fg shadow-[inset_0_0_0_1.5px_var(--fg)]',
          )}
          style={{ paddingLeft: 10 + depth * 14 }}
          data-drop-target={over || undefined}
          onDragOver={(e) => {
            // Files, boards and drawings hold nothing: drops go to the folder around them.
            if (leaf) return;
            if (isNodeDrag(e) ? !movable(draggedNodes()) : !isFileDrag(e)) return;
            e.preventDefault();
            e.stopPropagation();
            if (isNodeDrag(e)) e.dataTransfer.dropEffect = 'move';
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            if (leaf) return;
            if (isNodeDrag(e)) {
              const nodes = draggedNodes();
              if (!movable(nodes)) return;
              e.preventDefault();
              e.stopPropagation();
              setOver(false);
              endNodeDrag();
              onMove(nodes, id, dropName);
              return;
            }
            if (!e.dataTransfer.files.length) return;
            e.preventDefault();
            e.stopPropagation();
            setOver(false);
            addUploads([...e.dataTransfer.files], {
              spaceId: space.id,
              parentId: id,
              folderName: name,
            });
          }}
        >
          {id !== null && hasChildren ? (
            <button
              type="button"
              aria-label={t(isOpen ? 'drive.nav.collapse' : 'drive.nav.expand', { name })}
              aria-expanded={isOpen}
              onClick={() => {
                // Folded by hand: it stays folded on the next Drive screen too.
                if (isOpen && id) openIds.delete(id);
                setExpanded(!isOpen);
              }}
              className="-ml-1 flex size-4 items-center justify-center text-fg3"
            >
              <TreeChevron open={isOpen} />
            </button>
          ) : id !== null ? (
            <span className="-ml-1 size-4" />
          ) : null}
          {node && (leaf || node.type === 'page') ? (
            <LeafLink
              node={node}
              spaceSlug={space.slug}
              className={linkClass}
              onClick={onLinkClick}
            >
              {label}
            </LeafLink>
          ) : (
            <Link
              to={to}
              params={params}
              aria-current={active ? 'page' : undefined}
              onClick={onLinkClick}
              className={linkClass}
            >
              {label}
            </Link>
          )}
        </div>
      </ActionContextMenu>
      <TreeReveal open={isOpen}>
        {kids.map((k) => (
          <TreeRow
            key={k.id}
            space={space}
            id={k.id}
            name={k.name}
            icon={nodeIcon(k)}
            depth={depth + 1}
            active={activeId === k.id}
            openIds={openIds}
            activeId={activeId}
            hasChildren={containers.includes(k.type) && k.hasChildren}
            leaf={!containers.includes(k.type)}
            role={k.myRole}
            folder={k.type === 'folder'}
            ancestorIds={id === null ? ancestorIds : [...ancestorIds, id]}
            onMove={onMove}
            node={k}
            onRename={onRename}
            menu={menu}
          />
        ))}
      </TreeReveal>
    </>
  );
}
