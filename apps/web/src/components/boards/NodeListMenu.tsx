import { paths, type DriveNode, type SpaceRole } from '@crewhall/shared';
import { toast } from '@crewhall/ui';
import { useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import { ActionContextMenu, type ActionEntry } from '@/components/common/ActionMenu';
import { useDriveDialog, useNodeActions } from '@/features/drive/actions';
import { invalidateDrive, nodeQuery } from '@/features/drive/api';
import { useNodeMenu } from '@/features/drive/nodeMenu';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';

type ListedType = 'board' | 'drawing';

/** What the boards and drawings lists know about an item (their summaries). */
export interface ListedNode {
  id: string;
  spaceId: string;
  parentId: string | null;
  name: string;
  updatedAt: string;
}

/** A Drive node from a list summary, until the real one is fetched (first right click). */
function asNode(item: ListedNode, type: ListedType, myRole: SpaceRole): DriveNode {
  return {
    id: item.id,
    spaceId: item.spaceId,
    parentId: item.parentId,
    name: item.name,
    updatedAt: item.updatedAt,
    type,
    mime: null,
    sizeBytes: 0,
    hasChildren: false,
    myRole,
    shared: false,
    favorite: false,
    preview: 'none',
    version: null,
    createdBy: null,
    updatedBy: null,
    createdAt: item.updatedAt,
    deletedAt: null,
  };
}

/** The key a menu shortcut is written with (`useNodeMenu`), for a key press. */
function shortcutOf(e: KeyboardEvent): string | null {
  if (e.key === 'F2') return 'F2';
  if (e.key === 'Delete') return 'Del';
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'c') return 'Ctrl Shift C';
  if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return null;
  return e.key.toUpperCase();
}

/**
 * Right-click menu of the boards and drawings lists of a space (both are Drive nodes): the
 * Drive node menu (open, share, link, favourite, rename, move, copy, details, trash) with
 * "open in new tab", the item's own address as its link, and the list refreshed after each
 * write. The shortcuts it shows work on the focused tile.
 */
export function useNodeListMenu(type: ListedType, listKey: QueryKey) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const actions = useNodeActions();
  const menu = useNodeMenu(actions);
  const refresh = () => void qc.invalidateQueries({ queryKey: listKey });

  // The Drive dialogs (rename, move, copy) refresh Drive queries only: when one closes,
  // the list catches up too.
  const dialog = useDriveDialog();
  const last = useRef(dialog);
  useEffect(() => {
    const prev = last.current;
    last.current = dialog;
    if (prev && !dialog) refresh();
  }, [dialog]); // eslint-disable-line react-hooks/exhaustive-deps

  const href = (n: DriveNode) =>
    `${window.location.origin}${type === 'board' ? paths.board(n.id) : paths.drawing(n.id)}`;

  const trash = (nodes: DriveNode[]) => {
    const nodeIds = nodes.map((n) => n.id);
    const fail = (e: unknown) => toast(t(errorKey(e)));
    void api
      .call('trashNodes', { body: { nodeIds } })
      .then(() => {
        refresh();
        invalidateDrive(qc);
        toast(t('drive.trashed', { count: nodes.length }), {
          duration: 8000,
          action: {
            label: t('quick.undo'),
            onClick: () =>
              void api
                .call('restoreNodes', { body: { nodeIds } })
                .then(() => {
                  refresh();
                  invalidateDrive(qc);
                })
                .catch(fail),
          },
        });
      })
      .catch(fail);
  };

  const entries = (n: DriveNode): ActionEntry[] =>
    menu([n]).flatMap((e): ActionEntry[] => {
      if (e.kind !== 'item') return [e];
      if (e.key === 'link') {
        return [
          {
            ...e,
            onSelect: () => {
              void navigator.clipboard?.writeText(href(n));
              toast(t('drive.linkCopied'));
            },
          },
        ];
      }
      if (e.key === 'trash') return [{ ...e, onSelect: () => trash([n]) }];
      return [e];
    });

  /** F2, Del, M, I and Ctrl Shift C on a focused tile do what its menu says (Enter opens). */
  const onKeyDown = (n: DriveNode, e: KeyboardEvent) => {
    const key = shortcutOf(e);
    if (!key) return;
    const hit = entries(n).find((x) => x.kind === 'item' && x.shortcut === key);
    if (hit?.kind !== 'item') return;
    e.preventDefault();
    if (!hit.disabledReason) hit.onSelect();
  };

  return { type, actions, entries, onKeyDown };
}

export type NodeListMenu = ReturnType<typeof useNodeListMenu>;

/**
 * One tile of the list with its right-click menu. The full Drive node (favourite, shares,
 * role) is fetched the first time the menu opens; until then the summary stands in.
 */
export function NodeListItem({
  item,
  myRole,
  menu,
  children,
}: {
  item: ListedNode;
  myRole: SpaceRole;
  menu: NodeListMenu;
  children: (bind: { node: DriveNode; onKeyDown: (e: KeyboardEvent) => void }) => ReactElement;
}) {
  const [wanted, setWanted] = useState(false);
  const full = useQuery({ ...nodeQuery(item.id), enabled: wanted });
  const node = full.data ?? asNode(item, menu.type, myRole);

  return (
    <ActionContextMenu entries={menu.entries(node)} onOpenChange={(o) => o && setWanted(true)}>
      {children({ node, onKeyDown: (e) => menu.onKeyDown(node, e) })}
    </ActionContextMenu>
  );
}
