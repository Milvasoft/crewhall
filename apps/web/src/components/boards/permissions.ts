import { type BoardDetail } from '@crewhall/shared';

/** Columns, labels and WIP limits: the server decides (space admins or the board's creator). */
export function canManageBoard(detail: Pick<BoardDetail, 'board'>): boolean {
  return detail.board.canManage;
}
