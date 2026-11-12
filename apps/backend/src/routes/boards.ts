import { resolveLocale } from '@crewhall/i18n';
import { BOARDS_RAW_PATHS } from '@crewhall/shared';
import type { Router } from '../http/route';
import * as boards from '../services/boards/boards';
import * as cards from '../services/boards/cards';
import { createToken } from '../services/boards/collab';
import { publicBoard } from '../services/boards/public';
import { inBoardsTx } from '../services/boards/integrations';
import * as drawings from '../services/boards/drawings';
import * as links from '../services/boards/links';
import * as sprints from '../services/boards/sprints';
import * as time from '../services/boards/time';
import * as workload from '../services/boards/workload';
import { driveActor } from './drive';
import { cardColumn, cardMoved } from '../services/automations/sources';
import { AppError } from '../http/errors';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { boardCards } from '@crewhall/db';
import type { Deps } from '../deps';
import { emitPluginEvent } from '../services/plugins/events';

const isUuid = (v: string | undefined) => z.uuid().safeParse(v).success;

type CardChange =
  'created' | 'updated' | 'moved' | 'deleted' | 'restored' | 'assignees' | 'comment';

/** Plugins: a card changed. Ids only; soft-deleted cards still have their row. */
async function cardChanged(
  ctx: { deps: Deps; org: { id: string } },
  cardId: string,
  change: CardChange,
  extra: Record<string, string> = {},
) {
  const [row] = await ctx.deps.db
    .select({ boardId: boardCards.boardNodeId })
    .from(boardCards)
    .where(eq(boardCards.id, cardId));
  if (!row) return;
  await emitPluginEvent(ctx.deps, ctx.org.id, 'board.card.changed', {
    cardId,
    boardId: row.boardId,
    change,
    ...extra,
  });
}

/** Boards module routes. Owned by the boards session; endpoints come from packages/shared/src/endpoints/boards.ts. */
export function registerBoards(r: Router) {
  // ---- boards ----
  r.org('listBoards', async (ctx) =>
    boards.listBoards(ctx.deps.db, driveActor(ctx), ctx.params.spaceId),
  );
  r.org(
    'createBoard',
    async (ctx) =>
      inBoardsTx(ctx.deps, (tx) =>
        boards.createBoard(
          tx,
          driveActor(ctx),
          ctx.params.spaceId,
          ctx.body,
          resolveLocale(ctx.req.locale),
          ctx.req,
        ),
      ),
    { status: 201 },
  );
  r.org('getBoard', async (ctx) =>
    boards.boardDetail(ctx.deps.db, driveActor(ctx), ctx.params.boardId),
  );
  r.org('getBoardRev', async (ctx) =>
    boards.boardRev(ctx.deps.db, driveActor(ctx), ctx.params.boardId),
  );
  r.org('updateBoard', async (ctx) =>
    inBoardsTx(ctx.deps, (tx) =>
      boards.updateBoard(tx, driveActor(ctx), ctx.params.boardId, ctx.body, ctx.req),
    ),
  );
  r.org('listArchivedBoardCards', async (ctx) =>
    boards.listArchived(ctx.deps.db, driveActor(ctx), ctx.params.boardId, ctx.query),
  );
  r.org('getBoardAttachmentFolder', async (ctx) =>
    inBoardsTx(ctx.deps, (tx) =>
      boards.attachmentFolder(
        tx,
        driveActor(ctx),
        ctx.params.boardId,
        resolveLocale(ctx.req.locale),
      ),
    ),
  );

  // ---- columns ----
  r.org(
    'createBoardColumn',
    async (ctx) =>
      inBoardsTx(ctx.deps, (tx) =>
        boards.createColumn(tx, driveActor(ctx), ctx.params.boardId, ctx.body),
      ),
    { status: 201 },
  );
  r.org('updateBoardColumn', async (ctx) =>
    inBoardsTx(ctx.deps, (tx) =>
      boards.updateColumn(tx, driveActor(ctx), ctx.params.columnId, ctx.body),
    ),
  );
  r.org('moveBoardColumn', async (ctx) =>
    inBoardsTx(ctx.deps, (tx) =>
      boards.moveColumn(tx, driveActor(ctx), ctx.params.columnId, ctx.body),
    ),
  );
  r.org('deleteBoardColumn', async (ctx) => {
    await inBoardsTx(ctx.deps, (tx) =>
      boards.deleteColumn(tx, driveActor(ctx), ctx.params.columnId, ctx.query.moveTo),
    );
    return {};
  });

  // ---- cards ----
  r.org(
    'createBoardCard',
    async (ctx) => {
      const card = await inBoardsTx(ctx.deps, (tx) =>
        cards.createCard(tx, driveActor(ctx), ctx.params.boardId, ctx.body),
      );
      await cardChanged(ctx, card.id, 'created');
      return card;
    },
    { status: 201 },
  );
  r.org('getBoardCardByNumber', async (ctx) =>
    cards.cardByNumber(ctx.deps.db, driveActor(ctx), ctx.params.boardId, ctx.params.number),
  );
  r.org('getBoardCard', async (ctx) =>
    cards.cardDetail(ctx.deps.db, driveActor(ctx), ctx.params.cardId),
  );
  r.org('updateBoardCard', async (ctx) => {
    const card = await inBoardsTx(ctx.deps, (tx) =>
      cards.updateCard(tx, driveActor(ctx), ctx.params.cardId, ctx.body),
    );
    await cardChanged(ctx, ctx.params.cardId, 'updated');
    return card;
  });
  r.org('moveBoardCard', async (ctx) => {
    // Automations (roadmap 17) see the move once it committed.
    const from = await cardColumn(ctx.deps.db, ctx.params.cardId);
    const out = await inBoardsTx(ctx.deps, (tx) =>
      cards.moveCard(tx, driveActor(ctx), ctx.params.cardId, ctx.body),
    );
    await cardMoved(ctx.deps, driveActor(ctx), out.card, from);
    await cardChanged(ctx, ctx.params.cardId, 'moved');
    return out;
  });
  r.org('deleteBoardCard', async (ctx) => {
    await inBoardsTx(ctx.deps, (tx) =>
      cards.deleteCard(tx, driveActor(ctx), ctx.params.cardId, ctx.req),
    );
    await cardChanged(ctx, ctx.params.cardId, 'deleted');
    return {};
  });
  r.org('restoreBoardCard', async (ctx) => {
    const card = await inBoardsTx(ctx.deps, (tx) =>
      cards.restoreCard(tx, driveActor(ctx), ctx.params.cardId, ctx.req),
    );
    await cardChanged(ctx, ctx.params.cardId, 'restored');
    return card;
  });
  r.org('bulkUpdateBoardCards', async (ctx) => {
    const out = await inBoardsTx(ctx.deps, (tx) =>
      cards.bulkUpdate(tx, driveActor(ctx), ctx.params.boardId, ctx.body),
    );
    for (const id of ctx.body.cardIds) await cardChanged(ctx, id, 'updated');
    return out;
  });
  // ---- dependencies ----
  r.org('listBoardCardLinks', async (ctx) =>
    links.listLinks(ctx.deps.db, driveActor(ctx), ctx.params.cardId),
  );
  r.org('addBoardCardLink', async (ctx) =>
    inBoardsTx(ctx.deps, (tx) => links.addLink(tx, driveActor(ctx), ctx.params.cardId, ctx.body)),
  );
  r.org('removeBoardCardLink', async (ctx) => {
    await inBoardsTx(ctx.deps, (tx) => links.removeLink(tx, driveActor(ctx), ctx.params.linkId));
    return {};
  });
  r.org('searchBoardCards', async (ctx) =>
    links.searchCards(ctx.deps.db, driveActor(ctx), ctx.query),
  );

  // ---- time tracking ----
  r.org('listBoardCardTime', async (ctx) =>
    time.listTime(ctx.deps.db, driveActor(ctx), ctx.params.cardId),
  );
  r.org(
    'addBoardCardTime',
    async (ctx) =>
      inBoardsTx(ctx.deps, (tx) => time.addTime(tx, driveActor(ctx), ctx.params.cardId, ctx.body)),
    { status: 201 },
  );
  r.org(
    'startBoardCardTimer',
    async (ctx) =>
      inBoardsTx(ctx.deps, (tx) => time.startTimer(tx, driveActor(ctx), ctx.params.cardId)),
    { status: 201 },
  );
  r.org('getMyBoardTimer', async (ctx) => time.myTimer(ctx.deps.db, driveActor(ctx)));
  r.org('stopMyBoardTimer', async (ctx) =>
    inBoardsTx(ctx.deps, (tx) => time.stopTimer(tx, driveActor(ctx))),
  );
  r.org('updateBoardTimeEntry', async (ctx) =>
    inBoardsTx(ctx.deps, (tx) =>
      time.updateTime(tx, driveActor(ctx), ctx.params.entryId, ctx.body),
    ),
  );
  r.org('deleteBoardTimeEntry', async (ctx) => {
    await inBoardsTx(ctx.deps, (tx) => time.deleteTime(tx, driveActor(ctx), ctx.params.entryId));
    return {};
  });

  // ---- workload ----
  r.org('getBoardWorkload', async (ctx) =>
    workload.boardWorkload(ctx.deps.db, driveActor(ctx), ctx.params.boardId, ctx.query),
  );
  r.org('getSpaceBoardWorkload', async (ctx) =>
    workload.spaceWorkload(ctx.deps.db, driveActor(ctx), ctx.params.spaceId, ctx.query),
  );

  // ---- sprints ----
  r.org('listBoardSprints', async (ctx) =>
    sprints.listSprints(ctx.deps.db, driveActor(ctx), ctx.params.boardId),
  );
  r.org(
    'createBoardSprint',
    async (ctx) =>
      inBoardsTx(ctx.deps, (tx) =>
        sprints.createSprint(tx, driveActor(ctx), ctx.params.boardId, ctx.body),
      ),
    { status: 201 },
  );
  r.org('updateBoardSprint', async (ctx) =>
    inBoardsTx(ctx.deps, (tx) =>
      sprints.updateSprint(tx, driveActor(ctx), ctx.params.sprintId, ctx.body),
    ),
  );
  r.org('deleteBoardSprint', async (ctx) => {
    await inBoardsTx(ctx.deps, (tx) =>
      sprints.deleteSprint(tx, driveActor(ctx), ctx.params.sprintId),
    );
    return {};
  });
  r.org('startBoardSprint', async (ctx) =>
    inBoardsTx(ctx.deps, (tx) => sprints.startSprint(tx, driveActor(ctx), ctx.params.sprintId)),
  );
  r.org('closeBoardSprint', async (ctx) =>
    inBoardsTx(ctx.deps, (tx) =>
      sprints.closeSprint(tx, driveActor(ctx), ctx.params.sprintId, ctx.body.moveTo),
    ),
  );
  r.org('getBoardSprintBurndown', async (ctx) =>
    sprints.burndown(ctx.deps.db, driveActor(ctx), ctx.params.sprintId, ctx.query.tz),
  );

  r.org('setBoardCardAssignees', async (ctx) => {
    const card = await inBoardsTx(ctx.deps, (tx) =>
      cards.setAssignees(tx, driveActor(ctx), ctx.params.cardId, ctx.body.userIds),
    );
    await cardChanged(ctx, ctx.params.cardId, 'assignees');
    return card;
  });
  r.org('setBoardCardFollowing', async (ctx) => {
    await cards.setFollowing(ctx.deps.db, driveActor(ctx), ctx.params.cardId, ctx.body.following);
    return {};
  });
  r.org('listBoardCardActivity', async (ctx) =>
    cards.listActivity(ctx.deps.db, driveActor(ctx), ctx.params.cardId, ctx.query),
  );
  r.org(
    'addBoardCardComment',
    async (ctx) => {
      const activity = await inBoardsTx(ctx.deps, (tx) =>
        cards.addComment(tx, driveActor(ctx), ctx.params.cardId, ctx.body.text),
      );
      await cardChanged(ctx, ctx.params.cardId, 'comment', { activityId: activity.id });
      return activity;
    },
    { status: 201 },
  );
  r.org('deleteBoardCardComment', async (ctx) => {
    await inBoardsTx(ctx.deps, (tx) =>
      cards.deleteComment(tx, driveActor(ctx), ctx.params.activityId),
    );
    return {};
  });
  r.org('addBoardCardAttachment', async (ctx) =>
    inBoardsTx(ctx.deps, (tx) =>
      cards.addAttachment(tx, driveActor(ctx), ctx.params.cardId, ctx.body.nodeId),
    ),
  );
  r.org('removeBoardCardAttachment', async (ctx) =>
    inBoardsTx(ctx.deps, (tx) =>
      cards.removeAttachment(tx, driveActor(ctx), ctx.params.cardId, ctx.params.nodeId),
    ),
  );
  r.org('openBoardCardConversation', async (ctx) =>
    inBoardsTx(ctx.deps, (tx) => cards.openConversation(tx, driveActor(ctx), ctx.params.cardId)),
  );
  r.org('listMyBoardCards', async (ctx) => cards.myCards(ctx.deps.db, driveActor(ctx), ctx.query));

  // ---- drawings ----
  r.org('listDrawings', async (ctx) =>
    drawings.listDrawings(ctx.deps.db, driveActor(ctx), ctx.params.spaceId),
  );
  r.org(
    'createDrawing',
    async (ctx) =>
      inBoardsTx(ctx.deps, (tx) =>
        drawings.createDrawing(
          tx,
          driveActor(ctx),
          ctx.params.spaceId,
          ctx.body,
          resolveLocale(ctx.req.locale),
          ctx.req,
        ),
      ),
    { status: 201 },
  );
  r.org('getDrawing', async (ctx) =>
    drawings.getDrawing(ctx.deps.db, driveActor(ctx), ctx.params.nodeId),
  );
  r.org('getDrawingScene', async (ctx) =>
    drawings.getScene(ctx.deps.db, driveActor(ctx), ctx.params.nodeId),
  );
  r.org('saveDrawingScene', async (ctx) =>
    drawings.saveScene(ctx.deps, driveActor(ctx), ctx.params.nodeId, ctx.body.elements),
  );
  r.org(
    'uploadDrawingFile',
    async (ctx) => drawings.uploadFile(ctx.deps, driveActor(ctx), ctx.params.nodeId, ctx.body),
    { status: 201 },
  );
  r.org('getDrawingFileUrl', async (ctx) =>
    drawings.fileUrl(ctx.deps, driveActor(ctx), ctx.params.nodeId, ctx.params.file),
  );
  r.org('getDrawingLibrary', async (ctx) =>
    drawings.getLibrary(ctx.deps.db, driveActor(ctx), ctx.query.spaceId),
  );
  r.org('updateDrawingLibrary', async (ctx) =>
    drawings.updateLibrary(ctx.deps.db, driveActor(ctx), ctx.body),
  );
  r.rawOrg('GET', BOARDS_RAW_PATHS.drawingFile, async (ctx) => {
    if (!isUuid(ctx.c.req.param('nodeId'))) throw new AppError('not_found');
    const url = await drawings.fileUrl(
      ctx.deps,
      driveActor(ctx),
      ctx.c.req.param('nodeId') ?? '',
      ctx.c.req.param('file') ?? '',
    );
    return ctx.c.redirect(url.url, 302);
  });
  r.rawOrg('GET', BOARDS_RAW_PATHS.drawingThumbnail, async (ctx) => {
    if (!isUuid(ctx.c.req.param('nodeId'))) throw new AppError('not_found');
    const url = await drawings.thumbnailUrl(
      ctx.deps,
      driveActor(ctx),
      ctx.c.req.param('nodeId') ?? '',
      ctx.c.req.query('kind') === 'thumb_1024' ? 'thumb_1024' : 'thumb_256',
    );
    return ctx.c.redirect(url, 302);
  });

  // ---- public link (H15) ----
  r.public('getPublicBoard', async (ctx) => publicBoard(ctx.deps, ctx.params.token, ctx.query));

  // ---- collaboration ----
  r.org('createBoardsCollabToken', async (ctx) =>
    createToken(
      { db: ctx.deps.db, secret: ctx.deps.env.AUTH_SECRET, env: ctx.deps.env },
      driveActor(ctx),
      ctx.body.document,
    ),
  );
}
