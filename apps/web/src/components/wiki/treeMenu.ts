import { pagePath, type DriveNode, type PageTreeItem, type Space } from '@crewhall/shared';
import { toast } from '@crewhall/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { type ActionEntry } from '@/components/common/ActionMenu';
import { useNodeActions, useDriveDialog } from '@/features/drive/actions';
import { invalidateDrive, nodeQuery } from '@/features/drive/api';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { newTabLabel, openInNewTab } from '@/lib/newTab';
import { usePermissions } from '@/lib/session';
import { treeAncestors, wikiKeys } from '@/lib/wiki/api';
import { useSetPageFavorite } from '@/lib/wiki/favorite';
import { useCreatePage } from './useCreatePage';

/**
 * Right-click menus of the page tree: a page (open, favourite, sub page, rename, move, copy, link, trash)
 * and the empty area (new page). Pages are Drive nodes, so rename / move / copy open the Drive
 * dialogs; F2 and Del work on a focused tree row, so the menu shows them.
 */
export function usePageTreeMenu({
  space,
  items,
  activeId,
  canCreate,
}: {
  space: Space | undefined;
  items: PageTreeItem[];
  activeId?: string;
  canCreate: boolean;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const actions = useNodeActions();
  const { canSpace } = usePermissions();
  const create = useCreatePage();
  const setFavorite = useSetPageFavorite();
  const fail = (e: unknown) => toast(t(errorKey(e)));
  const refreshTree = () => {
    if (space) void qc.invalidateQueries({ queryKey: wikiKeys.tree(space.id) });
  };

  // The Drive dialogs only refresh Drive queries: when one closes, the tree and the page catch up.
  const dialog = useDriveDialog();
  const last = useRef(dialog);
  useEffect(() => {
    const prev = last.current;
    last.current = dialog;
    if (!prev || dialog) return;
    refreshTree();
    for (const n of prev.kind === 'move' || prev.kind === 'copy'
      ? prev.nodes
      : 'node' in prev
        ? [prev.node]
        : []) {
      void qc.invalidateQueries({ queryKey: wikiKeys.page(n.id) });
    }
  }, [dialog]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The Drive dialogs want the full node; the tree only has its page view of it. */
  const withNode = (item: PageTreeItem, run: (n: DriveNode) => void) =>
    void qc.fetchQuery(nodeQuery(item.id)).then(run).catch(fail);

  const canEdit = (item: PageTreeItem) => canSpace('space.edit_content', item.myRole);
  const canTrash = (item: PageTreeItem) => canSpace('space.trash', item.myRole);

  const rename = (item: PageTreeItem) => {
    if (canEdit(item)) withNode(item, actions.rename);
  };

  const trash = (item: PageTreeItem) => {
    if (!space || !canTrash(item)) return;
    const ids = [item.id];
    void api
      .call('trashNodes', { body: { nodeIds: ids } })
      .then(() => {
        refreshTree();
        invalidateDrive(qc);
        // The open page went with it: back to the space home.
        if (
          activeId &&
          (activeId === item.id || treeAncestors(items, activeId).includes(item.id))
        ) {
          void navigate({ to: '/pages/$spaceSlug', params: { spaceSlug: space.slug } });
        }
        toast(t('wiki.page.trashed'), {
          duration: 8000,
          action: {
            label: t('quick.undo'),
            onClick: () =>
              void api
                .call('restoreNodes', { body: { nodeIds: ids } })
                .then(() => {
                  refreshTree();
                  invalidateDrive(qc);
                })
                .catch(fail),
          },
        });
      })
      .catch(fail);
  };

  const pageEntries = (item: PageTreeItem, onAddChild?: () => void): ActionEntry[] => {
    const noEdit = canEdit(item) ? undefined : t('drive.menu.noEdit');
    return [
      {
        kind: 'item',
        key: 'open',
        icon: 'arrowUR',
        label: t('drive.menu.open'),
        shortcut: '↵',
        onSelect: () =>
          void navigate({ to: '/p/$pageRef', params: { pageRef: pagePath(item).slice(3) } }),
      },
      {
        kind: 'item',
        key: 'newTab',
        icon: 'ext',
        label: t(newTabLabel()),
        onSelect: () => openInNewTab(`${window.location.origin}${pagePath(item)}`),
      },
      {
        kind: 'item',
        key: 'favorite',
        icon: 'star',
        label: t(item.favorite ? 'wiki.menu.unfavorite' : 'wiki.menu.favorite'),
        onSelect: () => {
          if (space) void setFavorite({ id: item.id, spaceId: space.id }, !item.favorite);
        },
      },
      { kind: 'sep', key: 's1' },
      {
        kind: 'item',
        key: 'addChild',
        icon: 'plus',
        label: t('wiki.tree.addChild'),
        disabledReason: noEdit,
        onSelect: () => {
          if (!space) return;
          onAddChild?.();
          void create(space.id, item.id);
        },
      },
      {
        kind: 'item',
        key: 'rename',
        icon: 'edit',
        label: t('drive.menu.rename'),
        shortcut: 'F2',
        disabledReason: noEdit,
        onSelect: () => rename(item),
      },
      {
        kind: 'item',
        key: 'move',
        icon: 'arrowR',
        label: t('drive.menu.move'),
        disabledReason: noEdit,
        onSelect: () => withNode(item, (n) => actions.move([n])),
      },
      {
        kind: 'item',
        key: 'copy',
        icon: 'copy',
        label: t('drive.menu.copy'),
        onSelect: () => withNode(item, (n) => actions.copy([n])),
      },
      {
        kind: 'item',
        key: 'link',
        icon: 'link',
        label: t('drive.menu.copyLink'),
        onSelect: () => {
          void navigator.clipboard?.writeText(`${window.location.origin}${pagePath(item)}`);
          toast(t('wiki.menu.linkCopied'));
        },
      },
      { kind: 'sep', key: 's2' },
      {
        kind: 'item',
        key: 'trash',
        icon: 'trash',
        label: t('drive.menu.trash'),
        shortcut: 'Del',
        danger: true,
        disabledReason: canTrash(item) ? undefined : t('drive.menu.noTrash'),
        onSelect: () => trash(item),
      },
    ];
  };

  const emptyEntries: ActionEntry[] = space
    ? [
        {
          kind: 'item',
          key: 'newPage',
          icon: 'plus',
          label: t('wiki.nav.newPage'),
          disabledReason: canCreate ? undefined : t('wiki.tree.noCreate'),
          onSelect: () => void create(space.id, null),
        },
      ]
    : [];

  return { pageEntries, emptyEntries, rename, trash, canEdit };
}

export type PageTreeMenu = ReturnType<typeof usePageTreeMenu>;
