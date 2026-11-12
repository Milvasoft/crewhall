import { queryKeys } from '@crewhall/api-client';
import { type BoardDetail, type BoardsWsEvent } from '@crewhall/shared';
import { type QueryClient } from '@tanstack/react-query';

/**
 * Board events from the WebSocket (sent after commit to everyone who can see the node).
 * A board whose cached revision is behind refetches; an open card and the personal
 * views follow. Without a socket, `useBoardLive` keeps polling the revision instead.
 * Keys are spelled out (same as boardKeys) so chat's runtime does not import the board api.
 */
export function handleBoardsEvent(client: QueryClient, e: BoardsWsEvent): void {
  if (e.type === 'board.changed') {
    const cached = client.getQueryData<BoardDetail>(['boards', 'board', e.boardId]);
    void client.invalidateQueries({ queryKey: ['boards', 'rev', e.boardId] });
    void client.invalidateQueries({ queryKey: ['boards', 'mine'] });
    void client.invalidateQueries({ queryKey: ['boards', 'list'] });
    if (!cached || cached.board.rev >= e.rev) return;
    void client.invalidateQueries({ queryKey: ['boards', 'board', e.boardId] });
    void client.invalidateQueries({ queryKey: ['boards', 'burndown'] });
    void client.invalidateQueries({ queryKey: ['boards', 'workload'] });
    void client.invalidateQueries({ queryKey: ['boards', 'card'] });
    void client.invalidateQueries({ queryKey: ['boards', 'activity'] });
    void client.invalidateQueries({ queryKey: ['boards', 'archived', e.boardId] });
    return;
  }
  // A new drawing thumbnail: lists, Drive tiles and the node preview pick it up.
  void client.invalidateQueries({ queryKey: ['drawings', 'list'] });
  void client.invalidateQueries({ queryKey: queryKeys.node(e.nodeId) });
}
