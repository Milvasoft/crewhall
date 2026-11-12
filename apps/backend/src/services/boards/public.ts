import { and, asc, eq, isNull } from 'drizzle-orm';
import { boardCards, boardColumns, boards } from '@crewhall/db';
import { BOARD_LIMITS, BoardLabel, type PublicBoard } from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import { publicNodeOf } from '../drive/shares';
import { toCards } from './boards';
import { boardsEnabled } from './module';

/**
 * A board opened from a public link (H15, design 19): its columns and the open cards' titles,
 * keys, labels and dates. People, descriptions, comments and attachments stay private.
 */
export async function publicBoard(
  deps: Deps,
  token: string,
  q: { grant?: string | undefined; nodeId?: string | undefined },
): Promise<PublicBoard> {
  const { node } = await publicNodeOf(deps, token, q);
  if (node.type !== 'board') throw new AppError('bad_request', { reason: 'not_a_board' });
  if (!(await boardsEnabled(deps.db, node.orgId))) throw new AppError('not_found');
  const [board] = await deps.db.select().from(boards).where(eq(boards.nodeId, node.id));
  if (!board) throw new AppError('not_found');
  const columns = await deps.db
    .select()
    .from(boardColumns)
    .where(eq(boardColumns.boardNodeId, node.id))
    .orderBy(asc(boardColumns.position));
  const rows = await deps.db
    .select({ card: boardCards })
    .from(boardCards)
    .innerJoin(boardColumns, eq(boardColumns.id, boardCards.columnId))
    .where(
      and(
        eq(boardCards.boardNodeId, node.id),
        isNull(boardCards.archivedAt),
        isNull(boardCards.deletedAt),
      ),
    )
    .orderBy(asc(boardColumns.position), asc(boardCards.position))
    .limit(BOARD_LIMITS.cardsPerBoard);
  const cards = await toCards(
    deps.db,
    rows.map((r) => r.card),
  );
  return {
    id: node.id,
    name: node.name,
    key: board.settings.key,
    labels: board.settings.labels.flatMap((l) => {
      const label = BoardLabel.safeParse(l);
      return label.success ? [label.data] : [];
    }),
    columns: columns.map((c) => ({ id: c.id, name: c.name, isDone: c.isDone })),
    cards: cards.map((c) => ({
      id: c.id,
      columnId: c.columnId,
      number: c.number,
      title: c.title,
      labels: c.labels,
      dueAt: c.dueAt,
      priority: c.priority,
      checklist: c.checklist,
      doneAt: c.doneAt,
    })),
    updatedAt: node.updatedAt.toISOString(),
  };
}
