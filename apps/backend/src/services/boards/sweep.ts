import { and, eq, gt, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { boardCards, boardColumns, boards, cardAssignees, nodes, type Db } from '@crewhall/db';
import type { Jobs } from '../../jobs/queue';
import type { Logger } from '../../logger';
import { cardUrl } from './cards';
import type { Bus } from '../../realtime/bus';
import { inBoardsTx, integrations, type BoardNotification } from './integrations';
import { staleThumbnails } from './thumbnail';
import { boardsEnabled } from './module';
import { pastTrashRetention } from '../trash/retention';
import { notHeld } from '../compliance/holds';

export interface SweepDeps {
  db: Db;
  jobs: Jobs;
  logger: Logger;
  bus: Bus;
}

/** "Son tarih yaklaştı" goes out once per due date, this long before it. */
export const DUE_SOON_MS = 24 * 60 * 60 * 1000;

/**
 * boards.sweep (every 10 minutes): due-soon notifications, auto-archive of cards resting
 * in a done column (design 6.6), purge of cards deleted 30 days ago, and thumbnails the
 * throttled path missed.
 */
export async function sweepBoards(deps: SweepDeps, now = new Date()) {
  const { db } = deps;
  const due = await db
    .select({ card: boardCards, node: nodes, board: boards })
    .from(boardCards)
    .innerJoin(boardColumns, eq(boardColumns.id, boardCards.columnId))
    .innerJoin(boards, eq(boards.nodeId, boardCards.boardNodeId))
    .innerJoin(nodes, eq(nodes.id, boardCards.boardNodeId))
    .where(
      and(
        isNotNull(boardCards.dueAt),
        lte(boardCards.dueAt, new Date(now.getTime() + DUE_SOON_MS)),
        gt(boardCards.dueAt, new Date(now.getTime() - DUE_SOON_MS)),
        isNull(boardCards.dueNotifiedAt),
        isNull(boardCards.archivedAt),
        isNull(boardCards.deletedAt),
        isNull(nodes.deletedAt),
        eq(boardColumns.isDone, false),
      ),
    )
    .limit(500);
  for (const r of due) {
    // Boards turned off: no due-soon notifications for that org.
    if (!(await boardsEnabled(db, r.card.orgId))) continue;
    await inBoardsTx(deps, async (tx) => {
      const assignees = await tx
        .select({ userId: cardAssignees.userId })
        .from(cardAssignees)
        .where(eq(cardAssignees.cardId, r.card.id));
      const key = `${r.board.settings.key}-${r.card.number}`;
      const inputs: BoardNotification[] = assignees.map((x) => ({
        orgId: r.card.orgId,
        userId: x.userId,
        type: 'boards.due_soon',
        actorId: null,
        cardId: r.card.id,
        spaceId: r.node.spaceId,
        conversationId: r.card.conversationId,
        url: cardUrl(r.node.id, key),
        data: {
          key,
          title: r.card.title,
          boardName: r.node.name,
          dueAt: r.card.dueAt!.toISOString(),
        },
      }));
      await integrations().notify(tx, inputs);
      await tx.update(boardCards).set({ dueNotifiedAt: now }).where(eq(boardCards.id, r.card.id));
    });
  }

  // Auto-archive: per board setting; cards whose done_at is older than the limit.
  const archived = await db.execute(sql`
    update ${boardCards} c set archived_at = ${now}
    from ${boards} b
    where b.node_id = c.board_node_id
      and c.archived_at is null and c.deleted_at is null and c.done_at is not null
      and (b.settings->>'doneArchiveDays') is not null
      and c.done_at < ${now}::timestamptz - make_interval(days => (b.settings->>'doneArchiveDays')::int)
  `);

  const purged = await db
    .delete(boardCards)
    .where(
      and(
        isNotNull(boardCards.deletedAt),
        pastTrashRetention(boardCards.deletedAt, boardCards.orgId, now),
        notHeld.boardCard(),
      ),
    )
    .returning({ id: boardCards.id });

  const stale = await staleThumbnails(db);
  for (const nodeId of stale) await deps.jobs.send('drawing.thumbnail', { nodeId });

  const result = {
    dueNotified: due.length,
    archived: archived.rowCount ?? 0,
    purged: purged.length,
    thumbnails: stale.length,
  };
  if (result.dueNotified || result.archived || result.purged) {
    deps.logger.info(result, 'boards sweep');
  }
  return result;
}
