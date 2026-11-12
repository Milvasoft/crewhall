import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  blobs,
  conversations,
  federationConversations,
  federationFolderItems,
  federationPeers,
  federationSharedChannels,
  federationSharedFolders,
  newId,
  nodes,
  nodeVersions,
  organizations,
  type DbOrTx,
} from '@crewhall/db';
import type { SharedFolder } from '@crewhall/shared';
import { AppError } from '../../http/errors';
import { audit } from '../audit';
import { requireMember, type ChatActor, type ConversationRow } from '../chat/access';
import { requireStorage } from '../drive/files';
import { adjustSpaceBytes, childPath, freeName, positionIn, rewriteSubtree } from '../drive/tree';
import {
  newActivity,
  ownDomain,
  peerActive,
  postActivity,
  type FedJobDeps,
  type FedOrg,
  type PeerRow,
} from './core';
import { blobContent, fetchSigned, MB, peerById, readLimited } from './files';
import { isAdmin, requireInviter, requireShared, sharedSettings } from './shared';

/**
 * Shared channels 2 › shared folders (kararlar.md, federasyon.md › Paylaşılan kanallar 2): a
 * Drive folder of a shared channel kept in step with the other organizations' copies. Local
 * changes are found by a scan (federation.folder_scan) against `federation_folder_items`;
 * remote ones are applied with the item rows updated in the same transaction, so nothing
 * echoes back. The host relays, like messages.
 */

export const MAX_FOLDERS_PER_CHANNEL = 10;
export const MAX_ITEMS_PER_FOLDER = 5000;
/** Changes per `folder.items` activity (the body limit is 256 KB). */
const CHUNK = 100;

type FolderRow = typeof federationSharedFolders.$inferSelect;
type ItemRow = typeof federationFolderItems.$inferSelect;
type NodeRow = typeof nodes.$inferSelect;

const Origin = z.object({ id: z.uuid(), domain: z.string().min(1).max(260) });
type Origin = z.infer<typeof Origin>;

const ItemChange = Origin.extend({
  parent: Origin.nullable(),
  type: z.enum(['file', 'folder']),
  name: z.string().min(1).max(255),
  /** Content stamp of a file; a different one means "pull the bytes". */
  version: z.string().max(100).nullable(),
  size: z.number().int().min(0),
  mime: z.string().max(255).nullable(),
  changedAt: z.string().max(40),
  deleted: z.boolean(),
});
type ItemChange = z.infer<typeof ItemChange>;

export const FolderShareActivity = z.object({
  /** The receiver's copy of the channel. */
  conversationId: z.uuid(),
  folder: z.object({ id: z.uuid(), name: z.string().min(1).max(255) }),
});
export const FolderItemsActivity = z.object({
  folderId: z.uuid(),
  items: z.array(ItemChange).max(CHUNK),
});
export const FolderRefActivity = z.object({ folderId: z.uuid() });

// ---- Views and lookups ----

async function homeDomainOf(deps: FedJobDeps, folder: FolderRow) {
  if (folder.role === 'host' || !folder.peerId) return ownDomain(deps.env);
  return (await peerById(deps.db, folder.peerId))?.domain ?? '';
}

async function toFolder(deps: FedJobDeps, row: FolderRow): Promise<SharedFolder> {
  return {
    id: row.id,
    role: row.role,
    status: row.status,
    name: row.name,
    conversationId: row.conversationId,
    nodeId: row.rootNodeId,
    homeDomain: await homeDomainOf(deps, row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function liveNode(db: DbOrTx, id: string | null) {
  if (!id) return null;
  const [row] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), isNull(nodes.deletedAt)));
  return row ?? null;
}

async function loadOrg(db: DbOrTx, orgId: string): Promise<FedOrg | null> {
  const [org] = await db
    .select({ id: organizations.id, name: organizations.name, settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  return org ?? null;
}

/** The peers a folder's changes go to: every active guest on the host, the host on a guest. */
async function targetsOf(deps: FedJobDeps, org: FedOrg, folder: FolderRow, except?: string) {
  const rows = await deps.db
    .select({ peer: federationPeers, link: federationConversations })
    .from(federationSharedChannels)
    .innerJoin(federationPeers, eq(federationPeers.id, federationSharedChannels.peerId))
    .innerJoin(
      federationConversations,
      and(
        eq(federationConversations.conversationId, federationSharedChannels.conversationId),
        eq(federationConversations.peerId, federationSharedChannels.peerId),
      ),
    )
    .where(
      and(
        eq(federationSharedChannels.conversationId, folder.conversationId),
        eq(federationSharedChannels.status, 'active'),
        eq(federationSharedChannels.role, folder.role),
      ),
    );
  return rows
    .filter((r) => r.peer.id !== except && peerActive(org, r.peer))
    .filter((r) => folder.role === 'host' || r.peer.id === folder.peerId)
    .map((r) => ({ peer: r.peer, remoteConversationId: r.link.remoteConversationId }));
}

async function send(
  deps: FedJobDeps,
  org: FedOrg,
  peers: { peer: PeerRow }[],
  folder: FolderRow,
  changes: ItemChange[],
) {
  for (let i = 0; i < changes.length; i += CHUNK) {
    for (const { peer } of peers) {
      await deps.jobs.send('federation.deliver', {
        orgId: org.id,
        domain: peer.domain,
        activity: newActivity('folder.items', {
          folderId: folder.hostFolderId,
          items: changes.slice(i, i + CHUNK),
        }),
      });
    }
  }
}

function changeOf(item: ItemRow, node: Pick<NodeRow, 'sizeBytes' | 'mime'> | null): ItemChange {
  return {
    id: item.originId,
    domain: item.originDomain,
    parent:
      item.parentDomain && item.parentOriginId
        ? { id: item.parentOriginId, domain: item.parentDomain }
        : null,
    type: item.type,
    name: item.name,
    version: item.type === 'file' ? item.version : null,
    size: Number(node?.sizeBytes ?? 0),
    mime: node?.mime ?? null,
    changedAt: item.changedAt.toISOString(),
    deleted: item.deletedAt !== null,
  };
}

// ---- Local actions ----

export async function listSharedFolders(deps: FedJobDeps, a: ChatActor, conversationId: string) {
  await requireMember(deps.db, a, conversationId);
  const rows = await deps.db
    .select()
    .from(federationSharedFolders)
    .where(
      and(
        eq(federationSharedFolders.orgId, a.org.id),
        eq(federationSharedFolders.conversationId, conversationId),
      ),
    )
    .orderBy(asc(federationSharedFolders.createdAt));
  return { items: await Promise.all(rows.map((r) => toFolder(deps, r))) };
}

/** "Klasör paylaş" on the host: a folder of the channel's space joins the shared channel. */
export async function shareFolder(
  deps: FedJobDeps,
  a: ChatActor,
  conversationId: string,
  nodeId: string,
): Promise<SharedFolder> {
  requireShared(a.org);
  if (a.actor.orgRole === 'guest') throw new AppError('forbidden');
  const m = await requireMember(deps.db, a, conversationId);
  requireInviter(a, m, a.org);
  const conv = m.conv;
  if (conv.type !== 'space' || !conv.spaceId || conv.archivedAt) {
    throw new AppError('federation_not_allowed', { reason: 'type' });
  }
  const [hosted] = await deps.db
    .select({ id: federationSharedChannels.id })
    .from(federationSharedChannels)
    .where(
      and(
        eq(federationSharedChannels.conversationId, conv.id),
        eq(federationSharedChannels.role, 'host'),
        inArray(federationSharedChannels.status, ['invited', 'active']),
      ),
    )
    .limit(1);
  if (!hosted) throw new AppError('federation_not_allowed', { reason: 'not_shared' });
  const node = await liveNode(deps.db, nodeId);
  if (!node || node.orgId !== a.org.id || node.spaceId !== conv.spaceId || node.type !== 'folder') {
    throw new AppError('invalid_target');
  }
  const current = await deps.db
    .select()
    .from(federationSharedFolders)
    .where(
      and(
        eq(federationSharedFolders.conversationId, conv.id),
        eq(federationSharedFolders.status, 'active'),
      ),
    );
  const same = current.find((f) => f.rootNodeId === node.id);
  if (same) return toFolder(deps, same);
  if (current.length >= MAX_FOLDERS_PER_CHANNEL) {
    throw new AppError('conflict', { reason: 'too_many_folders' });
  }
  const id = newId();
  const [row] = await deps.db
    .insert(federationSharedFolders)
    .values({
      id,
      orgId: a.org.id,
      conversationId: conv.id,
      role: 'host',
      status: 'active',
      hostFolderId: id,
      rootNodeId: node.id,
      name: node.name,
      createdBy: a.userId,
    })
    .returning();
  // The baseline first: everything in it counts as already sent, then the full copy goes out.
  await scanFolder(deps, a.org, row!, false);
  for (const t of await targetsOf(deps, a.org, row!)) {
    await offerFolder(deps, a.org, row!, t.peer, t.remoteConversationId);
  }
  await audit(deps.db, {
    orgId: a.org.id,
    actorId: a.userId,
    action: 'federation.folder.share',
    targetType: 'node',
    targetId: node.id,
    meta: { conversationId: conv.id, folderId: id },
  });
  return toFolder(deps, row!);
}

/** Host: stops sharing the folder (every copy stays); guest admin: stops keeping it in step. */
export async function endSharedFolder(
  deps: FedJobDeps,
  a: ChatActor,
  conversationId: string,
  folderId: string,
): Promise<SharedFolder> {
  const m = await requireMember(deps.db, a, conversationId);
  const [folder] = await deps.db
    .select()
    .from(federationSharedFolders)
    .where(
      and(
        eq(federationSharedFolders.id, folderId),
        eq(federationSharedFolders.conversationId, conversationId),
      ),
    );
  if (!folder) throw new AppError('not_found');
  if (folder.role === 'host') requireInviter(a, m, a.org);
  else if (!isAdmin(a)) throw new AppError('forbidden');
  if (folder.status === 'ended') return toFolder(deps, folder);
  if (folder.role === 'host') {
    for (const t of await targetsOf(deps, a.org, folder)) {
      await deps.jobs.send('federation.deliver', {
        orgId: a.org.id,
        domain: t.peer.domain,
        activity: newActivity('folder.end', { folderId: folder.hostFolderId }),
      });
    }
  }
  const row = await endFolder(deps.db, folder.id);
  await audit(deps.db, {
    orgId: a.org.id,
    actorId: a.userId,
    action: 'federation.folder.end',
    targetType: 'conversation',
    targetId: conversationId,
    meta: { folderId: folder.id },
  });
  return toFolder(deps, row);
}

async function endFolder(db: DbOrTx, id: string) {
  const [row] = await db
    .update(federationSharedFolders)
    .set({ status: 'ended', updatedAt: new Date() })
    .where(eq(federationSharedFolders.id, id))
    .returning();
  return row!;
}

/** Guest copies of a channel stop following the host (the share closed). */
export async function endGuestFolders(db: DbOrTx, orgId: string, conversationId: string) {
  await db
    .update(federationSharedFolders)
    .set({ status: 'ended', updatedAt: new Date() })
    .where(
      and(
        eq(federationSharedFolders.orgId, orgId),
        eq(federationSharedFolders.conversationId, conversationId),
        eq(federationSharedFolders.role, 'guest'),
      ),
    );
}

/**
 * The folder to one guest: `folder.share` (synchronous, so the copy exists before its items)
 * and then every live item, parents first.
 */
export async function offerFolder(
  deps: FedJobDeps,
  org: FedOrg,
  folder: FolderRow,
  peer: PeerRow,
  remoteConversationId: string | null,
) {
  if (!remoteConversationId) return;
  await postActivity(
    deps,
    org.id,
    peer.domain,
    newActivity('folder.share', {
      conversationId: remoteConversationId,
      folder: { id: folder.hostFolderId, name: folder.name },
    }),
  );
  const rows = await deps.db
    .select({ item: federationFolderItems, node: nodes })
    .from(federationFolderItems)
    .leftJoin(nodes, eq(nodes.id, federationFolderItems.nodeId))
    .where(
      and(eq(federationFolderItems.folderId, folder.id), isNull(federationFolderItems.deletedAt)),
    )
    .orderBy(sql`nlevel(${nodes.path})`);
  await send(
    deps,
    org,
    [{ peer }],
    folder,
    rows.map((r) => changeOf(r.item, r.node)),
  );
}

/** federation.share_joined: a guest accepted; it gets every shared folder of the channel. */
export async function offerFoldersTo(
  deps: FedJobDeps,
  org: FedOrg,
  conversationId: string,
  peer: PeerRow,
) {
  const [link] = await deps.db
    .select({ remote: federationConversations.remoteConversationId })
    .from(federationConversations)
    .where(
      and(
        eq(federationConversations.conversationId, conversationId),
        eq(federationConversations.peerId, peer.id),
      ),
    );
  const folders = await deps.db
    .select()
    .from(federationSharedFolders)
    .where(
      and(
        eq(federationSharedFolders.conversationId, conversationId),
        eq(federationSharedFolders.role, 'host'),
        eq(federationSharedFolders.status, 'active'),
      ),
    );
  for (const f of folders) {
    await scanFolder(deps, org, f, true);
    await offerFolder(deps, org, f, peer, link?.remote ?? null);
  }
}

// ---- Scanning (local changes) ----

/**
 * Compares the folder in Drive with the items last sent or applied and records the
 * differences; with `emit` they go to the folder's peers. Files and folders only.
 */
export async function scanFolder(deps: FedJobDeps, org: FedOrg, folder: FolderRow, emit: boolean) {
  if (folder.status !== 'active') return;
  const root = await liveNode(deps.db, folder.rootNodeId);
  if (!root) {
    // The copy is gone here: nothing to keep in step any more.
    await endFolder(deps.db, folder.id);
    return;
  }
  const own = ownDomain(deps.env);
  const live = await deps.db
    .select()
    .from(nodes)
    .where(
      and(
        sql`${nodes.path} <@ ${root.path}::ltree`,
        ne(nodes.id, root.id),
        isNull(nodes.deletedAt),
        inArray(nodes.type, ['file', 'folder']),
      ),
    )
    .orderBy(sql`nlevel(${nodes.path})`);
  const items = await deps.db
    .select()
    .from(federationFolderItems)
    .where(eq(federationFolderItems.folderId, folder.id));
  const byNode = new Map(
    items.filter((i) => i.nodeId && !i.deletedAt).map((i) => [i.nodeId!, i] as const),
  );
  const seen = new Set<string>();
  const changes: ItemChange[] = [];
  let count = byNode.size;
  const now = new Date();
  for (const node of live) {
    const parentItem = node.parentId === root.id ? null : byNode.get(node.parentId ?? '');
    // Inside something that is not synced (a page, a board): left out with its parent.
    if (node.parentId !== root.id && !parentItem) continue;
    seen.add(node.id);
    const parent = parentItem
      ? { parentDomain: parentItem.originDomain, parentOriginId: parentItem.originId }
      : { parentDomain: null, parentOriginId: null };
    const item = byNode.get(node.id);
    if (!item) {
      if (count >= MAX_ITEMS_PER_FOLDER) continue;
      count++;
      const [row] = await deps.db
        .insert(federationFolderItems)
        .values({
          orgId: org.id,
          folderId: folder.id,
          originDomain: own,
          originId: newId(),
          nodeId: node.id,
          type: node.type as 'file' | 'folder',
          name: node.name,
          ...parent,
          localParentId: node.parentId,
          localVersionId: node.currentVersionId,
          version: node.type === 'file' ? node.currentVersionId : null,
          changedAt: now,
        })
        .returning();
      byNode.set(node.id, row!);
      changes.push(changeOf(row!, node));
      continue;
    }
    const contentChanged =
      item.type === 'file' &&
      item.pendingVersion === null &&
      item.localVersionId !== node.currentVersionId;
    if (item.name === node.name && item.localParentId === node.parentId && !contentChanged) {
      continue;
    }
    const [row] = await deps.db
      .update(federationFolderItems)
      .set({
        name: node.name,
        ...parent,
        localParentId: node.parentId,
        localVersionId: node.currentVersionId,
        ...(contentChanged ? { version: node.currentVersionId } : {}),
        changedAt: now,
        updatedAt: now,
      })
      .where(eq(federationFolderItems.id, item.id))
      .returning();
    byNode.set(node.id, row!);
    changes.push(changeOf(row!, node));
  }
  for (const item of byNode.values()) {
    if (seen.has(item.nodeId!)) continue;
    const [row] = await deps.db
      .update(federationFolderItems)
      .set({ deletedAt: now, changedAt: now, updatedAt: now })
      .where(eq(federationFolderItems.id, item.id))
      .returning();
    changes.push(changeOf(row!, null));
  }
  if (emit && changes.length) {
    await send(deps, org, await targetsOf(deps, org, folder), folder, changes);
  }
}

/** federation.folder_scan (every minute): every active shared folder of this installation. */
export async function scanSharedFolders(deps: FedJobDeps) {
  const folders = await deps.db
    .select()
    .from(federationSharedFolders)
    .where(eq(federationSharedFolders.status, 'active'));
  const orgs = new Map<string, FedOrg | null>();
  for (const f of folders) {
    if (!orgs.has(f.orgId)) orgs.set(f.orgId, await loadOrg(deps.db, f.orgId));
    const org = orgs.get(f.orgId);
    if (!org) continue;
    try {
      await scanFolder(deps, org, f, true);
    } catch (err) {
      deps.logger.warn({ err, folderId: f.id }, 'shared folder scan failed');
    }
  }
}

// ---- Inbound ----

async function folderFor(deps: FedJobDeps, org: FedOrg, peer: PeerRow, hostFolderId: string) {
  const [folder] = await deps.db
    .select()
    .from(federationSharedFolders)
    .where(
      and(
        eq(federationSharedFolders.orgId, org.id),
        eq(federationSharedFolders.hostFolderId, hostFolderId),
      ),
    );
  if (!folder || folder.status !== 'active') throw new AppError('not_found');
  // Only the folder's host, or a guest with an active share of its channel, talks about it.
  const [share] = await deps.db
    .select({ id: federationSharedChannels.id })
    .from(federationSharedChannels)
    .where(
      and(
        eq(federationSharedChannels.conversationId, folder.conversationId),
        eq(federationSharedChannels.peerId, peer.id),
        eq(federationSharedChannels.status, 'active'),
      ),
    );
  if (!share || (folder.role === 'guest' && folder.peerId !== peer.id)) {
    throw new AppError('federation_not_allowed', { reason: 'not_shared' });
  }
  return folder;
}

/** `folder.share` on a guest: the copy is made at the top of the channel's space. */
export async function receiveFolderShare(
  deps: FedJobDeps,
  org: FedOrg,
  peer: PeerRow,
  input: z.infer<typeof FolderShareActivity>,
) {
  requireShared(org);
  const [link] = await deps.db
    .select()
    .from(federationConversations)
    .where(
      and(
        eq(federationConversations.peerId, peer.id),
        eq(federationConversations.conversationId, input.conversationId),
      ),
    );
  if (!link || link.homeDomain !== peer.domain) throw new AppError('not_found');
  const [share] = await deps.db
    .select({ id: federationSharedChannels.id })
    .from(federationSharedChannels)
    .where(
      and(
        eq(federationSharedChannels.conversationId, link.conversationId),
        eq(federationSharedChannels.peerId, peer.id),
        eq(federationSharedChannels.role, 'guest'),
        eq(federationSharedChannels.status, 'active'),
      ),
    );
  if (!share) throw new AppError('federation_not_allowed', { reason: 'not_shared' });
  const [conv] = await deps.db
    .select()
    .from(conversations)
    .where(eq(conversations.id, link.conversationId));
  if (!conv?.spaceId) throw new AppError('not_found');
  const [known] = await deps.db
    .select()
    .from(federationSharedFolders)
    .where(
      and(
        eq(federationSharedFolders.orgId, org.id),
        eq(federationSharedFolders.hostFolderId, input.folder.id),
      ),
    );
  if (known?.status === 'active' && (await liveNode(deps.db, known.rootNodeId))) return {};
  const root = await createNode(deps.db, org.id, conv, null, 'folder', input.folder.name);
  if (known) {
    await deps.db
      .update(federationSharedFolders)
      .set({
        status: 'active',
        rootNodeId: root.id,
        name: input.folder.name,
        updatedAt: new Date(),
      })
      .where(eq(federationSharedFolders.id, known.id));
    await deps.db.delete(federationFolderItems).where(eq(federationFolderItems.folderId, known.id));
  } else {
    await deps.db.insert(federationSharedFolders).values({
      orgId: org.id,
      conversationId: conv.id,
      peerId: peer.id,
      role: 'guest',
      status: 'active',
      hostFolderId: input.folder.id,
      rootNodeId: root.id,
      name: input.folder.name.slice(0, 255),
    });
  }
  return {};
}

/** `folder.end` on a guest: the copy stays as a plain folder. */
export async function receiveFolderEnd(
  deps: FedJobDeps,
  org: FedOrg,
  peer: PeerRow,
  input: z.infer<typeof FolderRefActivity>,
) {
  const [folder] = await deps.db
    .select()
    .from(federationSharedFolders)
    .where(
      and(
        eq(federationSharedFolders.orgId, org.id),
        eq(federationSharedFolders.hostFolderId, input.folderId),
        eq(federationSharedFolders.peerId, peer.id),
      ),
    );
  if (folder) await endFolder(deps.db, folder.id);
  return {};
}

/** A node made for a remote item (no author here: `createdBy` stays null). */
async function createNode(
  db: DbOrTx,
  orgId: string,
  conv: Pick<ConversationRow, 'spaceId'>,
  parent: Pick<NodeRow, 'id' | 'path'> | null,
  type: 'file' | 'folder',
  name: string,
  mime: string | null = null,
) {
  const spaceId = conv.spaceId!;
  const id = newId();
  const [row] = await db
    .insert(nodes)
    .values({
      id,
      orgId,
      spaceId,
      parentId: parent?.id ?? null,
      type,
      name: await freeName(db, spaceId, parent?.id ?? null, name.slice(0, 255)),
      mime: type === 'file' ? mime : null,
      sizeBytes: 0,
      position: await positionIn(db, spaceId, parent?.id ?? null),
      path: childPath(parent?.path ?? null, id),
    })
    .returning();
  return row!;
}

async function itemByOrigin(db: DbOrTx, folderId: string, origin: Origin) {
  const [row] = await db
    .select()
    .from(federationFolderItems)
    .where(
      and(
        eq(federationFolderItems.folderId, folderId),
        eq(federationFolderItems.originDomain, origin.domain),
        eq(federationFolderItems.originId, origin.id),
      ),
    );
  return row ?? null;
}

/** Moves a node under another parent (same space), with its subtree's paths. */
async function moveNode(db: DbOrTx, node: NodeRow, parent: NodeRow) {
  if (node.parentId === parent.id) return node;
  const name = await freeName(db, node.spaceId, parent.id, node.name);
  const path = childPath(parent.path, node.id);
  await rewriteSubtree(db, node.path, path);
  const [row] = await db
    .update(nodes)
    .set({
      parentId: parent.id,
      name,
      position: await positionIn(db, node.spaceId, parent.id),
      updatedAt: new Date(),
    })
    .where(eq(nodes.id, node.id))
    .returning();
  return row!;
}

/**
 * `folder.items`: remote changes, applied with their item rows in one transaction. A stale
 * change (older than what is here) is skipped; a new file version is pulled afterwards. The
 * host relays what it applied to the other guests.
 */
export async function receiveFolderItems(
  deps: FedJobDeps,
  org: FedOrg,
  peer: PeerRow,
  input: z.infer<typeof FolderItemsActivity>,
) {
  const folder = await folderFor(deps, org, peer, input.folderId);
  const root = await liveNode(deps.db, folder.rootNodeId);
  if (!root) return {};
  const [conv] = await deps.db
    .select()
    .from(conversations)
    .where(eq(conversations.id, folder.conversationId));
  if (!conv?.spaceId) return {};
  const relay: ItemChange[] = [];
  const pulls: string[] = [];
  for (const change of input.items) {
    const at = new Date(change.changedAt);
    if (Number.isNaN(at.getTime())) continue;
    const pulled = await deps.db.transaction(async (tx) => {
      const item = await itemByOrigin(tx, folder.id, change);
      if (item && item.changedAt > at) return null;
      const now = new Date();
      if (change.deleted) {
        const node = await liveNode(tx, item?.nodeId ?? null);
        if (node) {
          await tx
            .update(nodes)
            .set({ deletedAt: now, deletedBy: null })
            .where(and(sql`${nodes.path} <@ ${node.path}::ltree`, isNull(nodes.deletedAt)));
        }
        if (item) {
          await tx
            .update(federationFolderItems)
            .set({ deletedAt: now, changedAt: at, updatedAt: now })
            .where(eq(federationFolderItems.id, item.id));
        }
        relay.push(change);
        return null;
      }
      const parentItem = change.parent ? await itemByOrigin(tx, folder.id, change.parent) : null;
      const parent = (await liveNode(tx, parentItem?.nodeId ?? null)) ?? root;
      let node = await liveNode(tx, item?.nodeId ?? null);
      if (!node) {
        node = await createNode(tx, org.id, conv, parent, change.type, change.name, change.mime);
      } else {
        node = await moveNode(tx, node, parent);
        if (node.name !== change.name) {
          const name = await freeName(tx, node.spaceId, node.parentId, change.name);
          const [renamed] = await tx
            .update(nodes)
            .set({ name, updatedAt: now })
            .where(eq(nodes.id, node.id))
            .returning();
          node = renamed!;
        }
      }
      const pull =
        change.type === 'file' && change.version !== null && change.version !== item?.version;
      const values = {
        nodeId: node!.id,
        type: change.type,
        name: node!.name,
        parentDomain: change.parent?.domain ?? null,
        parentOriginId: change.parent?.id ?? null,
        localParentId: node!.parentId,
        localVersionId: node!.currentVersionId,
        pendingVersion: pull ? change.version : null,
        changedAt: at,
        deletedAt: null,
        updatedAt: now,
      };
      const [row] = item
        ? await tx
            .update(federationFolderItems)
            .set(values)
            .where(eq(federationFolderItems.id, item.id))
            .returning()
        : await tx
            .insert(federationFolderItems)
            .values({
              orgId: org.id,
              folderId: folder.id,
              originDomain: change.domain,
              originId: change.id,
              ...values,
            })
            .returning();
      // Children that arrived before this folder wait at the top level: they move in now.
      if (change.type === 'folder') {
        const orphans = await tx
          .select({ item: federationFolderItems, node: nodes })
          .from(federationFolderItems)
          .innerJoin(nodes, eq(nodes.id, federationFolderItems.nodeId))
          .where(
            and(
              eq(federationFolderItems.folderId, folder.id),
              eq(federationFolderItems.parentDomain, change.domain),
              eq(federationFolderItems.parentOriginId, change.id),
              ne(nodes.parentId, node!.id),
              isNull(nodes.deletedAt),
            ),
          );
        for (const o of orphans) {
          const moved = await moveNode(tx, o.node, node!);
          await tx
            .update(federationFolderItems)
            .set({ localParentId: moved.parentId, name: moved.name })
            .where(eq(federationFolderItems.id, o.item.id));
        }
      }
      if (!pull) relay.push(change);
      return pull ? row!.id : null;
    });
    if (pulled) pulls.push(pulled);
  }
  for (const itemId of pulls) {
    await deps.jobs.send('federation.folder_pull', { orgId: org.id, itemId, peerId: peer.id });
  }
  if (folder.role === 'host' && relay.length) {
    await send(deps, org, await targetsOf(deps, org, folder, peer.id), folder, relay);
  }
  return {};
}

// ---- File content ----

/** POST /api/federation/v1/files `{ type: 'folder.file.get', folderId, item }`. */
export async function serveFolderFile(deps: FedJobDeps, org: FedOrg, peer: PeerRow, json: unknown) {
  const parsed = z
    .object({ type: z.literal('folder.file.get'), folderId: z.uuid(), item: Origin })
    .safeParse(json);
  if (!parsed.success) throw new AppError('bad_request');
  const folder = await folderFor(deps, org, peer, parsed.data.folderId);
  const item = await itemByOrigin(deps.db, folder.id, parsed.data.item);
  if (!item?.nodeId || item.deletedAt || item.type !== 'file') throw new AppError('not_found');
  return blobContent(deps, org, item.nodeId);
}

/**
 * federation.folder_pull: the bytes of a remote file version, stored as this copy's next
 * version (the item row moves to it in the same transaction). The host then relays it on.
 */
export async function pullFolderFile(
  deps: FedJobDeps,
  data: { orgId: string; itemId: string; peerId: string },
) {
  const [item] = await deps.db
    .select()
    .from(federationFolderItems)
    .where(
      and(eq(federationFolderItems.id, data.itemId), eq(federationFolderItems.orgId, data.orgId)),
    );
  if (!item?.pendingVersion || !item.nodeId || item.deletedAt) return;
  const [folder] = await deps.db
    .select()
    .from(federationSharedFolders)
    .where(eq(federationSharedFolders.id, item.folderId));
  const org = await loadOrg(deps.db, data.orgId);
  const peer = await peerById(deps.db, data.peerId);
  const giveUp = () =>
    deps.db
      .update(federationFolderItems)
      .set({ pendingVersion: null })
      .where(eq(federationFolderItems.id, item.id));
  if (!folder || folder.status !== 'active' || !org || !peer || !peerActive(org, peer)) {
    return void (await giveUp());
  }
  const res = await fetchSigned(deps, org, peer, {
    type: 'folder.file.get',
    folderId: folder.hostFolderId,
    item: { id: item.originId, domain: item.originDomain },
  });
  if (res.status >= 500) throw new Error(`folder file pull ${res.status}`);
  if (!res.ok) return void (await giveUp());
  let content: Buffer;
  try {
    content = await readLimited(res, sharedSettings(org).maxFileMb * MB);
  } catch (err) {
    if (err instanceof AppError) return void (await giveUp());
    throw err;
  }
  const storage = requireStorage(deps);
  const blobId = newId();
  const storageKey = `orgs/${org.id}/blobs/${blobId}`;
  const mime = res.headers.get('x-crewhall-mime') ?? 'application/octet-stream';
  await storage.put(storageKey, content, mime);
  const done = await deps.db.transaction(async (tx) => {
    const [node] = await tx
      .select()
      .from(nodes)
      .where(and(eq(nodes.id, item.nodeId!), isNull(nodes.deletedAt)))
      .for('update');
    const [fresh] = await tx
      .select()
      .from(federationFolderItems)
      .where(eq(federationFolderItems.id, item.id));
    if (!node || fresh?.pendingVersion !== item.pendingVersion) return null;
    await tx.insert(blobs).values({
      id: blobId,
      orgId: org.id,
      size: content.length,
      mime,
      storageKey,
      status: 'pending',
      refCount: 1,
    });
    const [last] = await tx
      .select({ n: sql<number>`coalesce(max(${nodeVersions.version}), 0)::int` })
      .from(nodeVersions)
      .where(eq(nodeVersions.nodeId, node.id));
    const [version] = await tx
      .insert(nodeVersions)
      .values({
        orgId: org.id,
        nodeId: node.id,
        version: (last?.n ?? 0) + 1,
        blobId,
        sizeBytes: content.length,
        mime,
        source: 'api',
      })
      .returning();
    await tx
      .update(nodes)
      .set({
        currentVersionId: version!.id,
        sizeBytes: content.length,
        mime,
        updatedAt: new Date(),
      })
      .where(eq(nodes.id, node.id));
    await adjustSpaceBytes(tx, node.spaceId, content.length);
    const [row] = await tx
      .update(federationFolderItems)
      .set({
        localVersionId: version!.id,
        version: item.pendingVersion,
        pendingVersion: null,
        updatedAt: new Date(),
      })
      .where(eq(federationFolderItems.id, item.id))
      .returning();
    return { row: row!, node: { sizeBytes: content.length, mime } };
  });
  if (!done) return;
  await deps.jobs.send('blob.process', { blobId });
  if (folder.role === 'host') {
    await send(deps, org, await targetsOf(deps, org, folder, peer.id), folder, [
      changeOf(done.row, done.node),
    ]);
  }
}
