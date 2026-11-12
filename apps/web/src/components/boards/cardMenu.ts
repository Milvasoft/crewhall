import { paths, type BoardCard, type BoardDetail } from '@crewhall/shared';
import { toast } from '@crewhall/ui';
import { type ActionEntry } from '@/components/common/ActionMenu';
import { openDriveDialog } from '@/features/drive/actions';
import { type BoardActions } from '@/lib/boards/actions';
import { cardRef } from '@/lib/boards/filters';
import { useI18n } from '@/lib/i18n/I18nContext';
import { newTabLabel, openInNewTab } from '@/lib/newTab';

/** Card-level writes need at least editor on the board (the same rule as the card detail). */
export const canEditBoard = (detail: Pick<BoardDetail, 'board'>) =>
  detail.board.myRole !== 'viewer';

/** Last card of a column: a card moved there from a menu goes to the end. */
const lastIn = (detail: BoardDetail, columnId: string, except: Set<string>) =>
  detail.cards.filter((c) => c.columnId === columnId && !except.has(c.id)).at(-1)?.id ?? null;

/**
 * Right-click menu of a card on the kanban and in the list view: what the card detail
 * offers (open, link, column, assignee, label, archive, delete). Viewers only see open and
 * link. `enter` shows ↵ where Enter opens the focused card (the kanban).
 */
export function useCardMenu({
  detail,
  actions,
  meId,
  onOpen,
}: {
  /** Undefined while the board loads (the hook runs before the page's early return). */
  detail: BoardDetail | undefined;
  actions: BoardActions;
  meId: string;
  onOpen: (card: BoardCard) => void;
}) {
  const { t } = useI18n();

  return (card: BoardCard, opts: { enter?: boolean } = {}): ActionEntry[] => {
    if (!detail) return [];
    const canEdit = canEditBoard(detail);
    const { settings } = detail.board;
    const key = cardRef(settings.key, card.number);
    const href = `${window.location.origin}${paths.boardCard(detail.board.id, key)}`;
    const entries: ActionEntry[] = [
      {
        kind: 'item',
        key: 'open',
        icon: 'arrowUR',
        label: t('boards.menu.open'),
        shortcut: opts.enter ? '↵' : undefined,
        onSelect: () => onOpen(card),
      },
      {
        kind: 'item',
        key: 'newTab',
        icon: 'ext',
        label: t(newTabLabel()),
        onSelect: () => openInNewTab(href),
      },
      {
        kind: 'item',
        key: 'link',
        icon: 'link',
        label: t('boards.detail.copyLink'),
        onSelect: () => {
          void navigator.clipboard?.writeText(href);
          toast(t('boards.detail.linkCopied'));
        },
      },
      {
        kind: 'item',
        key: 'sendToChat',
        icon: 'send',
        label: t('chat.refs.sendToChat'),
        onSelect: () =>
          openDriveDialog({
            kind: 'sendToChat',
            target: { kind: 'card', id: card.id },
            title: card.title,
          }),
      },
    ];
    if (!canEdit) return entries;

    const columns = detail.columns.filter((c) => c.id !== card.columnId);
    const mine = card.assignees.some((a) => a.id === meId);
    const freeLabels = settings.labels.filter((l) => !card.labels.includes(l.id));
    entries.push({ kind: 'sep', key: 's1' });
    if (columns.length) {
      entries.push({
        kind: 'sub',
        key: 'move',
        icon: 'arrowR',
        label: t('boards.menu.moveToColumn'),
        items: columns.map((c) => ({
          key: c.id,
          label: c.name,
          onSelect: () =>
            void actions.move({
              cardId: card.id,
              columnId: c.id,
              afterId: lastIn(detail, c.id, new Set([card.id])),
              beforeId: null,
            }),
        })),
      });
    }
    if (meId) {
      entries.push({
        kind: 'item',
        key: 'assignMe',
        icon: 'user',
        label: mine ? t('boards.menu.unassignMe') : t('boards.menu.assignMe'),
        onSelect: () =>
          void actions.setAssignees(
            card.id,
            mine
              ? card.assignees.filter((a) => a.id !== meId).map((a) => a.id)
              : [...card.assignees.map((a) => a.id), meId],
          ),
      });
    }
    if (freeLabels.length) {
      entries.push({
        kind: 'sub',
        key: 'label',
        icon: 'tag',
        label: t('boards.detail.addLabel'),
        items: freeLabels.map((l) => ({
          key: l.id,
          label: l.name,
          onSelect: () => void actions.updateCard(card.id, { labels: [...card.labels, l.id] }),
        })),
      });
    }
    entries.push({ kind: 'sep', key: 's2' });
    entries.push({
      kind: 'item',
      key: 'archive',
      icon: 'archive',
      label: t('boards.detail.archive'),
      onSelect: () => void actions.updateCard(card.id, { archived: true }),
    });
    entries.push({
      kind: 'item',
      key: 'delete',
      icon: 'trash',
      label: t('boards.detail.delete'),
      danger: true,
      onSelect: () => {
        if (window.confirm(t('boards.detail.deleteConfirm', { key }))) {
          void actions.deleteCard(card, key);
        }
      },
    });
    return entries;
  };
}

export type CardMenu = ReturnType<typeof useCardMenu>;

/**
 * The list view's menu when the right-clicked row is part of a multi-selection: the same
 * bulk writes as the selection bar (column, assign me, label, archive).
 */
export function useBulkCardMenu({
  detail,
  meId,
  run,
}: {
  detail: BoardDetail;
  meId: string;
  run: (body: Omit<Parameters<BoardActions['bulk']>[0], 'cardIds'>) => void;
}) {
  const { t } = useI18n();
  return (count: number): ActionEntry[] => {
    const entries: ActionEntry[] = [
      {
        kind: 'sub',
        key: 'move',
        icon: 'arrowR',
        label: t('boards.menu.moveToColumn'),
        items: detail.columns.map((c) => ({
          key: c.id,
          label: c.name,
          onSelect: () => run({ columnId: c.id }),
        })),
      },
    ];
    if (meId) {
      entries.push({
        kind: 'item',
        key: 'assignMe',
        icon: 'user',
        label: t('boards.menu.assignMe'),
        onSelect: () => run({ addAssigneeIds: [meId] }),
      });
    }
    if (detail.board.settings.labels.length) {
      entries.push({
        kind: 'sub',
        key: 'label',
        icon: 'tag',
        label: t('boards.detail.addLabel'),
        items: detail.board.settings.labels.map((l) => ({
          key: l.id,
          label: l.name,
          onSelect: () => run({ addLabels: [l.id] }),
        })),
      });
    }
    entries.push({ kind: 'sep', key: 's1' });
    entries.push({
      kind: 'item',
      key: 'archive',
      icon: 'archive',
      label: t('boards.menu.archiveMany', { count }),
      onSelect: () => run({ archive: true }),
    });
    return entries;
  };
}
