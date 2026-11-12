import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { driveChanges, nodes, shares, spaceMembers, spaces, type DbOrTx } from '@crewhall/db';
import {
  can,
  DRIVE_CHANGES_RETENTION_DAYS,
  NodeType,
  type DriveChange,
  type DriveChangesPage,
  type SpaceRole,
} from '@crewhall/shared';
import { z } from 'zod';
import { AppError } from '../../http/errors';
import { hiddenNodeTypes } from '../identity/node-types';
import {
  isAncestorOrSelf,
  nodeResource,
  roleForPath,
  toDriveNodes,
  type DriveActor,
} from './access';

/**
 * Drive change feed (listDriveChanges): the change log filtered down to what one person can see,
 * as the current state of each changed node. Visibility is worked out at read time from today's
 * memberships and shares, so a replay can only say what is true now.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Position in the log (txid, seq) and when it was issued. */
const Cursor = z.object({
  v: z.literal(1),
  x: z.number().int(),
  s: z.number().int(),
  t: z.number(),
});
type Cursor = z.infer<typeof Cursor>;

const encodeCursor = (x: number, s: number) =>
  Buffer.from(JSON.stringify({ v: 1, x, s, t: Date.now() } satisfies Cursor)).toString('base64url');

function decodeCursor(value: string): Cursor {
  try {
    const parsed = Cursor.safeParse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    if (parsed.success) return parsed.data;
  } catch {
    // reported below
  }
  throw new AppError('bad_request', { reason: 'invalid_cursor' });
}

type SpaceRow = typeof spaces.$inferSelect;

interface Access {
  /** Membership per space, deleted spaces included: they still have to be reported. */
  member: Map<string, { role: SpaceRole; space: SpaceRow }>;
  /** Live shares and the ones on trashed nodes, per space. */
  shared: Map<string, { path: string; role: 'viewer' | 'editor'; trashed: boolean }[]>;
  spaceIds: string[];
}

async function loadAccess(db: DbOrTx, a: DriveActor): Promise<Access> {
  const memberRows = await db
    .select({ role: spaceMembers.role, space: spaces })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
    .where(and(eq(spaceMembers.userId, a.userId), eq(spaces.orgId, a.org.id)));
  const member = new Map(
    memberRows.map((r) => [r.space.id, { role: r.role as SpaceRole, space: r.space }]),
  );
  const shareRows = await db
    .select({
      spaceId: nodes.spaceId,
      path: nodes.path,
      role: shares.role,
      deletedAt: nodes.deletedAt,
    })
    .from(shares)
    .innerJoin(nodes, eq(nodes.id, shares.nodeId))
    .where(
      and(
        eq(shares.kind, 'user'),
        eq(shares.granteeUserId, a.userId),
        eq(nodes.orgId, a.org.id),
        sql`(${shares.expiresAt} is null or ${shares.expiresAt} > now())`,
      ),
    );
  const shared: Access['shared'] = new Map();
  for (const r of shareRows) {
    const list = shared.get(r.spaceId) ?? [];
    list.push({ path: r.path, role: r.role, trashed: r.deletedAt !== null });
    shared.set(r.spaceId, list);
  }
  return { member, shared, spaceIds: [...new Set([...member.keys(), ...shared.keys()])] };
}

/** The role on a live node at `path` now; null when it is out of the person's view. */
function roleNow(
  a: DriveActor,
  access: Access,
  spaceAlive: (id: string) => boolean,
  spaceId: string,
  path: string,
): SpaceRole | null {
  if (!spaceAlive(spaceId)) return null;
  const live = (access.shared.get(spaceId) ?? []).filter((s) => !s.trashed);
  const role = roleForPath(access.member.get(spaceId)?.role ?? null, live, path);
  return role && can(a.actor, 'space.view', nodeResource(a, role)) ? role : null;
}

/** Was a node at this place in the person's view? Trashed shares count: they just went. */
function sawAt(access: Access, spaceId: string | null, path: string | null) {
  if (!spaceId) return false;
  if (access.member.has(spaceId)) return true;
  return (
    path !== null && (access.shared.get(spaceId) ?? []).some((s) => isAncestorOrSelf(s.path, path))
  );
}

type LogRow = typeof driveChanges.$inferSelect;
interface Entry {
  row: LogRow;
  saw: boolean;
  fresh: boolean;
}

/**
 * Latest log row per node or space of a page; `saw` from any of its rows. `fresh`: the node was
 * created in this page, which is what a reader needs to hear whatever else happened to it (an
 * upload creates the node and its first version as two rows).
 */
function collapse(rows: LogRow[], access: Access) {
  const out = new Map<string, Entry>();
  for (const row of rows) {
    const key = row.userId
      ? `access:${row.nodeId ?? row.spaceId}`
      : row.nodeId
        ? `node:${row.nodeId}`
        : `space:${row.spaceId}`;
    const saw =
      row.kind === 'moved'
        ? sawAt(access, row.prevSpaceId ?? row.spaceId, row.prevPath ?? row.path)
        : sawAt(access, row.spaceId, row.path);
    const before = out.get(key);
    out.delete(key);
    out.set(key, {
      row,
      saw: saw || (before?.saw ?? false),
      fresh: row.kind === 'created' || (before?.fresh ?? false),
    });
  }
  return [...out.values()];
}

export async function listDriveChanges(
  db: DbOrTx,
  a: DriveActor,
  q: { cursor?: string | undefined; limit: number; types?: string | undefined },
): Promise<DriveChangesPage> {
  // Read first: every transaction below xmin has finished, so what the next query finds below it
  // is final, and a later page can never turn up something earlier.
  const snapshot = await db.execute<{ xmin: string; xmax: string }>(
    sql`select pg_snapshot_xmin(pg_current_snapshot())::text as xmin, pg_snapshot_xmax(pg_current_snapshot())::text as xmax`,
  );
  const xmin = Number(snapshot.rows[0]!.xmin);
  const xmax = Number(snapshot.rows[0]!.xmax);
  if (!q.cursor) return { items: [], nextCursor: encodeCursor(xmin, 0), hasMore: false };

  const cursor = decodeCursor(q.cursor);
  // Past the server's transaction counter: the cursor is from before a restore.
  if (Date.now() - cursor.t > DRIVE_CHANGES_RETENTION_DAYS * DAY_MS || cursor.x > xmax) {
    throw new AppError('drive_changes_expired');
  }

  const access = await loadAccess(db, a);
  const wanted = (q.types?.split(',') ?? NodeType.options) as NodeType[];
  const hidden = await hiddenNodeTypes(db, a.org.id);
  const types = wanted.filter((t) => !hidden.includes(t));
  const inMySpaces: SQL | undefined = access.spaceIds.length
    ? sql`(${inArray(driveChanges.spaceId, access.spaceIds)} or ${inArray(driveChanges.prevSpaceId, access.spaceIds)})`
    : undefined;
  const rows = await db
    .select()
    .from(driveChanges)
    .where(
      and(
        eq(driveChanges.orgId, a.org.id),
        sql`${driveChanges.txid} < ${xmin}`,
        sql`(${driveChanges.txid}, ${driveChanges.seq}) > (${cursor.x}, ${cursor.s})`,
        inMySpaces
          ? sql`(${driveChanges.userId} = ${a.userId} or (${isNull(driveChanges.userId)} and ${inMySpaces}))`
          : eq(driveChanges.userId, a.userId),
        types.length
          ? sql`(${driveChanges.nodeType} is null or ${inArray(driveChanges.nodeType, types)})`
          : isNull(driveChanges.nodeType),
      ),
    )
    .orderBy(asc(driveChanges.txid), asc(driveChanges.seq))
    .limit(q.limit + 1);
  const hasMore = rows.length > q.limit;
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);

  const items: DriveChange[] = [];
  await assemble(
    db,
    a,
    access,
    [...(await expiredShares(db, a, cursor)), ...collapse(page, access)],
    items,
  );
  return {
    items,
    // At the end, go past everything skipped too; below xmin nothing new can appear.
    nextCursor: hasMore && last ? encodeCursor(last.txid, last.seq) : encodeCursor(xmin, 0),
    hasMore,
  };
}

/**
 * Shares end by time without any write, so the log has no row for them. Read as if it had one:
 * the person may still see the node through the space.
 */
async function expiredShares(db: DbOrTx, a: DriveActor, cursor: Cursor): Promise<Entry[]> {
  const rows = await db
    .select({ node: nodes, at: shares.expiresAt })
    .from(shares)
    .innerJoin(nodes, eq(nodes.id, shares.nodeId))
    .where(
      and(
        eq(shares.kind, 'user'),
        eq(shares.granteeUserId, a.userId),
        eq(nodes.orgId, a.org.id),
        sql`${shares.expiresAt} > ${new Date(cursor.t).toISOString()}::timestamptz`,
        sql`${shares.expiresAt} <= now()`,
      ),
    );
  return rows.map((r) => ({
    row: {
      seq: 0,
      txid: 0,
      orgId: a.org.id,
      spaceId: r.node.spaceId,
      prevSpaceId: null,
      nodeId: r.node.id,
      nodeType: r.node.type,
      userId: a.userId,
      kind: 'access_changed' as const,
      path: r.node.path,
      prevPath: null,
      at: r.at!,
    },
    saw: true,
    fresh: false,
  }));
}

async function assemble(
  db: DbOrTx,
  a: DriveActor,
  access: Access,
  entries: Entry[],
  items: DriveChange[],
) {
  const nodeIds = [...new Set(entries.map((e) => e.row.nodeId).filter((x): x is string => !!x))];
  const nodeRows = nodeIds.length
    ? await db
        .select()
        .from(nodes)
        .where(and(inArray(nodes.id, nodeIds), eq(nodes.orgId, a.org.id)))
    : [];
  const nodeById = new Map(nodeRows.map((n) => [n.id, n]));

  const spaceIds = [
    ...new Set([...entries.map((e) => e.row.spaceId), ...nodeRows.map((n) => n.spaceId)]),
  ];
  const spaceRows = spaceIds.length
    ? await db
        .select()
        .from(spaces)
        .where(and(inArray(spaces.id, spaceIds), eq(spaces.orgId, a.org.id)))
    : [];
  const spaceById = new Map(spaceRows.map((s) => [s.id, s]));
  const spaceAlive = (id: string) => {
    const s = spaceById.get(id);
    return !!s && !s.deletedAt;
  };

  // Current state of every node the person can see now.
  const roles = new Map<string, SpaceRole>();
  for (const n of nodeRows) {
    if (n.deletedAt) continue;
    const role = roleNow(a, access, spaceAlive, n.spaceId, n.path);
    if (role) roles.set(n.id, role);
  }
  const visibleRows = nodeRows.filter((n) => roles.has(n.id));
  const driveNodes = new Map(
    (await toDriveNodes(db, a.userId, visibleRows, roles)).map((n) => [n.id, n]),
  );

  const spaceView = (id: string): DriveChange['space'] => {
    const s = spaceById.get(id);
    if (!s) return null;
    return {
      id: s.id,
      name: s.name,
      slug: s.slug,
      kind: s.kind,
      color: s.color,
      archived: s.archivedAt !== null,
      myRole: access.member.get(id)?.role ?? null,
    };
  };

  for (const { row, saw, fresh } of entries) {
    const at = row.at.toISOString();
    const base = {
      spaceId: row.spaceId,
      nodeId: row.nodeId,
      node: null,
      space: null,
      reason: null,
    };

    if (row.userId) {
      if (row.nodeId) {
        // A share: what counts is whether the node is in view now, by any route.
        const node = driveNodes.get(row.nodeId);
        if (node) {
          const type = row.kind === 'access_granted' ? 'accessGained' : 'accessChanged';
          items.push({ ...base, spaceId: node.spaceId, type, node, at });
        } else if (row.kind !== 'access_granted') {
          items.push({ ...base, type: 'accessLost', at });
        }
      } else if (access.member.has(row.spaceId) && spaceAlive(row.spaceId)) {
        const type = row.kind === 'access_granted' ? 'accessGained' : 'accessChanged';
        items.push({ ...base, type, space: spaceView(row.spaceId), at });
      } else if (row.kind !== 'access_granted') {
        // Out of the space, but shares inside it may remain: list it again rather than drop it.
        items.push(
          access.shared.has(row.spaceId) && spaceAlive(row.spaceId)
            ? { ...base, type: 'accessChanged', space: spaceView(row.spaceId), at }
            : { ...base, type: 'accessLost', at },
        );
      }
      continue;
    }

    if (!row.nodeId) {
      if (row.kind === 'space_removed') {
        if (!spaceAlive(row.spaceId)) items.push({ ...base, type: 'spaceRemoved', at });
      } else if (spaceAlive(row.spaceId)) {
        const type = row.kind === 'space_restored' ? 'accessGained' : 'spaceUpdated';
        items.push({ ...base, type, space: spaceView(row.spaceId), at });
      }
      continue;
    }

    const node = driveNodes.get(row.nodeId);
    if (node) {
      const type = fresh ? 'created' : row.kind === 'moved' ? 'moved' : 'updated';
      items.push({ ...base, spaceId: node.spaceId, type, node, at });
      continue;
    }
    // Out of view now. Only someone who could see it hears that it went.
    if (!saw) continue;
    const current = nodeById.get(row.nodeId);
    items.push({
      ...base,
      // Moved out of view: the place the person knew it in.
      spaceId: row.kind === 'moved' ? (row.prevSpaceId ?? row.spaceId) : row.spaceId,
      type: 'deleted',
      reason: !current ? 'purged' : current.deletedAt ? 'trashed' : 'access_lost',
      at,
    });
  }
}
