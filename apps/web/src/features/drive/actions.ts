import { pagePath, type DriveNode, type MessageRef } from '@crewhall/shared';
import { toast } from '@crewhall/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useSyncExternalStore } from 'react';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { usePermissions } from '@/lib/session';
import { useSpaces } from '@/lib/useSpaces';
import { invalidateDrive } from './api';
import { folderLocation, nodeHref, nodeLocation, nodeOpenHref } from './paths';

// ---- dialogs any Drive screen can open (rendered once in the app frame) ----

export type DriveDialog =
  | { kind: 'rename'; node: DriveNode }
  | { kind: 'move' | 'copy'; nodes: DriveNode[] }
  | { kind: 'share'; node: DriveNode }
  | { kind: 'sendToChat'; target: MessageRef; title: string }
  | { kind: 'newFolder'; spaceId: string; parentId: string | null }
  | null;

let dialog: DriveDialog = null;
const listeners = new Set<() => void>();

export function openDriveDialog(d: DriveDialog): void {
  dialog = d;
  listeners.forEach((l) => l());
}

export function useDriveDialog(): DriveDialog {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => dialog,
    () => null,
  );
}

/** Starts a browser download from a short-lived signed URL. */
export function saveFromUrl(url: string, fileName: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Node actions shared by lists, the viewer, details, recent and search (3.12). */
export function useNodeActions() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { items: spaces } = useSpaces();
  const { canSpace } = usePermissions();
  const slugOf = (n: Pick<DriveNode, 'spaceId'>) =>
    spaces.find((s) => s.id === n.spaceId)?.slug ?? '';
  const fail = (e: unknown) => toast(t(errorKey(e)));

  return {
    slugOf,
    href: (n: DriveNode) => nodeOpenHref(n, slugOf(n)),
    can: (
      n: DriveNode,
      action: 'space.edit_content' | 'space.trash' | 'space.share_user' | 'space.share_link',
    ) => canSpace(action, n.myRole),
    open: (n: DriveNode) => {
      if (n.type === 'file' || n.type === 'folder') void navigate(nodeLocation(n, slugOf(n)));
      else if (n.type === 'board') void navigate({ to: '/b/$boardId', params: { boardId: n.id } });
      else if (n.type === 'drawing') {
        void navigate({ to: '/d/$drawingId', params: { drawingId: n.id } });
      }
      // Pages open in the wiki (phase 4).
      else if (n.type === 'page') {
        void navigate({ to: '/p/$pageRef', params: { pageRef: pagePath(n).slice(3) } });
      } else toast(t('drive.comingModule', { type: t(`drive.types.${n.type}`) }));
    },
    preview: (n: DriveNode) =>
      void navigate(folderLocation(slugOf(n), n.parentId, { preview: n.id })),
    details: (n: DriveNode) =>
      void navigate(folderLocation(slugOf(n), n.parentId, { detail: n.id })),
    download: async (nodes: DriveNode[]) => {
      for (const n of nodes.filter((x) => x.type === 'file')) {
        try {
          const d = await api.call('getDownloadUrl', { params: { nodeId: n.id }, query: {} });
          saveFromUrl(d.url, d.fileName);
        } catch (e) {
          fail(e);
        }
      }
    },
    copyLink: (n: DriveNode) => {
      void navigator.clipboard?.writeText(nodeHref(n, slugOf(n)));
      toast(t('drive.linkCopied'));
    },
    favorite: (n: DriveNode, favorite = !n.favorite) =>
      void api
        .call('setFavorite', { params: { nodeId: n.id }, body: { favorite } })
        .then(() => {
          invalidateDrive(qc);
          toast(t(favorite ? 'drive.favoriteAdded' : 'drive.favoriteRemoved'));
        })
        .catch(fail),
    trash: (nodes: DriveNode[]) =>
      void api
        .call('trashNodes', { body: { nodeIds: nodes.map((n) => n.id) } })
        .then(() => {
          invalidateDrive(qc);
          toast(t('drive.trashed', { count: nodes.length }), {
            duration: 8000,
            action: {
              label: t('quick.undo'),
              onClick: () =>
                void api
                  .call('restoreNodes', { body: { nodeIds: nodes.map((n) => n.id) } })
                  .then(() => invalidateDrive(qc))
                  .catch(fail),
            },
          });
        })
        .catch(fail),
    /** Drag and drop move (3.12); "Geri al" puts every node back in the folder it came from. */
    moveTo: (
      nodes: DriveNode[],
      target: { spaceId: string; parentId: string | null; name: string },
    ) =>
      void api
        .call('moveNodes', {
          body: {
            nodeIds: nodes.map((n) => n.id),
            target: { spaceId: target.spaceId, parentId: target.parentId },
          },
        })
        .then(() => {
          invalidateDrive(qc);
          toast(t('drive.move.movedTo', { count: nodes.length, name: target.name }), {
            duration: 8000,
            action: {
              label: t('quick.undo'),
              onClick: () => {
                const back = new Map<string, DriveNode[]>();
                for (const n of nodes) {
                  const key = `${n.spaceId}/${n.parentId ?? ''}`;
                  back.set(key, [...(back.get(key) ?? []), n]);
                }
                void Promise.all(
                  [...back.values()].map((group) =>
                    api.call('moveNodes', {
                      body: {
                        nodeIds: group.map((n) => n.id),
                        target: { spaceId: group[0]!.spaceId, parentId: group[0]!.parentId },
                      },
                    }),
                  ),
                )
                  .then(() => invalidateDrive(qc))
                  .catch(fail);
              },
            },
          });
        })
        .catch(fail),
    pin: (n: DriveNode, surfaceId: string) =>
      void api
        .call('createCard', {
          params: { surfaceId },
          body: {
            type: 'node',
            config: { nodeId: n.id, ...(n.type === 'folder' ? { maxItems: 3 } : {}) },
          },
        })
        .then(() => {
          void qc.invalidateQueries({ queryKey: ['surfaces'] });
          toast(t('drive.pinned', { name: n.name }));
        })
        .catch(fail),
    rename: (node: DriveNode) => openDriveDialog({ kind: 'rename', node }),
    move: (nodes: DriveNode[]) => openDriveDialog({ kind: 'move', nodes }),
    copy: (nodes: DriveNode[]) => openDriveDialog({ kind: 'copy', nodes }),
    share: (node: DriveNode) => openDriveDialog({ kind: 'share', node }),
    sendToChat: (node: DriveNode) =>
      openDriveDialog({
        kind: 'sendToChat',
        target: { kind: 'node', id: node.id },
        title: node.name,
      }),
  };
}

export type NodeActions = ReturnType<typeof useNodeActions>;
