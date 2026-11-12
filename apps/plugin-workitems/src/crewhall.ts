import { ApiError, createApiClient, type ApiClient } from '@crewhall/api-client';
import { createServerClient } from '@crewhall/plugin-sdk/server';
import type { BoardCardDetail, BoardDetail, BoardLabel, BodyOf } from '@crewhall/shared';
import type { Sealer } from './store';
import type { FetchLike } from './providers/http';
import type { Installation } from './types';

/** What the engine needs from Crewhall; a real API client here, a fake in tests. */
export interface CrewhallPort {
  board(boardId: string): Promise<BoardDetail>;
  card(cardId: string): Promise<BoardCardDetail | null>;
  createCard(
    boardId: string,
    input: {
      columnId: string;
      title: string;
      description: string;
      labels: string[];
      dueAt: string | null;
      startAt: string | null;
    },
  ): Promise<BoardCardDetail>;
  updateCard(cardId: string, patch: BodyOf<'updateBoardCard'>): Promise<BoardCardDetail>;
  moveCard(cardId: string, columnId: string): Promise<void>;
  setAssignees(cardId: string, userIds: string[]): Promise<void>;
  comments(
    cardId: string,
  ): Promise<{ id: string; text: string; author: string; createdAt: string }[]>;
  addComment(cardId: string, text: string): Promise<string>;
  setLabels(boardId: string, labels: BoardLabel[]): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The plugin may spend 120 requests a minute per person: wait instead of failing a whole run. */
export async function patiently<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (!(err instanceof ApiError) || err.code !== 'rate_limited' || attempt >= 5) throw err;
      const after = Number((err.details as { retryAfter?: number } | undefined)?.retryAfter ?? 5);
      await sleep(Math.min(after, 60) * 1000);
    }
  }
}

export function portOf(api: ApiClient): CrewhallPort {
  const card = (cardId: string) =>
    patiently(() => api.call('getBoardCard', { params: { cardId } }));
  return {
    board: (boardId) => patiently(() => api.call('getBoard', { params: { boardId } })),
    async card(cardId) {
      try {
        return await card(cardId);
      } catch (err) {
        if (err instanceof ApiError && (err.status === 404 || err.status === 403)) return null;
        throw err;
      }
    },
    async createCard(boardId, input) {
      const created = await patiently(() =>
        api.call('createBoardCard', {
          params: { boardId },
          body: {
            afterId: null,
            beforeId: null,
            top: false,
            assigneeIds: [],
            ...input,
          },
        }),
      );
      return card(created.id);
    },
    updateCard: (cardId, body) =>
      patiently(() => api.call('updateBoardCard', { params: { cardId }, body })),
    async moveCard(cardId, columnId) {
      await patiently(() =>
        api.call('moveBoardCard', {
          params: { cardId },
          body: { columnId, afterId: null, beforeId: null },
        }),
      );
    },
    async setAssignees(cardId, userIds) {
      await patiently(() =>
        api.call('setBoardCardAssignees', { params: { cardId }, body: { userIds } }),
      );
    },
    async comments(cardId) {
      const out: { id: string; text: string; author: string; createdAt: string }[] = [];
      let cursor: string | undefined;
      do {
        const page = await patiently(() =>
          api.call('listBoardCardActivity', {
            params: { cardId },
            query: { limit: 100, ...(cursor ? { cursor } : {}) },
          }),
        );
        for (const a of page.items) {
          if (a.kind === 'comment' && a.text) {
            out.push({
              id: a.id,
              text: a.text,
              author: a.actor?.name ?? '',
              createdAt: a.createdAt,
            });
          }
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return out.reverse();
    },
    async addComment(cardId, text) {
      const a = await patiently(() =>
        api.call('addBoardCardComment', { params: { cardId }, body: { text } }),
      );
      return a.id;
    },
    async setLabels(boardId, labels) {
      await patiently(() => api.call('updateBoard', { params: { boardId }, body: { labels } }));
    },
  };
}

/** Background access: an offline token for the sync's owner, reused until shortly before it ends. */
export function offlinePorts(deps: { sealer: Sealer; fetch?: FetchLike }) {
  const cache = new Map<string, { token: string; until: number }>();
  return (installation: Installation, userId: string): CrewhallPort => {
    const client = createServerClient({
      apiUrl: installation.apiUrl,
      installationId: installation.id,
      secret: deps.sealer.open(installation.secret),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
    const key = `${installation.id}:${userId}`;
    return portOf(
      createApiClient({
        baseUrl: installation.apiUrl,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        getToken: async () => {
          const hit = cache.get(key);
          if (hit && hit.until > Date.now()) return hit.token;
          const fresh = await client.offlineToken(userId);
          cache.set(key, { token: fresh.token, until: Date.parse(fresh.expiresAt) - 30_000 });
          return fresh.token;
        },
      }),
    );
  };
}
