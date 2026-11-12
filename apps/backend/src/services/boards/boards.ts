import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import {
  boardCards,
  boardColumns,
  boards,
  cardAssignees,
  newId,
  nodes,
  spaces,
  type BoardSettingsData,
  type DbOrTx,
} from '@crewhall/db';
import type { AppLocale } from '@crewhall/i18n';
import { resources } from '@crewhall/i18n';
import {
  BOARD_LIMITS,
  BoardSettings,
  isValidTimeZone,
  type Board,
  type BoardCard,
  type BoardColumn,
  type BoardDetail,
  type BoardSummary,
  type SpaceRole,
} from '@crewhall/shared';
import type { z } from 'zod';
import type {
  CreateBoard,
  CreateBoardColumn,
  UpdateBoard,
  UpdateBoardColumn,
} from '@crewhall/shared';
import { AppError } from '../../http/errors';
import type { RequestInfo } from '../../http/types';
import { keyBetween } from '../../util/position';
import { audit } from '../audit';
import { settingsFor } from '../calendar/settings';
import { loadSpace, requireNodeAction, type DriveActor } from '../drive/access';
import { container } from '../drive/nodes';
import { assertNameFree, childPath, nameTakenFrom, positionIn } from '../drive/tree';
import {
  canManage,
  loadBoard,
  nodeAudience,
  requireManage,
  requireRole,
  touchBoard,
  userSummaries,
  type BoardAccess,
  type CardRow,
} from './access';
import { integrations } from './integrations';
import { blockerCounts, boardDependencies } from './links';
import { spentMinutes } from './time';
import {
  activeSprint,
  legacySprint,
  openSprints,
  applyLegacySprint,
  type SprintRow,
} from './sprints';
import { deriveKey, templateColumns, templateSettings } from './templates';

type ColumnRow = typeof boardColumns.$inferSelect;

export const toColumn = (c: ColumnRow): BoardColumn => ({
  id: c.id,
  boardId: c.boardNodeId,
  name: c.name,
  position: c.position,
  wipLimit: c.wipLimit,
  isDone: c.isDone,
});

/** `active` fills the legacy `settings.sprint` (the sprints table is the source). */
export function toBoard(access: BoardAccess, a: DriveActor, active: SprintRow | null): Board {
  const { node, space, board, role } = access;
  return {
    id: node.id,
    spaceId: node.spaceId,
    parentId: node.parentId,
    name: node.name,
    settings: BoardSettings.parse({ ...board.settings, sprint: legacySprint(active) }),
    rev: board.rev,
    myRole: (role ?? 'viewer') as SpaceRole,
    canManage: canManage(a, access),
    space: { id: space.id, name: space.name, slug: space.slug, color: space.color },
    createdAt: node.createdAt.toISOString(),
    updatedAt: board.updatedAt.toISOString(),
  };
}

/** Cards with their assignees and creators, in the order given. */
export async function toCards(db: DbOrTx, rows: CardRow[]): Promise<BoardCard[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const assigneeRows = await db
    .select({ cardId: cardAssignees.cardId, userId: cardAssignees.userId })
    .from(cardAssignees)
    .where(inArray(cardAssignees.cardId, ids))
    .orderBy(asc(cardAssignees.createdAt));
  const people = await userSummaries(db, [
    ...assigneeRows.map((r) => r.userId),
    ...rows.map((r) => r.createdBy),
  ]);
  const blockers = await blockerCounts(db, ids);
  const spent = await spentMinutes(db, ids);
  const byCard = new Map<string, string[]>();
  for (const r of assigneeRows) byCard.set(r.cardId, [...(byCard.get(r.cardId) ?? []), r.userId]);
  return rows.map((r) => ({
    id: r.id,
    boardId: r.boardNodeId,
    columnId: r.columnId,
    number: r.number,
    position: r.position,
    title: r.title,
    excerpt: r.descText.slice(0, 280),
    labels: r.labels,
    assignees: (byCard.get(r.id) ?? []).map((u) => people.get(u)).filter((u) => !!u),
    startAt: r.startAt?.toISOString() ?? null,
    dueAt: r.dueAt?.toISOString() ?? null,
    points: r.points,
    priority: r.priority,
    checklist: {
      done: r.checklist.filter((i) => i.done).length,
      total: r.checklist.length,
    },
    commentCount: r.commentCount,
    attachmentCount: r.attachmentCount,
    conversationId: r.conversationId,
    sprintId: r.sprintId,
    blockedBy: blockers.get(r.id) ?? 0,
    estimateMinutes: r.estimateMinutes,
    spentMinutes: spent.get(r.id) ?? 0,
    doneAt: r.doneAt?.toISOString() ?? null,
    archivedAt: r.archivedAt?.toISOString() ?? null,
    createdBy: r.createdBy ? (people.get(r.createdBy) ?? null) : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

/** Tell clients the board changed (sent after commit by inBoardsTx / withBoardEvents). */
export function announce(node: { id: string; orgId: string; spaceId: string }, rev: number) {
  integrations().publish(
    { type: 'board.changed', boardId: node.id, rev },
    { orgId: node.orgId, spaceId: node.spaceId, nodeId: node.id },
  );
}

/* ---------------------------------- boards ---------------------------------- */

/** The zone the client sent, else the person's saved one (UTC when they have none). */
async function creatorZone(db: DbOrTx, a: DriveActor, tz: string | undefined) {
  if (tz && isValidTimeZone(tz)) return tz;
  return (await settingsFor(db, a.org.id, a.userId)).timeZone;
}

export async function createBoard(
  db: DbOrTx,
  a: DriveActor,
  spaceId: string,
  input: z.output<typeof CreateBoard>,
  locale: AppLocale,
  req: RequestInfo,
): Promise<Board> {
  const { space, parent, role } = await container(db, a, spaceId, input.parentId);
  requireNodeAction(a, role, 'space.edit_content');
  if (space.archivedAt) throw new AppError('forbidden', { reason: 'archived' });
  await assertNameFree(db, space.id, parent?.id ?? null, input.name);
  const id = newId();
  await db
    .insert(nodes)
    .values({
      id,
      orgId: a.org.id,
      spaceId: space.id,
      parentId: parent?.id ?? null,
      type: 'board',
      name: input.name,
      position: await positionIn(db, space.id, parent?.id ?? null),
      path: childPath(parent?.path ?? null, id),
      createdBy: a.userId,
      updatedBy: a.userId,
    })
    .catch(nameTakenFrom);
  const settings = templateSettings(input.template, locale, {
    key: input.key ?? deriveKey(input.name),
    cardChats: input.cardChats,
    ...(input.template === 'sprint' ? { timeZone: await creatorZone(db, a, input.tz) } : {}),
  });
  // The template's sprint becomes the board's first, running sprint.
  await db
    .insert(boards)
    .values({ nodeId: id, orgId: a.org.id, settings: { ...settings, sprint: null } });
  let pos: string | null = null;
  for (const col of templateColumns(input.template, locale)) {
    pos = keyBetween(pos, null);
    await db
      .insert(boardColumns)
      .values({ orgId: a.org.id, boardNodeId: id, position: pos, ...col });
  }
  await audit(
    db,
    {
      orgId: a.org.id,
      actorId: a.userId,
      action: 'board.create',
      targetType: 'node',
      targetId: id,
      meta: { spaceId: space.id, template: input.template },
    },
    req,
  );
  const access = await loadBoard(db, a, id);
  if (settings.sprint) await applyLegacySprint(db, a, access, settings.sprint);
  return toBoard(access, a, await activeSprint(db, id));
}

export async function listBoards(db: DbOrTx, a: DriveActor, spaceId: string) {
  const { role } = await loadSpace(db, a, spaceId);
  requireNodeAction(a, role, 'space.view');
  const rows = await db
    .select({ node: nodes, board: boards })
    .from(nodes)
    .innerJoin(boards, eq(boards.nodeId, nodes.id))
    .where(and(eq(nodes.spaceId, spaceId), eq(nodes.type, 'board'), isNull(nodes.deletedAt)))
    .orderBy(asc(nodes.name));
  const counts = rows.length
    ? await db
        .select({ boardId: boardCards.boardNodeId, n: count() })
        .from(boardCards)
        .where(
          and(
            inArray(
              boardCards.boardNodeId,
              rows.map((r) => r.node.id),
            ),
            isNull(boardCards.archivedAt),
            isNull(boardCards.deletedAt),
          ),
        )
        .groupBy(boardCards.boardNodeId)
    : [];
  const n = new Map(counts.map((c) => [c.boardId, Number(c.n)]));
  const items: BoardSummary[] = rows.map((r) => ({
    id: r.node.id,
    spaceId: r.node.spaceId,
    parentId: r.node.parentId,
    name: r.node.name,
    key: r.board.settings.key,
    cardCount: n.get(r.node.id) ?? 0,
    updatedAt: r.board.updatedAt.toISOString(),
  }));
  return { items };
}

export async function boardDetail(
  db: DbOrTx,
  a: DriveActor,
  boardId: string,
): Promise<BoardDetail> {
  const access = await loadBoard(db, a, boardId);
  const columns = await db
    .select()
    .from(boardColumns)
    .where(eq(boardColumns.boardNodeId, boardId))
    .orderBy(asc(boardColumns.position));
  const cardRows = await db
    .select({ card: boardCards })
    .from(boardCards)
    .innerJoin(boardColumns, eq(boardColumns.id, boardCards.columnId))
    .where(
      and(
        eq(boardCards.boardNodeId, boardId),
        isNull(boardCards.archivedAt),
        isNull(boardCards.deletedAt),
      ),
    )
    .orderBy(asc(boardColumns.position), asc(boardCards.position))
    .limit(BOARD_LIMITS.cardsPerBoard);
  const [archived] = await db
    .select({ n: count() })
    .from(boardCards)
    .where(
      and(
        eq(boardCards.boardNodeId, boardId),
        isNotNull(boardCards.archivedAt),
        isNull(boardCards.deletedAt),
      ),
    );
  return {
    board: toBoard(access, a, await activeSprint(db, boardId)),
    columns: columns.map(toColumn),
    cards: await toCards(
      db,
      cardRows.map((r) => r.card),
    ),
    archivedCount: Number(archived?.n ?? 0),
    people: await nodeAudience(db, access.node),
    sprints: await openSprints(db, boardId),
    dependencies: await boardDependencies(db, boardId),
  };
}

export async function boardRev(db: DbOrTx, a: DriveActor, boardId: string) {
  const access = await loadBoard(db, a, boardId);
  return { rev: access.board.rev };
}

export async function updateBoard(
  db: DbOrTx,
  a: DriveActor,
  boardId: string,
  input: z.output<typeof UpdateBoard>,
  req: RequestInfo,
): Promise<Board> {
  const access = await loadBoard(db, a, boardId, { forUpdate: true });
  requireRole(a, access.role, 'edit');
  const { name, ...rest } = input;
  if (name !== undefined && name !== access.node.name) {
    await assertNameFree(db, access.space.id, access.node.parentId, name, access.node.id);
    await db
      .update(nodes)
      .set({ name, updatedBy: a.userId })
      .where(eq(nodes.id, boardId))
      .catch(nameTakenFrom);
  }
  const settingKeys = Object.keys(rest).filter((k) => rest[k as keyof typeof rest] !== undefined);
  if (settingKeys.length) {
    requireManage(a, access);
    const settings: BoardSettingsData = { ...access.board.settings };
    if (rest.key !== undefined) settings.key = rest.key;
    if (rest.labels !== undefined) {
      const ids = new Set(rest.labels.map((l) => l.id));
      if (ids.size !== rest.labels.length)
        throw new AppError('validation_failed', { field: 'labels' });
      settings.labels = rest.labels;
    }
    if (rest.cardChats !== undefined) settings.cardChats = rest.cardChats;
    if (rest.fields !== undefined) settings.fields = rest.fields;
    if (rest.doneArchiveDays !== undefined) settings.doneArchiveDays = rest.doneArchiveDays;
    if (rest.capacityHours !== undefined) settings.capacityHours = rest.capacityHours;
    if (rest.sprint !== undefined) await applyLegacySprint(db, a, access, rest.sprint);
    await db.update(boards).set({ settings }).where(eq(boards.nodeId, boardId));
    // Cards drop labels that no longer exist.
    if (rest.labels !== undefined) {
      const keep = new Set(rest.labels.map((l) => l.id));
      const rows = await db
        .select({ id: boardCards.id, labels: boardCards.labels })
        .from(boardCards)
        .where(eq(boardCards.boardNodeId, boardId));
      for (const r of rows) {
        const labels = r.labels.filter((l) => keep.has(l));
        if (labels.length !== r.labels.length) {
          await db.update(boardCards).set({ labels }).where(eq(boardCards.id, r.id));
        }
      }
    }
    await audit(
      db,
      {
        orgId: a.org.id,
        actorId: a.userId,
        action: 'board.settings.update',
        targetType: 'node',
        targetId: boardId,
        meta: { fields: settingKeys },
      },
      req,
    );
  }
  const rev = await touchBoard(db, boardId, a.userId);
  announce(access.node, rev);
  return toBoard(await loadBoard(db, a, boardId), a, await activeSprint(db, boardId));
}

export async function listArchived(
  db: DbOrTx,
  a: DriveActor,
  boardId: string,
  q: { cursor?: string | undefined; limit: number },
) {
  await loadBoard(db, a, boardId);
  const conds = [
    eq(boardCards.boardNodeId, boardId),
    isNotNull(boardCards.archivedAt),
    isNull(boardCards.deletedAt),
  ];
  if (q.cursor) {
    const [at, id] = decodeCursor(q.cursor);
    conds.push(
      or(
        lt(boardCards.archivedAt, new Date(at)),
        and(eq(boardCards.archivedAt, new Date(at)), lt(boardCards.id, id)),
      )!,
    );
  }
  const rows = await db
    .select()
    .from(boardCards)
    .where(and(...conds))
    .orderBy(desc(boardCards.archivedAt), desc(boardCards.id))
    .limit(q.limit + 1);
  const pageRows = rows.slice(0, q.limit);
  const last = pageRows.at(-1);
  return {
    items: await toCards(db, pageRows),
    nextCursor:
      rows.length > q.limit && last
        ? Buffer.from(JSON.stringify([last.archivedAt!.toISOString(), last.id])).toString(
            'base64url',
          )
        : null,
  };
}

function decodeCursor(cursor: string): [string, string] {
  try {
    const v: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'string')
      return [v[0], v[1]];
  } catch {
    // fall through
  }
  throw new AppError('bad_request', { reason: 'invalid_cursor' });
}

/**
 * Card uploads go to a folder next to the board ("<board> · Ekler"), created on first use;
 * boards cannot hold children themselves.
 */
export async function attachmentFolder(
  db: DbOrTx,
  a: DriveActor,
  boardId: string,
  locale: AppLocale,
) {
  const access = await loadBoard(db, a, boardId);
  requireRole(a, access.role, 'edit');
  const name = resources[locale].email.boards.attachmentsFolder.replace(
    '{board}',
    access.node.name,
  );
  const parentId = access.node.parentId;
  // Found by its role (this board), wherever it sits and whatever it is called now; Drive does
  // not list it (system_role).
  const role = `board_attachments:${boardId}`;
  const [existing] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(eq(nodes.spaceId, access.space.id), eq(nodes.systemRole, role), isNull(nodes.deletedAt)),
    );
  if (existing) return { spaceId: access.space.id, folderId: existing.id };
  const parentPath = parentId
    ? ((await db.select({ path: nodes.path }).from(nodes).where(eq(nodes.id, parentId)))[0]?.path ??
      null)
    : null;
  const id = newId();
  await db.insert(nodes).values({
    id,
    orgId: a.org.id,
    spaceId: access.space.id,
    parentId,
    type: 'folder',
    name,
    systemRole: role,
    position: await positionIn(db, access.space.id, parentId, { afterId: boardId }),
    path: childPath(parentPath, id),
    createdBy: a.userId,
    updatedBy: a.userId,
  });
  return { spaceId: access.space.id, folderId: id };
}

/* ---------------------------------- columns ---------------------------------- */

async function columnsOf(db: DbOrTx, boardId: string) {
  return db
    .select()
    .from(boardColumns)
    .where(eq(boardColumns.boardNodeId, boardId))
    .orderBy(asc(boardColumns.position));
}

/** Fractional key between two neighbours of a sorted list (ids from the same list). */
export function placeBetween<T extends { id: string; position: string }>(
  list: T[],
  placement: { afterId: string | null; beforeId: string | null },
  selfId?: string,
  atTop = false,
): string {
  const others = list.filter((x) => x.id !== selfId);
  const find = (id: string | null) => {
    if (!id) return undefined;
    const i = others.findIndex((x) => x.id === id);
    if (i < 0) throw new AppError('invalid_target', { reason: 'unknown_neighbour', id });
    return i;
  };
  const ai = find(placement.afterId);
  const bi = find(placement.beforeId);
  let before: string | null;
  let after: string | null;
  if (ai !== undefined) {
    after = others[ai]!.position;
    before = others[ai + 1]?.position ?? null;
  } else if (bi !== undefined) {
    before = others[bi]!.position;
    after = others[bi - 1]?.position ?? null;
  } else if (atTop) {
    after = null;
    before = others[0]?.position ?? null;
  } else {
    after = others.at(-1)?.position ?? null;
    before = null;
  }
  return keyBetween(after, before);
}

export async function createColumn(
  db: DbOrTx,
  a: DriveActor,
  boardId: string,
  input: z.output<typeof CreateBoardColumn>,
) {
  const access = await loadBoard(db, a, boardId, { forUpdate: true });
  requireManage(a, access);
  const cols = await columnsOf(db, boardId);
  if (cols.length >= BOARD_LIMITS.columns)
    throw new AppError('board_limit_reached', { columns: BOARD_LIMITS.columns });
  const position = placeBetween(cols, input);
  const [row] = await db
    .insert(boardColumns)
    .values({
      orgId: a.org.id,
      boardNodeId: boardId,
      name: input.name,
      position,
      wipLimit: input.wipLimit,
      isDone: input.isDone,
    })
    .returning();
  announce(access.node, await touchBoard(db, boardId, a.userId));
  return toColumn(row!);
}

async function loadColumn(db: DbOrTx, a: DriveActor, columnId: string) {
  const [col] = await db
    .select()
    .from(boardColumns)
    .where(and(eq(boardColumns.id, columnId), eq(boardColumns.orgId, a.org.id)));
  if (!col) throw new AppError('not_found');
  const access = await loadBoard(db, a, col.boardNodeId, { forUpdate: true });
  return { col, access };
}

export async function updateColumn(
  db: DbOrTx,
  a: DriveActor,
  columnId: string,
  input: z.output<typeof UpdateBoardColumn>,
) {
  const { col, access } = await loadColumn(db, a, columnId);
  requireManage(a, access);
  const [row] = await db
    .update(boardColumns)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.wipLimit !== undefined ? { wipLimit: input.wipLimit } : {}),
      ...(input.isDone !== undefined ? { isDone: input.isDone } : {}),
    })
    .where(eq(boardColumns.id, columnId))
    .returning();
  if (input.isDone !== undefined && input.isDone !== col.isDone) {
    // done_at follows the column's flag for the cards already in it.
    await db
      .update(boardCards)
      .set({ doneAt: input.isDone ? new Date() : null })
      .where(eq(boardCards.columnId, columnId));
  }
  announce(access.node, await touchBoard(db, access.node.id, a.userId));
  return toColumn(row!);
}

export async function moveColumn(
  db: DbOrTx,
  a: DriveActor,
  columnId: string,
  placement: { afterId: string | null; beforeId: string | null },
) {
  const { access } = await loadColumn(db, a, columnId);
  requireManage(a, access);
  const position = placeBetween(await columnsOf(db, access.node.id), placement, columnId);
  const [row] = await db
    .update(boardColumns)
    .set({ position })
    .where(eq(boardColumns.id, columnId))
    .returning();
  announce(access.node, await touchBoard(db, access.node.id, a.userId));
  return toColumn(row!);
}

export async function deleteColumn(
  db: DbOrTx,
  a: DriveActor,
  columnId: string,
  moveTo: string | undefined,
) {
  const { col, access } = await loadColumn(db, a, columnId);
  requireManage(a, access);
  const cols = await columnsOf(db, access.node.id);
  if (cols.length <= 1) throw new AppError('board_last_column');
  const [n] = await db
    .select({ n: count() })
    .from(boardCards)
    .where(eq(boardCards.columnId, columnId));
  if (Number(n?.n ?? 0) > 0) {
    const target = moveTo ? cols.find((c) => c.id === moveTo && c.id !== columnId) : undefined;
    if (!target) throw new AppError('board_column_not_empty');
    // Moved cards go after the target's own, keeping their relative order.
    const [last] = await db
      .select({ p: sql<string | null>`max(${boardCards.position})` })
      .from(boardCards)
      .where(eq(boardCards.columnId, target.id));
    const moving = await db
      .select({ id: boardCards.id })
      .from(boardCards)
      .where(eq(boardCards.columnId, columnId))
      .orderBy(asc(boardCards.position));
    let pos = last?.p ?? null;
    for (const c of moving) {
      pos = keyBetween(pos, null);
      await db
        .update(boardCards)
        .set({ columnId: target.id, position: pos, doneAt: target.isDone ? new Date() : null })
        .where(eq(boardCards.id, c.id));
    }
  }
  await db.delete(boardColumns).where(eq(boardColumns.id, col.id));
  announce(access.node, await touchBoard(db, access.node.id, a.userId));
}

export { canManage };

/** Spaces of the cards' boards, for "assigned to me" (joined once). */
export async function spaceSlugs(db: DbOrTx, ids: string[]) {
  if (ids.length === 0) return new Map<string, string>();
  const rows = await db
    .select({ id: spaces.id, slug: spaces.slug })
    .from(spaces)
    .where(inArray(spaces.id, ids));
  return new Map(rows.map((r) => [r.id, r.slug]));
}
