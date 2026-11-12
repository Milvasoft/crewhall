import { and, asc, count, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import {
  boardCardActivity,
  boardCardAttachments,
  boardCardFollowers,
  boardCards,
  boardColumns,
  boards,
  cardAssignees,
  nodes,
  type DbOrTx,
} from '@crewhall/db';
import { checkDlp } from '../compliance/policy';
import {
  BOARD_LIMITS,
  type BoardActivity,
  type BoardCard,
  type BoardCardDetail,
  type CreateBoardCard,
  type MoveResult,
  type MyBoardCard,
  type SpaceRole,
  type UpdateBoardCard,
  paths,
} from '@crewhall/shared';
import type { z } from 'zod';
import { AppError } from '../../http/errors';
import type { RequestInfo } from '../../http/types';
import { keyBetween } from '../../util/position';
import { audit } from '../audit';
import {
  loadNode,
  reachableSpaceIds,
  roleForPath,
  spaceRoleOf,
  userSharePaths,
  type DriveActor,
} from '../drive/access';
import {
  atLeast,
  loadBoard,
  loadCard,
  nodeAudience,
  requireRole,
  touchBoard,
  userSummaries,
  type BoardAccess,
  type CardRow,
} from './access';
import { announce, placeBetween, toCards } from './boards';
import { integrations, type BoardNotification } from './integrations';
import { linksOf } from './links';
import { activeSprint, assertSprintTarget } from './sprints';
import { descriptionOfState, descriptionText, docFrom, encode, setDescription } from './ydoc';

type ActivityData = Record<string, string | number | boolean | null>;

export const cardKey = (access: Pick<BoardAccess, 'board'>, card: Pick<CardRow, 'number'>) =>
  `${access.board.settings.key}-${card.number}`;

export const cardUrl = (boardId: string, key: string) => paths.boardCard(boardId, key);

/* --------------------------------- helpers --------------------------------- */

async function columnOf(db: DbOrTx, boardId: string, columnId: string) {
  const [col] = await db
    .select()
    .from(boardColumns)
    .where(and(eq(boardColumns.id, columnId), eq(boardColumns.boardNodeId, boardId)));
  if (!col) throw new AppError('invalid_target', { reason: 'unknown_column' });
  return col;
}

async function cardsInColumn(db: DbOrTx, columnId: string) {
  return db
    .select({ id: boardCards.id, position: boardCards.position })
    .from(boardCards)
    .where(and(eq(boardCards.columnId, columnId), isNull(boardCards.deletedAt)))
    .orderBy(asc(boardCards.position));
}

/** Open (not archived) cards of a column, for the WIP count. */
async function openCount(db: DbOrTx, columnId: string) {
  const [row] = await db
    .select({ n: count() })
    .from(boardCards)
    .where(
      and(
        eq(boardCards.columnId, columnId),
        isNull(boardCards.archivedAt),
        isNull(boardCards.deletedAt),
      ),
    );
  return Number(row?.n ?? 0);
}

/** A start after the due date makes no bar. */
function assertRange(startAt: string | null, dueAt: string | null) {
  if (startAt && dueAt && Date.parse(startAt) > Date.parse(dueAt)) {
    throw new AppError('validation_failed', { field: 'startAt' });
  }
}

function assertLabels(access: BoardAccess, labels: string[]) {
  const known = new Set(access.board.settings.labels.map((l) => l.id));
  const bad = labels.find((l) => !known.has(l));
  if (bad) throw new AppError('board_label_unknown', { label: bad });
}

async function assertAssignable(db: DbOrTx, access: BoardAccess, userIds: string[]) {
  if (userIds.length === 0) return;
  const audience = new Set((await nodeAudience(db, access.node)).map((u) => u.id));
  const bad = userIds.find((u) => !audience.has(u));
  if (bad) throw new AppError('board_assignee_not_member', { userId: bad });
}

async function logActivity(
  db: DbOrTx,
  access: BoardAccess,
  card: CardRow,
  entry: {
    kind: BoardActivity['kind'];
    actorId: string | null;
    data?: ActivityData;
    text?: string;
  },
) {
  const [row] = await db
    .insert(boardCardActivity)
    .values({
      orgId: card.orgId,
      cardId: card.id,
      actorId: entry.actorId,
      kind: entry.kind,
      text: entry.text ?? null,
      data: entry.data ?? {},
    })
    .returning();
  const post = integrations().postCardSystemLine;
  if (post && card.conversationId && entry.kind !== 'comment') {
    await post(db, card.conversationId, {
      kind: entry.kind,
      actorId: entry.actorId,
      data: { ...(entry.data ?? {}), key: cardKey(access, card) },
    });
  }
  return row!;
}

async function follow(db: DbOrTx, card: CardRow, userIds: string[]) {
  if (userIds.length === 0) return;
  await db
    .insert(boardCardFollowers)
    .values(userIds.map((userId) => ({ cardId: card.id, userId, orgId: card.orgId })))
    .onConflictDoNothing();
  // Followers are the members of the card's conversation.
  if (card.conversationId) {
    await integrations().addConversationMembers(db, card.conversationId, card.orgId, userIds);
  }
}

async function followers(db: DbOrTx, cardId: string) {
  return db
    .select({ userId: boardCardFollowers.userId, muted: boardCardFollowers.muted })
    .from(boardCardFollowers)
    .where(eq(boardCardFollowers.cardId, cardId));
}

function notification(
  access: BoardAccess,
  card: CardRow,
  input: Pick<BoardNotification, 'userId' | 'type' | 'actorId'> & { data?: ActivityData },
): BoardNotification {
  const key = cardKey(access, card);
  return {
    orgId: card.orgId,
    spaceId: access.space.id,
    cardId: card.id,
    conversationId: card.conversationId,
    url: cardUrl(access.node.id, key),
    ...input,
    data: {
      key,
      title: card.title,
      boardName: access.node.name,
      ...(input.data ?? {}),
    },
  };
}

async function changed(db: DbOrTx, a: DriveActor, access: BoardAccess) {
  announce(access.node, await touchBoard(db, access.node.id, a.userId));
}

async function reload(db: DbOrTx, id: string) {
  const [row] = await db.select().from(boardCards).where(eq(boardCards.id, id));
  return row!;
}

/* ------------------------------ create and read ------------------------------ */

export async function createCard(
  db: DbOrTx,
  a: DriveActor,
  boardId: string,
  input: z.output<typeof CreateBoardCard>,
): Promise<BoardCard> {
  const access = await loadBoard(db, a, boardId, { forUpdate: true });
  requireRole(a, access.role, 'edit');
  await checkDlp(
    db,
    {
      orgId: a.org.id,
      actorId: a.userId,
      surface: 'board_card',
      targetType: 'board',
      targetId: boardId,
    },
    `${input.title}\n${input.description ?? ''}`,
  );
  const col = await columnOf(db, boardId, input.columnId);
  assertLabels(access, input.labels);
  assertRange(input.startAt ?? null, input.dueAt);
  const assigneeIds = [...new Set(input.assigneeIds)];
  await assertAssignable(db, access, assigneeIds);
  const [{ n } = { n: 0 }] = await db
    .select({ n: count() })
    .from(boardCards)
    .where(and(eq(boardCards.boardNodeId, boardId), isNull(boardCards.deletedAt)));
  if (Number(n) >= BOARD_LIMITS.cardsPerBoard) {
    throw new AppError('board_limit_reached', { cards: BOARD_LIMITS.cardsPerBoard });
  }

  const [seq] = await db
    .update(boards)
    .set({ cardSeq: sql`${boards.cardSeq} + 1` })
    .where(eq(boards.nodeId, boardId))
    .returning({ n: boards.cardSeq });
  const position = placeBetween(await cardsInColumn(db, col.id), input, undefined, input.top);
  // Cards made on the board join the running sprint; planning passes one, or null (backlog).
  let sprintId: string | null = null;
  if (input.sprintId === undefined) sprintId = (await activeSprint(db, boardId))?.id ?? null;
  else if (input.sprintId !== null) {
    await assertSprintTarget(db, boardId, input.sprintId);
    sprintId = input.sprintId;
  }
  let descYdoc: Buffer | null = null;
  let descText = '';
  if (input.description) {
    const doc = docFrom(null);
    setDescription(doc, input.description);
    descYdoc = encode(doc);
    descText = descriptionText(doc);
  }
  const [card] = await db
    .insert(boardCards)
    .values({
      orgId: a.org.id,
      boardNodeId: boardId,
      columnId: col.id,
      number: seq!.n,
      position,
      title: input.title,
      descYdoc,
      descText,
      labels: input.labels,
      dueAt: input.dueAt ? new Date(input.dueAt) : null,
      startAt: input.startAt ? new Date(input.startAt) : null,
      doneAt: col.isDone ? new Date() : null,
      sprintId,
      sprintAddedAt: sprintId ? new Date() : null,
      createdBy: a.userId,
      updatedBy: a.userId,
    })
    .returning();
  if (assigneeIds.length) {
    await db.insert(cardAssignees).values(
      assigneeIds.map((userId) => ({
        cardId: card!.id,
        userId,
        orgId: a.org.id,
        assignedBy: a.userId,
      })),
    );
  }
  await follow(db, card!, [a.userId, ...assigneeIds]);
  await logActivity(db, access, card!, {
    kind: 'created',
    actorId: a.userId,
    data: { column: col.name },
  });
  await integrations().notify(
    db,
    assigneeIds
      .filter((u) => u !== a.userId)
      .map((userId) =>
        notification(access, card!, { userId, type: 'boards.assigned', actorId: a.userId }),
      ),
  );
  await changed(db, a, access);
  return (await toCards(db, [card!]))[0]!;
}

async function detailOf(
  db: DbOrTx,
  a: DriveActor,
  access: BoardAccess,
  card: CardRow,
): Promise<BoardCardDetail> {
  const [base] = await toCards(db, [card]);
  const attachmentRows = await db
    .select({ att: boardCardAttachments, node: nodes })
    .from(boardCardAttachments)
    .innerJoin(nodes, eq(nodes.id, boardCardAttachments.nodeId))
    .where(and(eq(boardCardAttachments.cardId, card.id), isNull(nodes.deletedAt)))
    .orderBy(asc(boardCardAttachments.createdAt));
  const people = await userSummaries(
    db,
    attachmentRows.map((r) => r.att.addedBy),
  );
  const f = await followers(db, card.id);
  const live = f.filter((x) => !x.muted).map((x) => x.userId);
  return {
    ...base!,
    description: card.descYdoc ? descriptionOfState(card.descYdoc) : card.descText,
    checklistItems: card.checklist.map((i) => ({ ...i, assigneeId: i.assigneeId ?? null })),
    attachments: attachmentRows.map((r) => ({
      nodeId: r.node.id,
      name: r.node.name,
      type: r.node.type,
      mime: r.node.mime,
      sizeBytes: r.node.sizeBytes,
      addedBy: r.att.addedBy ? (people.get(r.att.addedBy) ?? null) : null,
      addedAt: r.att.createdAt.toISOString(),
    })),
    followerIds: live,
    following: live.includes(a.userId),
    links: await linksOf(db, a, card.id),
    board: {
      id: access.node.id,
      name: access.node.name,
      key: access.board.settings.key,
      spaceId: access.space.id,
      myRole: (access.role ?? 'viewer') as SpaceRole,
    },
  };
}

export async function cardDetail(db: DbOrTx, a: DriveActor, cardId: string) {
  const { card, ...access } = await loadCard(db, a, cardId);
  return detailOf(db, a, access, card);
}

export async function cardByNumber(db: DbOrTx, a: DriveActor, boardId: string, ref: string) {
  // "142" or "MLV-142".
  const m = /^(?:[A-Za-z][A-Za-z0-9]{0,5}-)?(\d{1,9})$/.exec(ref);
  if (!m) throw new AppError('not_found');
  const access = await loadBoard(db, a, boardId);
  const [card] = await db
    .select()
    .from(boardCards)
    .where(
      and(
        eq(boardCards.boardNodeId, boardId),
        eq(boardCards.number, Number(m[1])),
        isNull(boardCards.deletedAt),
      ),
    );
  if (!card) throw new AppError('not_found');
  return detailOf(db, a, access, card);
}

/* ---------------------------------- update ---------------------------------- */

export async function updateCard(
  db: DbOrTx,
  a: DriveActor,
  cardId: string,
  input: z.output<typeof UpdateBoardCard>,
): Promise<BoardCardDetail> {
  const { card, ...access } = await loadCard(db, a, cardId);
  requireRole(a, access.role, 'edit');
  const changedText = [input.title, (input as { description?: string | null }).description]
    .filter((v): v is string => typeof v === 'string')
    .join('\n');
  await checkDlp(
    db,
    {
      orgId: a.org.id,
      actorId: a.userId,
      surface: 'board_card',
      targetType: 'board_card',
      targetId: cardId,
    },
    changedText,
  );
  const set: Partial<typeof boardCards.$inferInsert> = { updatedBy: a.userId };
  const lines: { kind: BoardActivity['kind']; data?: ActivityData }[] = [];

  if (input.title !== undefined && input.title !== card.title) {
    set.title = input.title;
    lines.push({ kind: 'renamed', data: { from: card.title, to: input.title } });
  }
  if (input.description !== undefined) {
    const doc = docFrom(card.descYdoc);
    setDescription(doc, input.description);
    set.descYdoc = encode(doc);
    set.descText = descriptionText(doc);
  }
  if (input.labels !== undefined) {
    assertLabels(access, input.labels);
    set.labels = [...new Set(input.labels)];
  }
  if (input.dueAt !== undefined) {
    const next = input.dueAt ? new Date(input.dueAt) : null;
    if ((next?.getTime() ?? null) !== (card.dueAt?.getTime() ?? null)) {
      set.dueAt = next;
      set.dueNotifiedAt = null;
      lines.push({ kind: 'due_changed', data: { dueAt: next?.toISOString() ?? null } });
    }
  }
  if (input.startAt !== undefined) set.startAt = input.startAt ? new Date(input.startAt) : null;
  assertRange(
    input.startAt !== undefined ? input.startAt : (card.startAt?.toISOString() ?? null),
    input.dueAt !== undefined ? input.dueAt : (card.dueAt?.toISOString() ?? null),
  );
  if (input.points !== undefined) set.points = input.points;
  if (input.priority !== undefined) set.priority = input.priority;
  if (input.estimateMinutes !== undefined) set.estimateMinutes = input.estimateMinutes;
  if (input.sprintId !== undefined && input.sprintId !== card.sprintId) {
    if (input.sprintId) await assertSprintTarget(db, access.node.id, input.sprintId);
    set.sprintId = input.sprintId;
    set.sprintAddedAt = input.sprintId ? new Date() : null;
  }
  if (input.checklistItems !== undefined) {
    const ids = new Set(input.checklistItems.map((i) => i.id));
    if (ids.size !== input.checklistItems.length) {
      throw new AppError('validation_failed', { field: 'checklistItems' });
    }
    const before = card.checklist.filter((i) => i.done).length;
    const after = input.checklistItems.filter((i) => i.done).length;
    set.checklist = input.checklistItems.map((i) => ({ ...i, assigneeId: i.assigneeId ?? null }));
    if (after > before) {
      lines.push({
        kind: 'checklist_done',
        data: { count: after - before, done: after, total: input.checklistItems.length },
      });
    }
  }
  if (input.archived !== undefined && input.archived !== (card.archivedAt !== null)) {
    set.archivedAt = input.archived ? new Date() : null;
    lines.push({ kind: input.archived ? 'archived' : 'restored' });
  }
  await db.update(boardCards).set(set).where(eq(boardCards.id, cardId));
  const updated = await reload(db, cardId);
  for (const l of lines) await logActivity(db, access, updated, { ...l, actorId: a.userId });
  await changed(db, a, access);
  return detailOf(db, a, access, updated);
}

/** Server-side fractional position (doc 17 §13 move_board_card); WIP is a warning only. */
export async function moveCard(
  db: DbOrTx,
  a: DriveActor,
  cardId: string,
  input: { columnId: string; afterId: string | null; beforeId: string | null },
): Promise<MoveResult> {
  const { card, ...access } = await loadCard(db, a, cardId);
  const locked = await loadBoard(db, a, access.node.id, { forUpdate: true });
  requireRole(a, locked.role, 'edit');
  const target = await columnOf(db, access.node.id, input.columnId);
  const position = placeBetween(await cardsInColumn(db, target.id), input, card.id);
  const columnChanged = target.id !== card.columnId;
  await db
    .update(boardCards)
    .set({
      columnId: target.id,
      position,
      updatedBy: a.userId,
      ...(columnChanged ? { doneAt: target.isDone ? new Date() : null } : {}),
    })
    .where(eq(boardCards.id, cardId));
  const updated = await reload(db, cardId);
  if (columnChanged) {
    const [from] = await db
      .select({ name: boardColumns.name })
      .from(boardColumns)
      .where(eq(boardColumns.id, card.columnId));
    await logActivity(db, locked, updated, {
      kind: 'moved',
      actorId: a.userId,
      data: { from: from?.name ?? '', to: target.name, done: target.isDone },
    });
  }
  await changed(db, a, locked);
  const n = await openCount(db, target.id);
  return {
    card: (await toCards(db, [updated]))[0]!,
    wip: {
      count: n,
      limit: target.wipLimit,
      exceeded: target.wipLimit !== null && n > target.wipLimit,
    },
  };
}

export async function deleteCard(db: DbOrTx, a: DriveActor, cardId: string, req: RequestInfo) {
  const { card, ...access } = await loadCard(db, a, cardId);
  requireRole(a, access.role, 'edit');
  await db
    .update(boardCards)
    .set({ deletedAt: new Date(), updatedBy: a.userId })
    .where(eq(boardCards.id, cardId));
  await audit(
    db,
    {
      orgId: a.org.id,
      actorId: a.userId,
      action: 'board.card.delete',
      targetType: 'board_card',
      targetId: card.id,
      meta: { boardId: access.node.id, key: cardKey(access, card), title: card.title },
    },
    req,
  );
  await changed(db, a, access);
}

export async function restoreCard(db: DbOrTx, a: DriveActor, cardId: string, req: RequestInfo) {
  const { card, ...access } = await loadCard(db, a, cardId, { includeDeleted: true });
  requireRole(a, access.role, 'edit');
  if (card.deletedAt) {
    await db.update(boardCards).set({ deletedAt: null }).where(eq(boardCards.id, cardId));
    await audit(
      db,
      {
        orgId: a.org.id,
        actorId: a.userId,
        action: 'board.card.restore',
        targetType: 'board_card',
        targetId: card.id,
        meta: { boardId: access.node.id },
      },
      req,
    );
    await changed(db, a, access);
  }
  return (await toCards(db, [await reload(db, cardId)]))[0]!;
}

export async function bulkUpdate(
  db: DbOrTx,
  a: DriveActor,
  boardId: string,
  input: {
    cardIds: string[];
    columnId?: string | undefined;
    addAssigneeIds?: string[] | undefined;
    addLabels?: string[] | undefined;
    archive?: boolean | undefined;
    sprintId?: string | null | undefined;
  },
) {
  const access = await loadBoard(db, a, boardId, { forUpdate: true });
  requireRole(a, access.role, 'edit');
  const rows = await db
    .select()
    .from(boardCards)
    .where(
      and(
        eq(boardCards.boardNodeId, boardId),
        inArray(boardCards.id, input.cardIds),
        isNull(boardCards.deletedAt),
      ),
    )
    .orderBy(asc(boardCards.position));
  if (input.addLabels) assertLabels(access, input.addLabels);
  if (input.addAssigneeIds) await assertAssignable(db, access, input.addAssigneeIds);
  if (input.sprintId) await assertSprintTarget(db, boardId, input.sprintId);
  const target = input.columnId ? await columnOf(db, boardId, input.columnId) : null;
  let pos: string | null = null;
  if (target) {
    const existing = await cardsInColumn(db, target.id);
    pos = existing.filter((c) => !input.cardIds.includes(c.id)).at(-1)?.position ?? null;
  }
  const notes: BoardNotification[] = [];
  for (const card of rows) {
    const set: Partial<typeof boardCards.$inferInsert> = { updatedBy: a.userId };
    if (target) {
      pos = keyBetween(pos, null);
      set.position = pos;
      if (card.columnId !== target.id) {
        set.columnId = target.id;
        set.doneAt = target.isDone ? new Date() : null;
      }
    }
    if (input.addLabels) set.labels = [...new Set([...card.labels, ...input.addLabels])];
    if (input.archive !== undefined)
      set.archivedAt = input.archive ? (card.archivedAt ?? new Date()) : null;
    if (input.sprintId !== undefined && input.sprintId !== card.sprintId) {
      set.sprintId = input.sprintId;
      set.sprintAddedAt = input.sprintId ? new Date() : null;
    }
    await db.update(boardCards).set(set).where(eq(boardCards.id, card.id));
    if (target && card.columnId !== target.id) {
      await logActivity(db, access, card, {
        kind: 'moved',
        actorId: a.userId,
        data: { to: target.name, done: target.isDone },
      });
    }
    if (input.addAssigneeIds?.length) {
      const added = await db
        .insert(cardAssignees)
        .values(
          input.addAssigneeIds.map((userId) => ({
            cardId: card.id,
            userId,
            orgId: a.org.id,
            assignedBy: a.userId,
          })),
        )
        .onConflictDoNothing()
        .returning({ userId: cardAssignees.userId });
      await follow(
        db,
        card,
        added.map((r) => r.userId),
      );
      for (const r of added) {
        if (r.userId !== a.userId) {
          notes.push(
            notification(access, card, {
              userId: r.userId,
              type: 'boards.assigned',
              actorId: a.userId,
            }),
          );
        }
      }
    }
  }
  await integrations().notify(db, notes);
  await changed(db, a, access);
  return { updated: rows.length };
}

/* -------------------------------- assignment -------------------------------- */

export async function setAssignees(db: DbOrTx, a: DriveActor, cardId: string, userIds: string[]) {
  const { card, ...access } = await loadCard(db, a, cardId);
  requireRole(a, access.role, 'edit');
  const wanted = [...new Set(userIds)];
  await assertAssignable(db, access, wanted);
  const current = (
    await db
      .select({ userId: cardAssignees.userId })
      .from(cardAssignees)
      .where(eq(cardAssignees.cardId, cardId))
  ).map((r) => r.userId);
  const added = wanted.filter((u) => !current.includes(u));
  const removed = current.filter((u) => !wanted.includes(u));
  if (removed.length) {
    await db
      .delete(cardAssignees)
      .where(and(eq(cardAssignees.cardId, cardId), inArray(cardAssignees.userId, removed)));
  }
  if (added.length) {
    await db
      .insert(cardAssignees)
      .values(added.map((userId) => ({ cardId, userId, orgId: a.org.id, assignedBy: a.userId })))
      .onConflictDoNothing();
    await follow(db, card, added);
  }
  const people = await userSummaries(db, [...added, ...removed]);
  for (const u of added) {
    await logActivity(db, access, card, {
      kind: 'assigned',
      actorId: a.userId,
      data: { userId: u, userName: people.get(u)?.name ?? '' },
    });
  }
  for (const u of removed) {
    await logActivity(db, access, card, {
      kind: 'unassigned',
      actorId: a.userId,
      data: { userId: u, userName: people.get(u)?.name ?? '' },
    });
  }
  await integrations().notify(
    db,
    added
      .filter((u) => u !== a.userId)
      .map((userId) =>
        notification(access, card, { userId, type: 'boards.assigned', actorId: a.userId }),
      ),
  );
  if (added.length || removed.length) await changed(db, a, access);
  return (await toCards(db, [await reload(db, cardId)]))[0]!;
}

export async function setFollowing(db: DbOrTx, a: DriveActor, cardId: string, following: boolean) {
  const { card } = await loadCard(db, a, cardId);
  await db
    .insert(boardCardFollowers)
    .values({ cardId: card.id, userId: a.userId, orgId: card.orgId, muted: !following })
    .onConflictDoUpdate({
      target: [boardCardFollowers.cardId, boardCardFollowers.userId],
      set: { muted: !following },
    });
  if (following && card.conversationId) {
    await integrations().addConversationMembers(db, card.conversationId, card.orgId, [a.userId]);
  }
}

/* --------------------------------- activity --------------------------------- */

function toActivity(
  row: typeof boardCardActivity.$inferSelect,
  people: Map<string, BoardActivity['actor'] & object>,
): BoardActivity {
  return {
    id: row.id,
    cardId: row.cardId,
    kind: row.kind as BoardActivity['kind'],
    actor: row.actorId ? (people.get(row.actorId) ?? null) : null,
    text: row.deletedAt ? null : row.text,
    data: row.data,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt?.toISOString() ?? null,
  };
}

export async function listActivity(
  db: DbOrTx,
  a: DriveActor,
  cardId: string,
  q: { cursor?: string | undefined; limit: number },
) {
  await loadCard(db, a, cardId);
  const conds = [eq(boardCardActivity.cardId, cardId), isNull(boardCardActivity.deletedAt)];
  // Oldest first, paged forward: the card pane reads like a conversation.
  if (q.cursor) {
    const [at, id] = parseCursor(q.cursor);
    conds.push(
      or(
        gt(boardCardActivity.createdAt, new Date(at)),
        and(eq(boardCardActivity.createdAt, new Date(at)), gt(boardCardActivity.id, id)),
      )!,
    );
  }
  const rows = await db
    .select()
    .from(boardCardActivity)
    .where(and(...conds))
    .orderBy(asc(boardCardActivity.createdAt), asc(boardCardActivity.id))
    .limit(q.limit + 1);
  const pageRows = rows.slice(0, q.limit);
  const people = await userSummaries(
    db,
    pageRows.map((r) => r.actorId),
  );
  const last = pageRows.at(-1);
  return {
    items: pageRows.map((r) => toActivity(r, people)),
    nextCursor:
      rows.length > q.limit && last
        ? Buffer.from(JSON.stringify([last.createdAt.toISOString(), last.id])).toString('base64url')
        : null,
  };
}

function parseCursor(cursor: string): [string, string] {
  try {
    const v: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'string')
      return [v[0], v[1]];
  } catch {
    // fall through
  }
  throw new AppError('bad_request', { reason: 'invalid_cursor' });
}

export async function addComment(db: DbOrTx, a: DriveActor, cardId: string, text: string) {
  const { card, ...access } = await loadCard(db, a, cardId);
  requireRole(a, access.role, 'comment');
  await checkDlp(
    db,
    {
      orgId: a.org.id,
      actorId: a.userId,
      surface: 'board_comment',
      targetType: 'board_card',
      targetId: cardId,
    },
    text,
  );
  const row = await logActivity(db, access, card, { kind: 'comment', actorId: a.userId, text });
  await db
    .update(boardCards)
    .set({ commentCount: sql`${boardCards.commentCount} + 1` })
    .where(eq(boardCards.id, cardId));
  await follow(db, card, [a.userId]);
  const recipients = (await followers(db, cardId)).filter((f) => !f.muted && f.userId !== a.userId);
  await integrations().notify(
    db,
    recipients.map((f) =>
      notification(access, card, {
        userId: f.userId,
        type: 'boards.comment',
        actorId: a.userId,
        data: { excerpt: text.slice(0, 140) },
      }),
    ),
  );
  await changed(db, a, access);
  return toActivity(row, await userSummaries(db, [a.userId]));
}

export async function deleteComment(db: DbOrTx, a: DriveActor, activityId: string) {
  const [row] = await db
    .select()
    .from(boardCardActivity)
    .where(and(eq(boardCardActivity.id, activityId), eq(boardCardActivity.orgId, a.org.id)));
  if (!row || row.kind !== 'comment' || row.deletedAt) throw new AppError('not_found');
  const { ...access } = await loadCard(db, a, row.cardId);
  // Own comments; space admins may remove anyone's (doc 17 §5 chat rule).
  if (row.actorId !== a.userId && !atLeast(access.role, 'admin')) throw new AppError('forbidden');
  await db
    .update(boardCardActivity)
    .set({ deletedAt: new Date() })
    .where(eq(boardCardActivity.id, activityId));
  await db
    .update(boardCards)
    .set({ commentCount: sql`greatest(0, ${boardCards.commentCount} - 1)` })
    .where(eq(boardCards.id, row.cardId));
  await changed(db, a, access);
}

/* -------------------------------- attachments -------------------------------- */

export async function addAttachment(db: DbOrTx, a: DriveActor, cardId: string, nodeId: string) {
  const { card, ...access } = await loadCard(db, a, cardId);
  requireRole(a, access.role, 'edit');
  // The caller must see the node; other spaces are fine (it stays a reference).
  const target = await loadNode(db, a, nodeId);
  const inserted = await db
    .insert(boardCardAttachments)
    .values({ cardId, nodeId, orgId: a.org.id, addedBy: a.userId })
    .onConflictDoNothing()
    .returning();
  if (inserted.length) {
    await db
      .update(boardCards)
      .set({ attachmentCount: sql`${boardCards.attachmentCount} + 1` })
      .where(eq(boardCards.id, cardId));
    await logActivity(db, access, card, {
      kind: 'attachment_added',
      actorId: a.userId,
      data: { name: target.node.name, nodeId },
    });
    await changed(db, a, access);
  }
  return detailOf(db, a, access, await reload(db, cardId));
}

export async function removeAttachment(db: DbOrTx, a: DriveActor, cardId: string, nodeId: string) {
  const { ...access } = await loadCard(db, a, cardId);
  requireRole(a, access.role, 'edit');
  const removed = await db
    .delete(boardCardAttachments)
    .where(and(eq(boardCardAttachments.cardId, cardId), eq(boardCardAttachments.nodeId, nodeId)))
    .returning();
  if (removed.length) {
    await db
      .update(boardCards)
      .set({ attachmentCount: sql`greatest(0, ${boardCards.attachmentCount} - 1)` })
      .where(eq(boardCards.id, cardId));
    await changed(db, a, access);
  }
  return detailOf(db, a, access, await reload(db, cardId));
}

/* ------------------------------ card conversation ------------------------------ */

export async function openConversation(db: DbOrTx, a: DriveActor, cardId: string) {
  const { card, ...access } = await loadCard(db, a, cardId);
  requireRole(a, access.role, 'comment');
  if (card.conversationId) return { conversationId: card.conversationId };
  const open = integrations().openCardConversation;
  if (!open || !access.board.settings.cardChats) throw new AppError('boards_chat_unavailable');
  // One conversation per card even when two people open it at once.
  const [locked] = await db
    .select()
    .from(boardCards)
    .where(eq(boardCards.id, cardId))
    .for('update');
  if (locked?.conversationId) return { conversationId: locked.conversationId };
  const members = [
    ...new Set([
      a.userId,
      ...(await followers(db, cardId)).filter((f) => !f.muted).map((f) => f.userId),
    ]),
  ];
  const conversationId = await open(db, {
    orgId: card.orgId,
    spaceId: access.space.id,
    cardId,
    title: `${cardKey(access, card)} ${card.title}`,
    memberIds: members,
    createdBy: a.userId,
  });
  if (!conversationId) throw new AppError('boards_chat_unavailable');
  await db.update(boardCards).set({ conversationId }).where(eq(boardCards.id, cardId));
  await follow(db, { ...card, conversationId }, [a.userId]);
  return { conversationId };
}

/* ------------------------------ assigned to me ------------------------------ */

/**
 * Open cards assigned to the caller across every board they can see (quick access
 * "Bana atananlar", design 6.9); `due` narrows to cards due within 3 days or overdue.
 */
export async function myCards(
  db: DbOrTx,
  a: DriveActor,
  q: { scope: 'assigned' | 'due'; spaceId?: string | undefined; limit: number },
): Promise<{ items: MyBoardCard[] }> {
  const spaceIds = await reachableSpaceIds(db, a);
  if (spaceIds.length === 0) return { items: [] };
  const conds = [
    eq(cardAssignees.userId, a.userId),
    eq(boardCards.orgId, a.org.id),
    isNull(boardCards.archivedAt),
    isNull(boardCards.deletedAt),
    isNull(nodes.deletedAt),
    eq(boardColumns.isDone, false),
    inArray(nodes.spaceId, q.spaceId ? spaceIds.filter((s) => s === q.spaceId) : spaceIds),
  ];
  if (q.scope === 'due') {
    conds.push(lte(boardCards.dueAt, new Date(Date.now() + 3 * 86_400_000)));
  }
  const rows = await db
    .select({ card: boardCards, node: nodes, board: boards, column: boardColumns })
    .from(cardAssignees)
    .innerJoin(boardCards, eq(boardCards.id, cardAssignees.cardId))
    .innerJoin(boardColumns, eq(boardColumns.id, boardCards.columnId))
    .innerJoin(boards, eq(boards.nodeId, boardCards.boardNodeId))
    .innerJoin(nodes, eq(nodes.id, boardCards.boardNodeId))
    .where(and(...conds))
    .orderBy(sql`${boardCards.dueAt} asc nulls last`, desc(boardCards.updatedAt))
    .limit(q.limit * 2);

  // Visibility per space: membership or a share reaching the board.
  const roles = new Map<
    string,
    { role: SpaceRole | null; paths: Awaited<ReturnType<typeof userSharePaths>> }
  >();
  const visible = [];
  for (const r of rows) {
    let s = roles.get(r.node.spaceId);
    if (!s) {
      s = {
        role: await spaceRoleOf(db, r.node.spaceId, a.userId),
        paths: await userSharePaths(db, r.node.spaceId, a.userId),
      };
      roles.set(r.node.spaceId, s);
    }
    if (roleForPath(s.role, s.paths, r.node.path)) visible.push(r);
    if (visible.length >= q.limit) break;
  }
  const cards = await toCards(
    db,
    visible.map((r) => r.card),
  );
  return {
    items: visible.map((r, i) => ({
      ...cards[i]!,
      board: {
        id: r.node.id,
        name: r.node.name,
        key: r.board.settings.key,
        spaceId: r.node.spaceId,
      },
      column: { id: r.column.id, name: r.column.name, isDone: r.column.isDone },
    })),
  };
}
