import { type DriveNode, type NodeType } from '@crewhall/shared';
import {
  Button,
  Chip,
  cn,
  Icon,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Skeleton,
  Tooltip,
} from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { ActionContextMenu, type ActionEntry } from '@/components/common/ActionMenu';
import { NewBoardDialog } from '@/components/boards/NewBoardDialog';
import { useNewDrawing } from '@/components/drawings/useNewDrawing';
import { OfficeNewItems, useOfficeNewEntries } from '@/components/office/OfficeNewItems';
import { useCreatePage } from '@/components/wiki/useCreatePage';
import { Workspace } from '@/components/shell/Workspace';
import { spaceName } from '@/components/spaces/spaceUtils';
import { api, isApiError } from '@/lib/api';
import { formatBytes } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useNodeTypeEnabled } from '@/lib/identity/modules';
import { usePermissions } from '@/lib/session';
import { readStorage, StorageKey, writeStorage } from '@/lib/storage';
import { rememberSpace, useSpaces } from '@/lib/useSpaces';
import { openDriveDialog, useNodeActions } from '@/features/drive/actions';
import { nodeQuery, nodesQuery, quotaQuery, type NodeSort } from '@/features/drive/api';
import { DetailPanel } from '@/features/drive/DetailPanel';
import { DriveSidebar } from '@/features/drive/DriveSidebar';
import { NodeSelectionBar } from '@/features/drive/NodeSelectionBar';
import { useNodeMenu, useNodeMenuKeys } from '@/features/drive/nodeMenu';
import { canMoveInto } from '@/features/drive/dnd';
import { NodeGrid, NodeTable, type NodeDnd } from '@/features/drive/NodeViews';
import { folderLocation, type DriveSearch } from '@/features/drive/paths';
import { Previewer } from '@/features/drive/Previewer';
import { QuotaBanner } from '@/features/drive/QuotaBanner';
import { SpaceMounts } from '@/components/microsoft/MountBrowser';
import { addUploads, type UploadTarget } from '@/features/drive/uploads';

type Filter = 'all' | NodeType;
/** Menu shortcuts this page leaves to useNodeMenuKeys (it handles Del, F2 and I itself). */
const FOLDER_MENU_KEYS = ['M', 'Ctrl Shift C'] as const;
const FILTERS: Filter[] = ['all', 'folder', 'file', 'page', 'board', 'drawing'];

function readViews(): Record<string, 'list' | 'grid'> {
  try {
    return JSON.parse(readStorage(StorageKey.driveViews) ?? '{}') as Record<
      string,
      'list' | 'grid'
    >;
  } catch {
    return {};
  }
}

/** A folder (or the space root) in Drive: list or grid, upload, menus, viewer, details. */
export function FolderPage({
  spaceSlug,
  folderId,
  search,
}: {
  spaceSlug: string;
  folderId: string | null;
  search: DriveSearch;
}) {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const { bySlug } = useSpaces();
  const { canSpace } = usePermissions();
  const space = bySlug(spaceSlug);
  const actions = useNodeActions();
  const menu = useNodeMenu(actions);
  const [sort, setSort] = useState<NodeSort>('name');
  const [order, setOrder] = useState<'asc' | 'desc'>('asc');
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [newBoard, setNewBoard] = useState(false);
  const newDrawing = useNewDrawing();
  const officeEntries = useOfficeNewEntries();
  const createPage = useCreatePage();
  // Pages, boards and drawings (and their "Yeni" entries) hide while their module is off.
  const typeOn = useNodeTypeEnabled();
  const boardsOn = typeOn('board');
  // Drawings are their own module (2026-10-29): each entry follows its own switch.
  const drawingsOn = typeOn('drawing');
  const viewKey = folderId ?? `root:${space?.id ?? ''}`;
  const [view, setView] = useState<'list' | 'grid'>(() =>
    search.view === 'grid' ? 'grid' : (readViews()[viewKey] ?? 'list'),
  );
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  // Another folder: start over as a newly opened page would, without remounting the screen (a
  // remount rebuilt the sidebar tree on every click and it flashed).
  const [shownFolder, setShownFolder] = useState(folderId);
  if (shownFolder !== folderId) {
    setShownFolder(folderId);
    setSort('name');
    setOrder('asc');
    setFilter('all');
    setSelected(new Set());
    setAnchor(null);
    setDragging(null);
    setNewBoard(false);
    setView(search.view === 'grid' ? 'grid' : (readViews()[viewKey] ?? 'list'));
  }

  const folder = useQuery({ ...nodeQuery(folderId ?? ''), enabled: Boolean(folderId) });
  const list = useQuery({
    ...nodesQuery(space?.id ?? '', folderId, { sort, order }),
    enabled: Boolean(space),
  });
  const quota = useQuery({ ...quotaQuery, retry: false });
  const all = useMemo(() => (list.data ?? []).filter((n) => typeOn(n.type)), [list.data, typeOn]);
  const nodes = filter === 'all' ? all : all.filter((n) => n.type === filter);
  const chosen = all.filter((n) => selected.has(n.id));
  const canWrite = space
    ? canSpace('space.edit_content', folder.data?.myRole ?? space.myRole)
    : false;
  const title = folderId ? (folder.data?.name ?? '') : t('drive.nav.all');
  const folderName = space ? (folderId ? title : spaceName(space, t)) : '';
  const target = useMemo<UploadTarget | null>(
    () => (space ? { spaceId: space.id, parentId: folderId, folderName } : null),
    [space, folderId, folderName],
  );

  useEffect(() => {
    if (space) rememberSpace(space.slug);
  }, [space]);

  const go = (s: DriveSearch) =>
    void navigate({ ...folderLocation(spaceSlug, folderId, s), replace: true });
  const setViewMode = (v: 'list' | 'grid') => {
    setView(v);
    writeStorage(StorageKey.driveViews, JSON.stringify({ ...readViews(), [viewKey]: v }));
    go({ ...search, view: v === 'grid' ? 'grid' : undefined });
  };

  const openNode = (n: DriveNode) => {
    // Files always open the viewer; unsupported types show their badge and Download there.
    if (n.type === 'file') go({ ...search, preview: n.id });
    else actions.open(n);
  };

  const select = (n: DriveNode, e: { ctrl: boolean; shift: boolean }) => {
    if (e.shift && anchor) {
      const ids = nodes.map((x) => x.id);
      const [a, b] = [ids.indexOf(anchor), ids.indexOf(n.id)].sort((x, y) => x - y);
      setSelected(new Set(ids.slice(a, b! + 1)));
      return;
    }
    if (e.ctrl) {
      const next = new Set(selected);
      if (next.has(n.id)) next.delete(n.id);
      else next.add(n.id);
      setSelected(next);
    } else {
      setSelected(new Set([n.id]));
    }
    setAnchor(n.id);
    if (search.detail) go({ ...search, detail: n.id });
  };
  const toggle = (n: DriveNode) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(n.id)) next.delete(n.id);
      else next.add(n.id);
      return next;
    });
    setAnchor(n.id);
  };
  const targets = (n: DriveNode) => (selected.has(n.id) ? chosen : [n]);
  // Drag rows onto a folder row (or a sidebar folder) to move them; the selection moves together.
  const dnd: NodeDnd | undefined = canWrite
    ? {
        dragNodes: (n) => {
          const nodes = targets(n);
          return nodes.every((x) => actions.can(x, 'space.edit_content')) ? nodes : [];
        },
        canDrop: (target, moving) =>
          actions.can(target, 'space.edit_content') &&
          canMoveInto(moving, { spaceId: target.spaceId, id: target.id }),
        onDrop: (target, moving) => {
          actions.moveTo(moving, {
            spaceId: target.spaceId,
            parentId: target.id,
            name: target.name,
          });
          setSelected(new Set());
        },
      }
    : undefined;

  const upload = (files: File[]) => {
    if (target && files.length) addUploads(files, target);
  };

  /** Folder upload keeps the structure: create the folders, then upload into each. */
  const uploadFolder = async (files: File[]) => {
    if (!space || !target) return;
    const ids = new Map<string, string | null>([['', folderId]]);
    const ensure = async (dir: string): Promise<string | null> => {
      if (ids.has(dir)) return ids.get(dir)!;
      const cut = dir.lastIndexOf('/');
      const parentId = await ensure(cut > 0 ? dir.slice(0, cut) : '');
      const name = dir.slice(cut + 1);
      let id: string;
      try {
        id = (
          await api.call('createFolder', {
            params: { spaceId: space.id },
            body: { parentId, name },
          })
        ).id;
      } catch (e) {
        if (!isApiError(e, 'node_name_taken')) throw e;
        id = (e.details as { nodeId: string }).nodeId;
      }
      ids.set(dir, id);
      return id;
    };
    const groups = new Map<string, File[]>();
    for (const f of files) {
      const rel = f.webkitRelativePath || f.name;
      const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
      groups.set(dir, [...(groups.get(dir) ?? []), f]);
    }
    for (const [dir, group] of groups) {
      const parentId = await ensure(dir);
      addUploads(group, {
        spaceId: space.id,
        parentId,
        folderName: dir.split('/').at(-1) || target.folderName,
      });
    }
  };

  // Ctrl V with an image on the clipboard uploads it here (3.6).
  useEffect(() => {
    if (!canWrite || !target) return;
    const onPaste = (e: ClipboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (el && ['INPUT', 'TEXTAREA'].includes(el.tagName)) return;
      const files = [...(e.clipboardData?.files ?? [])];
      if (!files.length) return;
      e.preventDefault();
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      addUploads(
        files.map((f) =>
          f.name && f.name !== 'image.png'
            ? f
            : new File([f], `${t('drive.pastedImage')}-${stamp}.png`, { type: f.type }),
        ),
        target,
      );
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [canWrite, target, t]);

  // The menu's M (move) and Ctrl Shift C (copy link) on the selection; the rest below.
  useNodeMenuKeys(menu, chosen, FOLDER_MENU_KEYS);
  // Keyboard: Space preview, Del trash, F2 rename, I details, Ctrl A all, Esc clear (3.12).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (
        search.preview ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) ||
        el.isContentEditable
      ) {
        return;
      }
      if (document.querySelector('[role="dialog"],[role="menu"]')) return;
      const one = chosen.length === 1 ? chosen[0]! : null;
      if (e.key === ' ' && one?.type === 'file' && !el.closest('button, a')) {
        e.preventDefault();
        go({ ...search, preview: one.id });
      } else if (
        e.key === 'Delete' &&
        chosen.length &&
        chosen.every((n) => actions.can(n, 'space.trash'))
      ) {
        actions.trash(chosen);
        setSelected(new Set());
      } else if (e.key === 'F2' && one && actions.can(one, 'space.edit_content')) {
        e.preventDefault();
        actions.rename(one);
      } else if (
        canWrite &&
        space &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        (e.key.toLowerCase() === 'k' || e.key.toLowerCase() === 'u')
      ) {
        e.preventDefault();
        if (e.key.toLowerCase() === 'k') {
          openDriveDialog({ kind: 'newFolder', spaceId: space.id, parentId: folderId });
        } else {
          fileInput.current?.click();
        }
      } else if (e.key.toLowerCase() === 'i' && one && !e.ctrlKey) {
        go({ ...search, detail: one.id });
      } else if (e.key.toLowerCase() === 'a' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setSelected(new Set(nodes.map((n) => n.id)));
      } else if (e.key === 'Escape') {
        setSelected(new Set());
      }
    };
    // Capture phase: runs before an open menu or dialog handles the key (Esc closing a menu
    // must not also clear the selection).
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const onDragOver = (e: DragEvent) => {
    if (!canWrite || !e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    setDragging(e.dataTransfer.items.length);
  };
  const onDrop = (e: DragEvent) => {
    if (!canWrite || !e.dataTransfer.files.length) return;
    e.preventDefault();
    setDragging(null);
    upload([...e.dataTransfer.files]);
  };

  if (!space) return null;
  const totalSize = all.reduce((a, n) => a + n.sizeBytes, 0);
  // Right click on the folder's empty space: what the New menu offers (rows have their own menu).
  const newEntries: ActionEntry[] = canWrite
    ? [
        {
          kind: 'item',
          key: 'folder',
          icon: 'folder',
          label: t('drive.newFolder.title'),
          shortcut: 'K',
          onSelect: () =>
            openDriveDialog({ kind: 'newFolder', spaceId: space.id, parentId: folderId }),
        },
        ...(typeOn('page')
          ? [
              {
                kind: 'item' as const,
                key: 'page',
                icon: 'page' as const,
                label: t('drive.types.page'),
                onSelect: () => void createPage(space.id, folderId),
              },
            ]
          : []),
        ...(boardsOn
          ? [
              {
                kind: 'item' as const,
                key: 'board',
                icon: 'board' as const,
                label: t('drive.types.board'),
                onSelect: () => setNewBoard(true),
              },
            ]
          : []),
        ...(drawingsOn
          ? [
              {
                kind: 'item' as const,
                key: 'drawing',
                icon: 'vector' as const,
                label: t('drive.types.drawing'),
                onSelect: () => void newDrawing.create(space.id, folderId),
              },
            ]
          : []),
        ...officeEntries(space.id, folderId),
        { kind: 'sep', key: 'sep' },
        {
          kind: 'item',
          key: 'upload',
          icon: 'upload',
          label: t('drive.folder.uploadFiles'),
          shortcut: 'U',
          onSelect: () => fileInput.current?.click(),
        },
        {
          kind: 'item',
          key: 'uploadFolder',
          icon: 'folder',
          label: t('drive.folder.uploadFolder'),
          onSelect: () => folderInput.current?.click(),
        },
      ]
    : [];

  const crumbs = [
    { label: spaceName(space, t) },
    ...(folder.data?.path.map((p) => ({ label: p.name })) ?? []),
    { label: title },
  ];

  return (
    <Workspace
      sidebar={<DriveSidebar space={space} activeFolderId={folderId} />}
      crumbs={crumbs}
      searchLabel={t('shell.searchIn', { name: spaceName(space, t) })}
      bodyClassName="relative"
      scrollKey={viewKey}
      panel={
        search.detail ? (
          <DetailPanel
            nodeId={search.detail}
            onClose={() => go({ ...search, detail: undefined })}
          />
        ) : null
      }
    >
      <ActionContextMenu entries={newEntries}>
        <div
          data-drive-folder-area
          className="flex min-h-0 flex-1 flex-col gap-4"
          onDragOver={onDragOver}
          onDragLeave={(e) => {
            if (e.currentTarget === e.target) setDragging(null);
          }}
          onDrop={onDrop}
        >
          {quota.data?.warning ? <QuotaBanner quota={quota.data} /> : null}
          {/* External storage (Microsoft integrations): SharePoint, OneDrive and SMB mounts. */}
          {folderId === null && space ? (
            <SpaceMounts spaceId={space.id} spaceSlug={space.slug} />
          ) : null}
          <div className="flex shrink-0 items-end justify-between gap-4">
            <div className="flex min-w-0 flex-col">
              <h1 className="m-0 flex items-center gap-2 truncate text-wtitle font-bold">
                {title || <Skeleton className="h-7 w-48" />}
                {folder.data?.shared ? <Icon name="lock" size={18} className="text-fg3" /> : null}
              </h1>
              <span className="text-[13.5px] leading-[18px] text-fg2">
                {list.isSuccess
                  ? all.length
                    ? t('drive.folder.summary', {
                        count: all.length,
                        size: formatBytes(totalSize, locale),
                      })
                    : t('drive.folder.emptySummary')
                  : ' '}
              </span>
            </div>
            {canWrite ? (
              <div className="flex shrink-0 gap-2">
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => {
                    upload([...(e.target.files ?? [])]);
                    e.target.value = '';
                  }}
                  data-testid="drive-file-input"
                />
                <input
                  ref={folderInput}
                  type="file"
                  multiple
                  hidden
                  {...{ webkitdirectory: '' }}
                  onChange={(e) => {
                    void uploadFolder([...(e.target.files ?? [])]);
                    e.target.value = '';
                  }}
                />
                <Button size="sm" variant="out" onClick={() => fileInput.current?.click()}>
                  <Icon name="upload" size={16} />
                  {t('drive.folder.upload')}
                </Button>
                <Menu>
                  <MenuTrigger asChild>
                    <Button size="sm" variant="inv">
                      <Icon name="plus" size={16} />
                      {t('drive.folder.new')}
                    </Button>
                  </MenuTrigger>
                  <MenuContent align="end" className="w-[240px]">
                    <MenuItem
                      icon="folder"
                      shortcut="K"
                      onSelect={() =>
                        openDriveDialog({
                          kind: 'newFolder',
                          spaceId: space.id,
                          parentId: folderId,
                        })
                      }
                    >
                      {t('drive.types.folder')}
                    </MenuItem>
                    {typeOn('page') ? (
                      <MenuItem icon="page" onSelect={() => void createPage(space.id, folderId)}>
                        {t('drive.types.page')}
                      </MenuItem>
                    ) : null}
                    {boardsOn ? (
                      <MenuItem icon="board" onSelect={() => setNewBoard(true)}>
                        {t('drive.types.board')}
                      </MenuItem>
                    ) : null}
                    {drawingsOn ? (
                      <MenuItem
                        icon="vector"
                        disabled={newDrawing.busy}
                        onSelect={() => void newDrawing.create(space.id, folderId)}
                      >
                        {t('drive.types.drawing')}
                      </MenuItem>
                    ) : null}
                    <OfficeNewItems spaceId={space.id} parentId={folderId} />
                    <MenuSeparator />
                    <MenuItem
                      icon="upload"
                      shortcut="U"
                      onSelect={() => fileInput.current?.click()}
                    >
                      {t('drive.folder.uploadFiles')}
                    </MenuItem>
                    <MenuItem icon="folder" onSelect={() => folderInput.current?.click()}>
                      {t('drive.folder.uploadFolder')}
                    </MenuItem>
                  </MenuContent>
                </Menu>
              </div>
            ) : null}
          </div>

          {all.length ? (
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {FILTERS.filter((f) => f === 'all' || all.some((n) => n.type === f)).map((f) => (
                <Chip key={f} size="sm" on={filter === f} onClick={() => setFilter(f)}>
                  {f === 'all' ? t('drive.filters.all') : t(`drive.types.${f}`)}
                </Chip>
              ))}
              <span className="ml-auto flex items-center gap-1">
                <span className="text-xs text-fg2">{t(`drive.sorts.${sort}`)}</span>
                <Tooltip content={t('drive.view.list')}>
                  <IconButton
                    size="xs"
                    tone="plain"
                    aria-label={t('drive.view.list')}
                    aria-pressed={view === 'list'}
                    onClick={() => setViewMode('list')}
                    className={cn(view === 'list' && 'bg-bg2 text-fg')}
                  >
                    <Icon name="list" size={15} />
                  </IconButton>
                </Tooltip>
                <Tooltip content={t('drive.view.grid')}>
                  <IconButton
                    size="xs"
                    tone="plain"
                    aria-label={t('drive.view.grid')}
                    aria-pressed={view === 'grid'}
                    onClick={() => setViewMode('grid')}
                    className={cn(view === 'grid' && 'bg-bg2 text-fg')}
                  >
                    <Icon name="grid" size={15} />
                  </IconButton>
                </Tooltip>
              </span>
            </div>
          ) : null}

          {list.isLoading ? (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-11 w-full rounded-md" />
              ))}
            </div>
          ) : list.isError ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <Icon name="alert" size={28} className="text-fg3" />
              <span className="text-sub font-semibold">{t('drive.folder.loadError')}</span>
              <Button variant="inv" onClick={() => void list.refetch()}>
                {t('common.actions.retry')}
              </Button>
            </div>
          ) : all.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-2xl border-[1.5px] border-dashed border-line2 px-6 py-16 text-center">
              <span className="flex size-16 items-center justify-center rounded-4xl bg-bg2 text-fg2">
                <Icon name="folder" size={30} />
              </span>
              <span className="text-sub font-semibold">{t('drive.folder.emptyTitle')}</span>
              <p className="m-0 max-w-[420px] text-sm text-fg2">
                {canWrite ? t('drive.folder.emptyBody') : t('drive.folder.emptyViewer')}
              </p>
              {canWrite ? (
                <div className="mt-2 flex gap-2">
                  <Button variant="inv" onClick={() => fileInput.current?.click()}>
                    <Icon name="upload" size={16} />
                    {t('drive.folder.uploadFiles')}
                  </Button>
                  <Button
                    variant="out"
                    onClick={() =>
                      openDriveDialog({ kind: 'newFolder', spaceId: space.id, parentId: folderId })
                    }
                  >
                    {t('drive.newFolder.title')}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : view === 'grid' ? (
            <NodeGrid
              nodes={nodes}
              selected={selected}
              onSelect={select}
              onToggle={toggle}
              onSelectAll={(all) => setSelected(new Set(all ? nodes.map((x) => x.id) : []))}
              onOpen={openNode}
              onFavorite={(n) => actions.favorite(n)}
              menu={menu}
              menuTargets={targets}
              href={actions.href}
              dnd={dnd}
            />
          ) : (
            <NodeTable
              nodes={nodes}
              selected={selected}
              onSelect={select}
              onToggle={toggle}
              onSelectAll={(all) => setSelected(new Set(all ? nodes.map((x) => x.id) : []))}
              onOpen={openNode}
              onFavorite={(n) => actions.favorite(n)}
              menu={menu}
              menuTargets={targets}
              href={actions.href}
              dnd={dnd}
              sort={sort}
              order={order}
              onSort={(s) => {
                if (s === sort) setOrder(order === 'asc' ? 'desc' : 'asc');
                else {
                  setSort(s);
                  setOrder(s === 'name' || s === 'type' ? 'asc' : 'desc');
                }
              }}
            />
          )}

          {dragging !== null ? (
            <div className="pointer-events-none absolute inset-3 z-20 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-fg bg-[color-mix(in_srgb,var(--bg)_85%,transparent)]">
              <Icon name="upload" size={30} />
              <span className="text-sub font-semibold">
                {t('drive.drop.title', { name: target?.folderName ?? '' })}
              </span>
              <span className="text-sm text-fg2">
                {t('drive.drop.body', { count: dragging, members: space.memberCount })}
              </span>
            </div>
          ) : null}
        </div>
      </ActionContextMenu>

      <NodeSelectionBar nodes={chosen} actions={actions} onClear={() => setSelected(new Set())} />

      {boardsOn ? (
        <NewBoardDialog
          space={space}
          parentId={folderId}
          open={newBoard}
          onClose={() => setNewBoard(false)}
        />
      ) : null}
      {search.preview ? (
        <Previewer
          nodeId={search.preview}
          siblings={all}
          onNavigate={(id) => go({ ...search, preview: id })}
          onClose={() => go({ ...search, preview: undefined })}
        />
      ) : null}
    </Workspace>
  );
}
