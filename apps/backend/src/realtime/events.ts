import { eq, sql } from 'drizzle-orm';
import { nodes, shares, spaceMembers, type DbOrTx } from '@crewhall/db';
import type { LinkHealth } from '@crewhall/shared';
import type { Logger } from '../logger';
import { publishToUsers, type Bus } from './bus';

/**
 * Phase 1 events on the WebSocket (doc 17 §6): Drive changes and link health. Payloads
 * carry ids only; clients refetch what they show.
 */

export type NodeChange = 'created' | 'updated' | 'moved' | 'trashed' | 'restored' | 'deleted';

interface NodeRef {
  id: string;
  spaceId: string;
  parentId: string | null;
}

/** Space members, plus people a share on the node or an ancestor reaches. */
async function nodeAudience(db: DbOrTx, node: NodeRef) {
  const members = await db
    .select({ userId: spaceMembers.userId })
    .from(spaceMembers)
    .where(eq(spaceMembers.spaceId, node.spaceId));
  const shared = await db.execute<{ user_id: string }>(sql`
    select distinct s.grantee_user_id as user_id from ${shares} s
    join ${nodes} sn on sn.id = s.node_id
    join ${nodes} n on n.id = ${node.id}::uuid
    where s.kind = 'user' and s.grantee_user_id is not null and n.path <@ sn.path`);
  return [...members.map((m) => m.userId), ...shared.rows.map((r) => r.user_id)];
}

export async function publishNodeChanges(
  deps: { db: DbOrTx; bus: Bus; logger: Logger },
  list: NodeRef[],
  change: NodeChange,
) {
  try {
    for (const node of list.slice(0, 200)) {
      publishToUsers(deps.bus, await nodeAudience(deps.db, node), {
        type: 'node.updated',
        spaceId: node.spaceId,
        nodeId: node.id,
        parentId: node.parentId,
        change,
      });
    }
  } catch (err) {
    deps.logger.warn({ err }, 'node event failed');
  }
}

/** Nodes whose current version is this blob (preview ready, processing done). */
export async function publishBlobNodes(
  deps: { db: DbOrTx; bus: Bus; logger: Logger },
  blobId: string,
) {
  const rows = await deps.db.execute<{
    id: string;
    space_id: string;
    parent_id: string | null;
  }>(sql`
    select n.id, n.space_id, n.parent_id from ${nodes} n
    join node_versions v on v.id = n.current_version_id
    where v.blob_id = ${blobId}::uuid and n.deleted_at is null`);
  await publishNodeChanges(
    deps,
    rows.rows.map((r) => ({ id: r.id, spaceId: r.space_id, parentId: r.parent_id })),
    'updated',
  );
}

/** Link went up, warn or down: everyone who sees a card showing it. */
export function publishLinkStatus(bus: Bus, userIds: string[], linkId: string, health: LinkHealth) {
  publishToUsers(bus, userIds, { type: 'link.status', linkId, health });
}
