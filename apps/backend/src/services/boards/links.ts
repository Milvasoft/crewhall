import { and, count, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { boardCardLinks, boardCards, boardColumns, boards, nodes, type DbOrTx } from '@crewhall/db';
import type { CardLink, CardLinkKind, CardLinkType, LinkedCard, SpaceRole } from '@crewhall/shared';
import { AppError } from '../../http/errors';
import {
  reachableSpaceIds,
  roleForPath,
  spaceRoleOf,
  userSharePaths,
  type DriveActor,
} from '../drive/access';
import { loadCard, requireRole, touchBoard, type CardRow } from './access';
import { announce } from './boards';

/**
 * Card dependencies (kararlar 2026-10-29). A row reads "from <kind> to": A blocks B,
 * A relates to B, A duplicates B (the original). `blocks` may not loop. Links cross boards
 * within the org; every list keeps to the cards the reader can open.
 */

type LinkRow = typeof boardCardLinks.$inferSelect;

/** How a type read from the card maps to a stored row. */
const STORED: Record<CardLinkType, { kind: CardLinkKind; selfIsFrom: boolean }> = {
  blocks: { kind: 'blocks', selfIsFrom: true },
  blocked_by: { kind: 'blocks', selfIsFrom: false },
  relates: { kind: 'relates', selfIsFrom: true },
  duplicates: { kind: 'duplicates', selfIsFrom: true },
  duplicated_by: { kind: 'duplicates', selfIsFrom: false },
};

const ORDER: CardLinkType[] = ['blocked_by', 'blocks', 'relates', 'duplicates', 'duplicated_by'];

function typeOf(row: Pick<LinkRow, 'kind' | 'fromCardId'>, selfId: string): CardLinkType {
  const out = row.fromCardId === selfId;
  if (row.kind === 'relates') return 'relates';
  if (row.kind === 'blocks') return out ? 'blocks' : 'blocked_by';
  return out ? 'duplicates' : 'duplicated_by';
}

/** Board visibility for the reader, cached per space (membership or a share on the path). */
function visibility(db: DbOrTx, a: DriveActor) {
  const roles = new Map<
    string,
    { role: SpaceRole | null; paths: Awaited<ReturnType<typeof userSharePaths>> }
  >();
  return async (node: { spaceId: string; path: string }) => {
    let s = roles.get(node.spaceId);
    if (!s) {
      s = {
        role: await spaceRoleOf(db, node.spaceId, a.userId),
        paths: await userSharePaths(db, node.spaceId, a.userId),
      };
      roles.set(node.spaceId, s);
    }
    return roleForPath(s.role, s.paths, node.path) !== null;
  };
}

/** Live cards with what a link line shows, keyed by id; hidden ones are left out. */
async function linkedCards(db: DbOrTx, a: DriveActor, ids: string[]) {
  const out = new Map<string, LinkedCard>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ card: boardCards, node: nodes, board: boards, column: boardColumns })
    .from(boardCards)
    .innerJoin(nodes, eq(nodes.id, boardCards.boardNodeId))
    .innerJoin(boards, eq(boards.nodeId, boardCards.boardNodeId))
    .innerJoin(boardColumns, eq(boardColumns.id, boardCards.columnId))
    .where(
      and(
        inArray(boardCards.id, ids),
        eq(boardCards.orgId, a.org.id),
        isNull(boardCards.deletedAt),
        isNull(nodes.deletedAt),
      ),
    );
  const sees = visibility(db, a);
  for (const r of rows) {
    if (!(await sees(r.node))) continue;
    out.set(r.card.id, {
      id: r.card.id,
      boardId: r.node.id,
      boardName: r.node.name,
      key: `${r.board.settings.key}-${r.card.number}`,
      title: r.card.title,
      columnName: r.column.name,
      done: r.card.doneAt !== null,
    });
  }
  return out;
}

/** One card as a link line shows it; null when gone or hidden from the reader. */
export async function linkedCardOf(db: DbOrTx, a: DriveActor, id: string) {
  return (await linkedCards(db, a, [id])).get(id) ?? null;
}

/** The card's links to cards the reader can see, blockers first. */
export async function linksOf(db: DbOrTx, a: DriveActor, cardId: string): Promise<CardLink[]> {
  const rows = await db
    .select()
    .from(boardCardLinks)
    .where(or(eq(boardCardLinks.fromCardId, cardId), eq(boardCardLinks.toCardId, cardId)));
  const other = (r: LinkRow) => (r.fromCardId === cardId ? r.toCardId : r.fromCardId);
  const cards = await linkedCards(db, a, [...new Set(rows.map(other))]);
  return rows
    .filter((r) => cards.has(other(r)))
    .map((r) => ({
      id: r.id,
      type: typeOf(r, cardId),
      card: cards.get(other(r))!,
      createdAt: r.createdAt.toISOString(),
    }))
    .sort(
      (x, y) =>
        ORDER.indexOf(x.type) - ORDER.indexOf(y.type) ||
        x.card.key.localeCompare(y.card.key, 'tr', { numeric: true }),
    );
}

export async function listLinks(db: DbOrTx, a: DriveActor, cardId: string) {
  await loadCard(db, a, cardId);
  return { items: await linksOf(db, a, cardId) };
}

/** Would `from blocks to` close a loop? Walks the blocks edges onward from `to`. */
async function closesLoop(db: DbOrTx, from: string, to: string) {
  const seen = new Set<string>([to]);
  let frontier = [to];
  while (frontier.length) {
    if (frontier.includes(from)) return true;
    const next = await db
      .select({ id: boardCardLinks.toCardId })
      .from(boardCardLinks)
      .where(and(eq(boardCardLinks.kind, 'blocks'), inArray(boardCardLinks.fromCardId, frontier)));
    frontier = next.map((r) => r.id).filter((id) => !seen.has(id));
    for (const id of frontier) seen.add(id);
  }
  return false;
}

async function touchBoards(db: DbOrTx, a: DriveActor, cards: CardRow[]) {
  const done = new Set<string>();
  for (const c of cards) {
    if (done.has(c.boardNodeId)) continue;
    done.add(c.boardNodeId);
    const [node] = await db
      .select({ id: nodes.id, orgId: nodes.orgId, spaceId: nodes.spaceId })
      .from(nodes)
      .where(eq(nodes.id, c.boardNodeId));
    if (node) announce(node, await touchBoard(db, c.boardNodeId, a.userId));
  }
}

/** Links the card to another one the caller can see; editing the card's board is enough. */
export async function addLink(
  db: DbOrTx,
  a: DriveActor,
  cardId: string,
  input: { cardId: string; type: CardLinkType },
) {
  const self = await loadCard(db, a, cardId);
  requireRole(a, self.role, 'edit');
  if (input.cardId === cardId) throw new AppError('invalid_target', { reason: 'self' });
  const other = await loadCard(db, a, input.cardId);
  const { kind, selfIsFrom } = STORED[input.type];
  const from = selfIsFrom ? cardId : input.cardId;
  const to = selfIsFrom ? input.cardId : cardId;
  // One link per pair and kind; `relates` reads the same both ways.
  const [existing] = await db
    .select({ id: boardCardLinks.id })
    .from(boardCardLinks)
    .where(
      and(
        eq(boardCardLinks.kind, kind),
        or(
          and(eq(boardCardLinks.fromCardId, from), eq(boardCardLinks.toCardId, to)),
          kind === 'relates'
            ? and(eq(boardCardLinks.fromCardId, to), eq(boardCardLinks.toCardId, from))
            : sql`false`,
        ),
      ),
    );
  if (!existing) {
    if (kind === 'blocks' && (await closesLoop(db, from, to))) {
      throw new AppError('board_link_cycle');
    }
    await db
      .insert(boardCardLinks)
      .values({ orgId: a.org.id, fromCardId: from, toCardId: to, kind, createdBy: a.userId })
      .onConflictDoNothing();
    await touchBoards(db, a, [self.card, other.card]);
  }
  return { items: await linksOf(db, a, cardId) };
}

/** Whoever may edit either card's board may remove the link. */
export async function removeLink(db: DbOrTx, a: DriveActor, linkId: string) {
  const [link] = await db
    .select()
    .from(boardCardLinks)
    .where(and(eq(boardCardLinks.id, linkId), eq(boardCardLinks.orgId, a.org.id)));
  if (!link) throw new AppError('not_found');
  const ends = [];
  for (const id of [link.fromCardId, link.toCardId]) {
    ends.push(await loadCard(db, a, id, { includeDeleted: true }).catch(() => null));
  }
  const visible = ends.filter((e) => e !== null);
  if (visible.length === 0) throw new AppError('not_found');
  const editable = visible.find((e) => {
    try {
      requireRole(a, e.role, 'edit');
      return true;
    } catch {
      return false;
    }
  });
  if (!editable) throw new AppError('forbidden');
  await db.delete(boardCardLinks).where(eq(boardCardLinks.id, linkId));
  await touchBoards(
    db,
    a,
    visible.map((e) => e.card),
  );
}

/** Unfinished, live cards blocking each of the given cards. */
export async function blockerCounts(db: DbOrTx, cardIds: string[]) {
  if (cardIds.length === 0) return new Map<string, number>();
  const rows = await db
    .select({ id: boardCardLinks.toCardId, n: count() })
    .from(boardCardLinks)
    .innerJoin(boardCards, eq(boardCards.id, boardCardLinks.fromCardId))
    .where(
      and(
        eq(boardCardLinks.kind, 'blocks'),
        inArray(boardCardLinks.toCardId, cardIds),
        isNull(boardCards.doneAt),
        isNull(boardCards.archivedAt),
        isNull(boardCards.deletedAt),
      ),
    )
    .groupBy(boardCardLinks.toCardId);
  return new Map(rows.map((r) => [r.id, Number(r.n)]));
}

/** `blocks` links between live cards of one board: the timeline draws them. */
export async function boardDependencies(db: DbOrTx, boardId: string) {
  const rows = await db
    .select({ fromId: boardCardLinks.fromCardId, toId: boardCardLinks.toCardId })
    .from(boardCardLinks)
    .innerJoin(boardCards, eq(boardCards.id, boardCardLinks.fromCardId))
    .where(
      and(
        eq(boardCardLinks.kind, 'blocks'),
        eq(boardCards.boardNodeId, boardId),
        isNull(boardCards.deletedAt),
      ),
    );
  if (rows.length === 0) return [];
  const targets = await db
    .select({ id: boardCards.id })
    .from(boardCards)
    .where(
      and(
        inArray(
          boardCards.id,
          rows.map((r) => r.toId),
        ),
        eq(boardCards.boardNodeId, boardId),
        isNull(boardCards.deletedAt),
      ),
    );
  const onBoard = new Set(targets.map((t) => t.id));
  return rows.filter((r) => onBoard.has(r.toId));
}

/** Cards to link to: title words or a key, on boards the caller can see. */
export async function searchCards(
  db: DbOrTx,
  a: DriveActor,
  q: { q: string; boardId?: string | undefined; limit: number },
) {
  const spaceIds = await reachableSpaceIds(db, a);
  if (spaceIds.length === 0) return { items: [] };
  const key = /^(?:([A-Za-z][A-Za-z0-9]{0,5})-)?(\d{1,9})$/.exec(q.q);
  const words = q.q
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => ilike(boardCards.title, `%${w.replace(/[\\%_]/g, (m) => `\\${m}`)}%`));
  const rows = await db
    .select({ id: boardCards.id })
    .from(boardCards)
    .innerJoin(nodes, eq(nodes.id, boardCards.boardNodeId))
    .where(
      and(
        eq(boardCards.orgId, a.org.id),
        isNull(boardCards.deletedAt),
        isNull(nodes.deletedAt),
        inArray(nodes.spaceId, spaceIds),
        key ? or(eq(boardCards.number, Number(key[2])), and(...words)) : and(...words),
      ),
    )
    .orderBy(
      q.boardId ? desc(sql`${boardCards.boardNodeId} = ${q.boardId}`) : desc(boardCards.updatedAt),
      desc(boardCards.updatedAt),
    )
    .limit(q.limit * 3);
  const cards = await linkedCards(
    db,
    a,
    rows.map((r) => r.id),
  );
  const prefix = key?.[1]?.toUpperCase();
  return {
    items: rows
      .map((r) => cards.get(r.id))
      .filter((c): c is LinkedCard => !!c && (!prefix || c.key.startsWith(`${prefix}-`) || !key))
      .slice(0, q.limit),
  };
}
