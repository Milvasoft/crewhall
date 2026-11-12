import {
  type BoardCard,
  type BoardCardDetail,
  type BoardDetail,
  type MyBoardCardsQuery,
} from '@crewhall/shared';
import { queryOptions, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { type z } from 'zod';
import { api } from '@/lib/api';
import { useSocketState } from '@/lib/chat/runtime';

/**
 * Boards and drawings queries (design 06). `board.changed` arrives over the WebSocket
 * (lib/boards/realtime.ts); an open board also polls the cheap `getBoardRev`, often while
 * the socket is down and rarely while it is open.
 */

export const boardKeys = {
  list: (spaceId: string) => ['boards', 'list', spaceId] as const,
  board: (boardId: string) => ['boards', 'board', boardId] as const,
  card: (cardId: string) => ['boards', 'card', cardId] as const,
  cardByNumber: (boardId: string, ref: string) => ['boards', 'card', boardId, ref] as const,
  activity: (cardId: string) => ['boards', 'activity', cardId] as const,
  archived: (boardId: string) => ['boards', 'archived', boardId] as const,
  burndown: (sprintId: string) => ['boards', 'burndown', sprintId] as const,
  mine: (q: Partial<z.input<typeof MyBoardCardsQuery>>) => ['boards', 'mine', q] as const,
  drawings: (spaceId: string) => ['drawings', 'list', spaceId] as const,
  drawing: (nodeId: string) => ['drawings', 'drawing', nodeId] as const,
  library: (spaceId: string | undefined) => ['drawings', 'library', spaceId ?? null] as const,
};

export const boardsQuery = (spaceId: string) =>
  queryOptions({
    queryKey: boardKeys.list(spaceId),
    queryFn: ({ signal }) => api.call('listBoards', { params: { spaceId }, signal }),
    staleTime: 30_000,
  });

export const boardQuery = (boardId: string) =>
  queryOptions({
    queryKey: boardKeys.board(boardId),
    queryFn: ({ signal }) => api.call('getBoard', { params: { boardId }, signal }),
    staleTime: 10_000,
  });

/** Burndown days in the viewer's time zone; refreshed with the board (board.changed). */
export const burndownQuery = (sprintId: string) =>
  queryOptions({
    queryKey: boardKeys.burndown(sprintId),
    queryFn: ({ signal }) =>
      api.call('getBoardSprintBurndown', {
        params: { sprintId },
        query: { tz: Intl.DateTimeFormat().resolvedOptions().timeZone },
        signal,
      }),
    staleTime: 30_000,
  });

export const cardQuery = (cardId: string) =>
  queryOptions({
    queryKey: boardKeys.card(cardId),
    queryFn: ({ signal }) => api.call('getBoardCard', { params: { cardId }, signal }),
    staleTime: 10_000,
  });

export const cardByNumberQuery = (boardId: string, ref: string) =>
  queryOptions({
    queryKey: boardKeys.cardByNumber(boardId, ref),
    queryFn: ({ signal }) =>
      api.call('getBoardCardByNumber', { params: { boardId, number: ref }, signal }),
    staleTime: 10_000,
    retry: false,
  });

export const activityQuery = (cardId: string) =>
  queryOptions({
    queryKey: boardKeys.activity(cardId),
    queryFn: async ({ signal }) => {
      const items = [];
      let cursor: string | undefined;
      for (let i = 0; i < 10; i++) {
        const page = await api.call('listBoardCardActivity', {
          params: { cardId },
          query: { cursor, limit: 100 },
          signal,
        });
        items.push(...page.items);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      return items;
    },
  });

export const archivedQuery = (boardId: string) =>
  queryOptions({
    queryKey: boardKeys.archived(boardId),
    queryFn: ({ signal }) =>
      api.call('listArchivedBoardCards', { params: { boardId }, query: { limit: 100 }, signal }),
  });

export const myCardsQuery = (q: Partial<z.input<typeof MyBoardCardsQuery>> = {}) =>
  queryOptions({
    queryKey: boardKeys.mine(q),
    queryFn: ({ signal }) => api.call('listMyBoardCards', { query: q, signal }),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

export const drawingsQuery = (spaceId: string) =>
  queryOptions({
    queryKey: boardKeys.drawings(spaceId),
    queryFn: ({ signal }) => api.call('listDrawings', { params: { spaceId }, signal }),
    staleTime: 30_000,
  });

export const drawingQuery = (nodeId: string) =>
  queryOptions({
    queryKey: boardKeys.drawing(nodeId),
    queryFn: ({ signal }) => api.call('getDrawing', { params: { nodeId }, signal }),
  });

export const libraryQuery = (spaceId: string | undefined) =>
  queryOptions({
    queryKey: boardKeys.library(spaceId),
    queryFn: ({ signal }) => api.call('getDrawingLibrary', { query: { spaceId }, signal }),
    staleTime: 60_000,
  });

/* ------------------------------ cache helpers ------------------------------ */

/** Writes a card into the cached board (insert or replace; archived ones leave). */
export function putBoardCard(qc: QueryClient, card: BoardCard): void {
  qc.setQueryData<BoardDetail>(boardKeys.board(card.boardId), (d) => {
    if (!d) return d;
    const others = d.cards.filter((c) => c.id !== card.id);
    const cards = card.archivedAt ? others : [...others, card];
    return { ...d, cards: sortCards(d, cards) };
  });
}

export function dropBoardCard(qc: QueryClient, boardId: string, cardId: string): void {
  qc.setQueryData<BoardDetail>(boardKeys.board(boardId), (d) =>
    d ? { ...d, cards: d.cards.filter((c) => c.id !== cardId) } : d,
  );
}

export function putCardDetail(qc: QueryClient, detail: BoardCardDetail): void {
  qc.setQueryData(boardKeys.card(detail.id), detail);
  putBoardCard(qc, detail);
}

/** Column order, then fractional position (byte order, as the server compares). */
export function sortCards(d: Pick<BoardDetail, 'columns'>, cards: BoardCard[]): BoardCard[] {
  const colIndex = new Map(d.columns.map((c, i) => [c.id, i]));
  return [...cards].sort((a, b) => {
    const ca = colIndex.get(a.columnId) ?? 0;
    const cb = colIndex.get(b.columnId) ?? 0;
    if (ca !== cb) return ca - cb;
    return a.position < b.position ? -1 : a.position > b.position ? 1 : 0;
  });
}

export function invalidateBoard(qc: QueryClient, boardId: string): void {
  void qc.invalidateQueries({ queryKey: boardKeys.board(boardId) });
  void qc.invalidateQueries({ queryKey: ['boards', 'burndown'] });
  void qc.invalidateQueries({ queryKey: ['boards', 'workload'] });
  void qc.invalidateQueries({ queryKey: ['boards', 'mine'] });
  void qc.invalidateQueries({ queryKey: ['boards', 'list'] });
}

/**
 * Keeps an open board current: polls the revision every few seconds while the tab is
 * visible and refetches the board (and an open card) when someone else changed it.
 */
export function useBoardLive(boardId: string, openCardId?: string | null) {
  const qc = useQueryClient();
  const socket = useSocketState();
  const last = useRef<number | null>(null);
  const rev = useQuery({
    queryKey: ['boards', 'rev', boardId],
    queryFn: ({ signal }) => api.call('getBoardRev', { params: { boardId }, signal }),
    refetchInterval: socket.status === 'open' ? 30_000 : 4000,
    refetchIntervalInBackground: false,
    staleTime: 0,
  });
  const current = rev.data?.rev ?? null;
  const cached = qc.getQueryData<BoardDetail>(boardKeys.board(boardId))?.board.rev ?? null;
  useEffect(() => {
    if (current === null) return;
    if (last.current !== null && current !== last.current && current !== cached) {
      void qc.invalidateQueries({ queryKey: boardKeys.board(boardId) });
      void qc.invalidateQueries({ queryKey: ['boards', 'burndown'] });
      void qc.invalidateQueries({ queryKey: ['boards', 'workload'] });
      if (openCardId) {
        void qc.invalidateQueries({ queryKey: ['boards', 'card'] });
        void qc.invalidateQueries({ queryKey: ['boards', 'activity'] });
      }
    }
    last.current = current;
  }, [current, cached, boardId, openCardId, qc]);
}
