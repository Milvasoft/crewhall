import { and, eq, inArray } from 'drizzle-orm';
import { boardCards, boards, nodes, spaces, type DbOrTx } from '@crewhall/db';
import {
  can,
  MESSAGE_REF_LIMITS,
  paths,
  withQuery,
  type MessageRef,
  type ResolvedRef,
  type SpaceRole,
} from '@crewhall/shared';
import { AppError } from '../../http/errors';
import { searchCards } from '../boards/links';
import {
  nodeResource,
  roleForPath,
  spaceRoleOf,
  userSharePaths,
  type NodeRow,
  type SpaceRow,
} from '../drive/access';
import { listRecent, searchNodes } from '../drive/personal';
import { hiddenNodeTypes } from '../identity/node-types';
import type { ChatActor } from './access';

/**
 * Internal references ("şuna bak"): a message points at an item without a public link or a
 * share. A message row holds only ids, and events carry one shared view of a message, so a title
 * can only come from here, answered for the person asking through `can(space.view)`. Without
 * that right the answer says nothing about the item, not even whether it is in the trash.
 */

const noAccess = (r: MessageRef): ResolvedRef => ({ ...r, state: 'no_access', item: null });
const deleted = (r: MessageRef): ResolvedRef => ({ ...r, state: 'deleted', item: null });

/** Where a node opens; a file opens in the Drive viewer, in its folder. */
function nodePath(node: NodeRow, space: SpaceRow) {
  switch (node.type) {
    case 'page':
      return paths.page(node.id);
    case 'board':
      return paths.board(node.id);
    case 'drawing':
      return paths.drawing(node.id);
    case 'folder':
      return paths.driveFolder(space.slug, node.id);
    default:
      return withQuery(
        node.parentId ? paths.driveFolder(space.slug, node.parentId) : paths.driveSpace(space.slug),
        { preview: node.id },
      );
  }
}

/** Each ref as the caller may see it, in the order asked. */
export async function resolveRefs(
  db: DbOrTx,
  a: ChatActor,
  refs: MessageRef[],
): Promise<ResolvedRef[]> {
  if (!refs.length) return [];
  const nodeIds = refs.filter((r) => r.kind === 'node').map((r) => r.id);
  const cardIds = refs.filter((r) => r.kind === 'card').map((r) => r.id);
  const nodeRows = nodeIds.length
    ? await db
        .select({ node: nodes, space: spaces })
        .from(nodes)
        .innerJoin(spaces, eq(spaces.id, nodes.spaceId))
        .where(and(inArray(nodes.id, nodeIds), eq(nodes.orgId, a.org.id)))
    : [];
  const cardRows = cardIds.length
    ? await db
        .select({ card: boardCards, board: boards, node: nodes, space: spaces })
        .from(boardCards)
        .innerJoin(boards, eq(boards.nodeId, boardCards.boardNodeId))
        .innerJoin(nodes, eq(nodes.id, boardCards.boardNodeId))
        .innerJoin(spaces, eq(spaces.id, nodes.spaceId))
        .where(and(inArray(boardCards.id, cardIds), eq(boardCards.orgId, a.org.id)))
    : [];
  const hidden = await hiddenNodeTypes(db, a.org.id);

  const access = new Map<
    string,
    { spaceRole: SpaceRole | null; shares: Awaited<ReturnType<typeof userSharePaths>> }
  >();
  const canSee = async (node: NodeRow) => {
    let s = access.get(node.spaceId);
    if (!s) {
      s = {
        spaceRole: await spaceRoleOf(db, node.spaceId, a.userId),
        shares: await userSharePaths(db, node.spaceId, a.userId),
      };
      access.set(node.spaceId, s);
    }
    const role = roleForPath(s.spaceRole, s.shares, node.path);
    return can(a.actor, 'space.view', nodeResource(a, role)) && !hidden.includes(node.type);
  };

  const nodesById = new Map(nodeRows.map((r) => [r.node.id, r]));
  const cardsById = new Map(cardRows.map((r) => [r.card.id, r]));
  const out: ResolvedRef[] = [];
  for (const ref of refs) {
    if (ref.kind === 'node') {
      const row = nodesById.get(ref.id);
      // No row at all: purged, or another org's (the same answer for both).
      if (!row) out.push(deleted(ref));
      else if (!(await canSee(row.node))) out.push(noAccess(ref));
      else if (row.node.deletedAt || row.space.deletedAt) out.push(deleted(ref));
      else {
        out.push({
          ...ref,
          state: 'ok',
          item: {
            type: row.node.type,
            title: row.node.name,
            path: nodePath(row.node, row.space),
            mime: row.node.mime,
            spaceName: row.space.name,
          },
        });
      }
      continue;
    }
    const row = cardsById.get(ref.id);
    if (!row) out.push(deleted(ref));
    else if (!(await canSee(row.node))) out.push(noAccess(ref));
    else if (row.card.deletedAt || row.node.deletedAt || row.space.deletedAt) {
      out.push(deleted(ref));
    } else {
      out.push({
        ...ref,
        state: 'ok',
        item: {
          type: 'card',
          title: row.card.title,
          path: paths.boardCard(row.node.id, `${row.board.settings.key}-${row.card.number}`),
          mime: null,
          spaceName: row.space.name,
        },
      });
    }
  }
  return out;
}

/** The composer's `[[` picker: only what the caller can see; recently opened with no query. */
export async function searchRefs(
  db: DbOrTx,
  a: ChatActor,
  q: { q: string; limit: number },
): Promise<ResolvedRef[]> {
  const refs: MessageRef[] = [];
  if (q.q) {
    const hits = await searchNodes(db, a, { q: q.q, content: false, limit: q.limit });
    refs.push(...hits.items.map((h) => ({ kind: 'node' as const, id: h.node.id })));
    if (!(await hiddenNodeTypes(db, a.org.id)).includes('board')) {
      const cards = await searchCards(db, a, { q: q.q, limit: Math.min(q.limit, 4) });
      refs.push(...cards.items.map((c) => ({ kind: 'card' as const, id: c.id })));
    }
  } else {
    const recent = await listRecent(db, a, q.limit);
    refs.push(...recent.map((n) => ({ kind: 'node' as const, id: n.id })));
  }
  const resolved = await resolveRefs(db, a, refs);
  return resolved.filter((r) => r.state === 'ok').slice(0, q.limit);
}

/**
 * The refs a message may carry: each one the sender can see (a message must not be a way to probe
 * for items), without repeats.
 */
export async function checkRefs(
  db: DbOrTx,
  a: ChatActor,
  refs: MessageRef[] | undefined,
): Promise<MessageRef[]> {
  if (!refs?.length) return [];
  const unique = [...new Map(refs.map((r) => [`${r.kind}:${r.id}`, r])).values()].slice(
    0,
    MESSAGE_REF_LIMITS.perMessage,
  );
  const resolved = await resolveRefs(db, a, unique);
  if (resolved.some((r) => r.state !== 'ok')) throw new AppError('chat_ref_no_access');
  return unique.map(({ kind, id }) => ({ kind, id }));
}
