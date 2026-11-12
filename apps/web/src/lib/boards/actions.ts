import { type BoardCard, type BoardColumn, type BoardDetail, type BodyOf } from '@crewhall/shared';
import { toast } from '@crewhall/ui';
import { useQueryClient } from '@tanstack/react-query';
import { api, idempotencyKey } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { boardKeys, invalidateBoard, putBoardCard, putCardDetail, sortCards } from './api';

/**
 * Board writes. Moves are optimistic (the card jumps at once; the server's fractional key
 * replaces the guess when it answers); everything else updates the cache from the reply.
 * Failures roll back by refetching and show the contract error.
 */
export function useBoardActions(boardId: string) {
  const qc = useQueryClient();
  const { t } = useI18n();
  const fail = (e: unknown) => {
    toast(t(errorKey(e)));
    invalidateBoard(qc, boardId);
  };
  const get = () => qc.getQueryData<BoardDetail>(boardKeys.board(boardId));
  const set = (fn: (d: BoardDetail) => BoardDetail) =>
    qc.setQueryData<BoardDetail>(boardKeys.board(boardId), (d) => (d ? fn(d) : d));

  /** Puts the card next to its new neighbours in the cached list (positions come later). */
  const placeLocally = (
    d: BoardDetail,
    moved: BoardCard,
    afterId: string | null,
    beforeId: string | null,
  ) => {
    const rest = d.cards.filter((c) => c.id !== moved.id);
    let i = afterId ? rest.findIndex((c) => c.id === afterId) + 1 : -1;
    if (i <= 0 && beforeId) i = rest.findIndex((c) => c.id === beforeId);
    if (i < 0) {
      const last = rest.map((c) => c.columnId).lastIndexOf(moved.columnId);
      i = last >= 0 ? last + 1 : rest.length;
    }
    rest.splice(i, 0, moved);
    return rest;
  };

  return {
    async move(m: {
      cardId: string;
      columnId: string;
      afterId: string | null;
      beforeId: string | null;
    }) {
      const d = get();
      const card = d?.cards.find((c) => c.id === m.cardId);
      if (d && card) {
        const moved: BoardCard = { ...card, columnId: m.columnId };
        set((x) => ({ ...x, cards: placeLocally(x, moved, m.afterId, m.beforeId) }));
      }
      try {
        const res = await api.call('moveBoardCard', {
          params: { cardId: m.cardId },
          body: { columnId: m.columnId, afterId: m.afterId, beforeId: m.beforeId },
        });
        putBoardCard(qc, res.card);
        void qc.invalidateQueries({ queryKey: boardKeys.card(m.cardId) });
        void qc.invalidateQueries({ queryKey: boardKeys.activity(m.cardId) });
        if (card && card.columnId !== m.columnId) {
          const col = d?.columns.find((c) => c.id === m.columnId);
          if (res.wip.exceeded && col?.wipLimit) {
            toast(t('boards.column.wipExceeded', { count: res.wip.count, limit: col.wipLimit }));
          }
        }
        return res;
      } catch (e) {
        fail(e);
        return null;
      }
    },

    async addCard(body: BodyOf<'createBoardCard'>) {
      try {
        const card = await api.call('createBoardCard', {
          params: { boardId },
          body,
          idempotencyKey: idempotencyKey(),
        });
        putBoardCard(qc, card);
        void qc.invalidateQueries({ queryKey: ['boards', 'mine'] });
        return card;
      } catch (e) {
        fail(e);
        return null;
      }
    },

    async updateCard(cardId: string, body: BodyOf<'updateBoardCard'>) {
      try {
        const detail = await api.call('updateBoardCard', { params: { cardId }, body });
        putCardDetail(qc, detail);
        void qc.invalidateQueries({ queryKey: boardKeys.activity(cardId) });
        if (body.archived !== undefined) invalidateBoard(qc, boardId);
        return detail;
      } catch (e) {
        fail(e);
        return null;
      }
    },

    /** Planning: the card shows in its new sprint at once; the reply settles it. */
    async planCard(cardId: string, sprintId: string | null) {
      set((x) => ({ ...x, cards: x.cards.map((c) => (c.id === cardId ? { ...c, sprintId } : c)) }));
      try {
        const detail = await api.call('updateBoardCard', {
          params: { cardId },
          body: { sprintId },
        });
        putCardDetail(qc, detail);
        void qc.invalidateQueries({ queryKey: ['boards', 'burndown'] });
        return detail;
      } catch (e) {
        fail(e);
        return null;
      }
    },

    async setAssignees(cardId: string, userIds: string[]) {
      try {
        const card = await api.call('setBoardCardAssignees', {
          params: { cardId },
          body: { userIds },
        });
        putBoardCard(qc, card);
        void qc.invalidateQueries({ queryKey: boardKeys.card(cardId) });
        void qc.invalidateQueries({ queryKey: boardKeys.activity(cardId) });
        void qc.invalidateQueries({ queryKey: ['boards', 'mine'] });
        return card;
      } catch (e) {
        fail(e);
        return null;
      }
    },

    async deleteCard(card: BoardCard, key: string) {
      try {
        await api.call('deleteBoardCard', { params: { cardId: card.id } });
        set((x) => ({ ...x, cards: x.cards.filter((c) => c.id !== card.id) }));
        toast(t('boards.detail.deleted', { key }), {
          action: {
            label: t('boards.detail.undo'),
            onClick: () => {
              void api
                .call('restoreBoardCard', { params: { cardId: card.id } })
                .then((c) => putBoardCard(qc, c))
                .catch(fail);
            },
          },
        });
        return true;
      } catch (e) {
        fail(e);
        return false;
      }
    },

    async bulk(body: BodyOf<'bulkUpdateBoardCards'>) {
      try {
        await api.call('bulkUpdateBoardCards', { params: { boardId }, body });
      } catch (e) {
        toast(t(errorKey(e)));
      }
      invalidateBoard(qc, boardId);
    },

    async addColumn(name: string) {
      try {
        const col = await api.call('createBoardColumn', {
          params: { boardId },
          body: { name, afterId: get()?.columns.at(-1)?.id ?? null },
        });
        set((x) => ({ ...x, columns: [...x.columns, col] }));
      } catch (e) {
        fail(e);
      }
    },

    async updateColumn(columnId: string, body: BodyOf<'updateBoardColumn'>) {
      try {
        const col = await api.call('updateBoardColumn', { params: { columnId }, body });
        set((x) => ({ ...x, columns: x.columns.map((c) => (c.id === col.id ? col : c)) }));
        if (body.isDone !== undefined) invalidateBoard(qc, boardId);
        return col;
      } catch (e) {
        fail(e);
        return null;
      }
    },

    /** Optimistic like card moves: the column takes its place at once (design 6.1 drag). */
    async moveColumn(columnId: string, afterId: string | null, beforeId: string | null) {
      set((x) => {
        const moving = x.columns.find((c) => c.id === columnId);
        if (!moving) return x;
        const rest = x.columns.filter((c) => c.id !== columnId);
        let i = afterId ? rest.findIndex((c) => c.id === afterId) + 1 : -1;
        if (i <= 0 && beforeId) i = rest.findIndex((c) => c.id === beforeId);
        if (i < 0) i = afterId ? rest.length : 0;
        rest.splice(i, 0, moving);
        return { ...x, columns: rest, cards: sortCards({ columns: rest }, x.cards) };
      });
      try {
        const col: BoardColumn = await api.call('moveBoardColumn', {
          params: { columnId },
          body: { afterId, beforeId },
        });
        set((x) => {
          const columns = x.columns
            .map((c) => (c.id === col.id ? col : c))
            .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
          return { ...x, columns, cards: sortCards({ columns }, x.cards) };
        });
      } catch (e) {
        fail(e);
      }
    },

    async deleteColumn(columnId: string, moveTo?: string) {
      try {
        await api.call('deleteBoardColumn', { params: { columnId }, query: { moveTo } });
        invalidateBoard(qc, boardId);
        return true;
      } catch (e) {
        toast(t(errorKey(e)));
        return false;
      }
    },

    /** Sprint writes refetch the board: they move cards and change the active sprint. */
    async sprint<T>(call: () => Promise<T>): Promise<T | null> {
      try {
        const out = await call();
        invalidateBoard(qc, boardId);
        return out;
      } catch (e) {
        toast(t(errorKey(e)));
        return null;
      }
    },

    async updateBoard(body: BodyOf<'updateBoard'>) {
      try {
        const board = await api.call('updateBoard', { params: { boardId }, body });
        set((x) => ({ ...x, board }));
        void qc.invalidateQueries({ queryKey: ['boards', 'list'] });
        if (body.labels) invalidateBoard(qc, boardId);
        return board;
      } catch (e) {
        toast(t(errorKey(e)));
        return null;
      }
    },
  };
}

export type BoardActions = ReturnType<typeof useBoardActions>;
