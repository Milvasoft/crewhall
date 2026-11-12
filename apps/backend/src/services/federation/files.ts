import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  blobs,
  conversations,
  federationConversations,
  federationFiles,
  federationPeers,
  federationSharedChannels,
  messageAttachments,
  messages,
  newId,
  nodes,
  nodeVersions,
  organizations,
  type DbOrTx,
} from '@crewhall/db';
import { resources } from '@crewhall/i18n';
import { AppError } from '../../http/errors';
import { outboundFetch } from '../../net/outbound';
import { loadConversation, type ConversationRow, type MessageRow } from '../chat/access';
import { publishMessage } from '../chat/messages';
import { requireStorage } from '../drive/files';
import { adjustSpaceBytes, childPath, findByName, freeName, positionIn } from '../drive/tree';
import { federateMessage } from './chat';
import {
  baseUrl,
  newActivity,
  ownDomain,
  peerActive,
  type FedJobDeps,
  type FedOrg,
  type PeerRow,
} from './core';
import { instanceKey } from './keys';
import { sharedSettings } from './shared';
import { signRequest } from './signature';

/**
 * Files of shared channels (kararlar.md 2026-10-29): a message carries only the metadata and
 * a random id; the receiving installation pulls the bytes with a signed request and keeps
 * its own copy in the channel's Ekler folder.
 */

export const FILES_PATH = '/api/federation/v1/files';
const PULL_TIMEOUT_MS = 60_000;
export const MB = 1024 * 1024;

export const RemoteFile = z.object({
  ref: z.uuid(),
  name: z.string().min(1).max(255),
  mime: z.string().max(255).nullable(),
  size: z.number().int().min(0),
});
export type RemoteFile = z.infer<typeof RemoteFile>;

/** Files only travel in channels shared with organizations (not person-to-person chats). */
async function sharedChannel(db: DbOrTx, conversationId: string) {
  const [row] = await db
    .select({ id: federationSharedChannels.id })
    .from(federationSharedChannels)
    .where(
      and(
        eq(federationSharedChannels.conversationId, conversationId),
        eq(federationSharedChannels.status, 'active'),
      ),
    )
    .limit(1);
  return !!row;
}

/** The message's attachments offered to peers: one random id per file, reused on relays. */
export async function offerFiles(
  db: DbOrTx,
  org: FedOrg,
  conv: ConversationRow,
  msg: MessageRow,
): Promise<RemoteFile[]> {
  if (!(await sharedChannel(db, conv.id))) return [];
  const limit = sharedSettings(org).maxFileMb * MB;
  const files = await db
    .select({
      nodeId: nodes.id,
      name: nodes.name,
      mime: nodes.mime,
      size: nodes.sizeBytes,
      position: messageAttachments.position,
    })
    .from(messageAttachments)
    .innerJoin(nodes, eq(nodes.id, messageAttachments.nodeId))
    .where(
      and(
        eq(messageAttachments.messageId, msg.id),
        eq(nodes.type, 'file'),
        isNull(nodes.deletedAt),
      ),
    )
    .orderBy(asc(messageAttachments.position));
  const out: RemoteFile[] = [];
  for (const f of files) {
    const size = Number(f.size ?? 0);
    if (size > limit) continue;
    const [known] = await db
      .select({ id: federationFiles.id })
      .from(federationFiles)
      .where(
        and(
          eq(federationFiles.kind, 'out'),
          eq(federationFiles.messageId, msg.id),
          eq(federationFiles.nodeId, f.nodeId),
        ),
      );
    const ref =
      known?.id ??
      (
        await db
          .insert(federationFiles)
          .values({
            orgId: conv.orgId,
            kind: 'out',
            conversationId: conv.id,
            messageId: msg.id,
            nodeId: f.nodeId,
            name: f.name,
            mime: f.mime,
            sizeBytes: size,
            position: f.position,
            status: 'ready',
          })
          .returning({ id: federationFiles.id })
      )[0]!.id;
    out.push({ ref, name: f.name, mime: f.mime, size });
  }
  return out;
}

/** Files announced with a received message: queued for pulling. Returns how many wait. */
export async function receiveFiles(
  deps: FedJobDeps,
  org: FedOrg,
  peerId: string,
  conv: ConversationRow,
  msg: MessageRow,
  files: RemoteFile[],
) {
  if (files.length === 0 || !(await sharedChannel(deps.db, conv.id))) return 0;
  const limit = sharedSettings(org).maxFileMb * MB;
  let waiting = 0;
  for (const [position, f] of files.entries()) {
    const tooBig = f.size > limit;
    const [row] = await deps.db
      .insert(federationFiles)
      .values({
        orgId: org.id,
        kind: 'in',
        conversationId: conv.id,
        messageId: msg.id,
        peerId,
        originRef: f.ref,
        name: f.name,
        mime: f.mime,
        sizeBytes: f.size,
        position,
        status: tooBig ? 'failed' : 'pending',
      })
      .returning();
    if (!tooBig) {
      waiting++;
      await deps.jobs.send('federation.file_pull', { orgId: org.id, fileId: row!.id });
    }
  }
  return waiting;
}

// ---- Serving (origin side) ----

/**
 * POST /api/federation/v1/files `{ type: 'file.get', ref }`: the bytes of a file offered in a
 * conversation linked with the asking peer. Anything else is not found.
 */
export async function serveFile(
  deps: FedJobDeps,
  org: FedOrg,
  peerId: string,
  json: unknown,
): Promise<{ content: Buffer; contentType: string; name: string }> {
  const parsed = z.object({ type: z.literal('file.get'), ref: z.uuid() }).safeParse(json);
  if (!parsed.success) throw new AppError('bad_request');
  const [file] = await deps.db
    .select({ file: federationFiles })
    .from(federationFiles)
    .innerJoin(
      federationConversations,
      and(
        eq(federationConversations.conversationId, federationFiles.conversationId),
        eq(federationConversations.peerId, peerId),
      ),
    )
    .where(
      and(
        eq(federationFiles.id, parsed.data.ref),
        eq(federationFiles.orgId, org.id),
        eq(federationFiles.kind, 'out'),
      ),
    );
  if (!file?.file.nodeId || !(await sharedChannel(deps.db, file.file.conversationId))) {
    throw new AppError('not_found');
  }
  return blobContent(deps, org, file.file.nodeId);
}

/** The current content of a Drive file handed to a peer, within the org's file limit. */
export async function blobContent(
  deps: Pick<FedJobDeps, 'db' | 'storage'>,
  org: FedOrg,
  nodeId: string,
): Promise<{ content: Buffer; contentType: string; name: string }> {
  const [row] = await deps.db
    .select({ node: nodes, blob: blobs })
    .from(nodes)
    .innerJoin(nodeVersions, eq(nodeVersions.id, nodes.currentVersionId))
    .innerJoin(blobs, eq(blobs.id, nodeVersions.blobId))
    .where(and(eq(nodes.id, nodeId), isNull(nodes.deletedAt)));
  // Quarantined files are not handed out; vault-encrypted blobs are useless to the peer.
  if (!row || row.blob.status === 'quarantined' || row.blob.encrypted) {
    throw new AppError('not_found');
  }
  if (row.blob.size > sharedSettings(org).maxFileMb * MB) throw new AppError('file_too_large');
  const stream = await requireStorage(deps).getStream(row.blob.storageKey);
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
  return {
    content: Buffer.concat(chunks),
    contentType: row.node.mime ?? row.blob.mime ?? 'application/octet-stream',
    name: row.node.name,
  };
}

// ---- Pulling (receiving side) ----

/** Reads at most `limit` bytes; a larger body is refused (the sender lied about the size). */
export async function readLimited(res: Response, limit: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > limit) throw new AppError('file_too_large');
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > limit) throw new AppError('file_too_large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

const folderNames = (locale: 'tr' | 'en') => resources[locale].email.chat.folders;

/** Space › Ekler › <channel>, made on first use like a local attachment's. */
async function channelFolder(db: DbOrTx, org: FedOrg, conv: ConversationRow) {
  if (conv.attachmentsNodeId) {
    const [existing] = await db
      .select({ id: nodes.id, path: nodes.path, spaceId: nodes.spaceId })
      .from(nodes)
      .where(and(eq(nodes.id, conv.attachmentsNodeId), isNull(nodes.deletedAt)));
    if (existing) return existing;
  }
  const locale = (org.settings as { defaultLocale?: 'tr' | 'en' }).defaultLocale ?? 'tr';
  const names = folderNames(locale === 'en' ? 'en' : 'tr');
  const spaceId = conv.spaceId!;
  const folder = async (parent: { id: string; path: string } | null, name: string) => {
    const found = await findByName(db, spaceId, parent?.id ?? null, name);
    if (found && found.type === 'folder') {
      const [row] = await db
        .select({ id: nodes.id, path: nodes.path, spaceId: nodes.spaceId })
        .from(nodes)
        .where(eq(nodes.id, found.id));
      return row!;
    }
    const id = newId();
    const [row] = await db
      .insert(nodes)
      .values({
        id,
        orgId: org.id,
        spaceId,
        parentId: parent?.id ?? null,
        type: 'folder',
        name: found ? await freeName(db, spaceId, parent?.id ?? null, name) : name,
        position: await positionIn(db, spaceId, parent?.id ?? null),
        path: childPath(parent?.path ?? null, id),
      })
      .returning({ id: nodes.id, path: nodes.path, spaceId: nodes.spaceId });
    return row!;
  };
  const root = await folder(null, names.attachments);
  const f = await folder(root, conv.name ?? names.attachments);
  await db
    .update(conversations)
    .set({ attachmentsNodeId: f.id })
    .where(eq(conversations.id, conv.id));
  return f;
}

/** Stores pulled bytes as a Drive file of the channel and attaches it to the message. */
async function storeFile(
  deps: FedJobDeps,
  org: FedOrg,
  conv: ConversationRow,
  file: typeof federationFiles.$inferSelect,
  content: Buffer,
) {
  const storage = requireStorage(deps);
  const blobId = newId();
  const storageKey = `orgs/${org.id}/blobs/${blobId}`;
  const mime = file.mime ?? 'application/octet-stream';
  await storage.put(storageKey, content, mime);
  const nodeId = await deps.db.transaction(async (tx) => {
    const parent = await channelFolder(tx, org, conv);
    await tx.insert(blobs).values({
      id: blobId,
      orgId: org.id,
      size: content.length,
      mime,
      storageKey,
      status: 'pending',
      refCount: 1,
    });
    const id = newId();
    await tx.insert(nodes).values({
      id,
      orgId: org.id,
      spaceId: parent.spaceId,
      parentId: parent.id,
      type: 'file',
      name: await freeName(tx, parent.spaceId, parent.id, file.name.slice(0, 255)),
      mime,
      sizeBytes: content.length,
      position: await positionIn(tx, parent.spaceId, parent.id),
      path: childPath(parent.path, id),
    });
    const [version] = await tx
      .insert(nodeVersions)
      .values({
        orgId: org.id,
        nodeId: id,
        version: 1,
        blobId,
        sizeBytes: content.length,
        mime,
        source: 'api',
      })
      .returning();
    await tx.update(nodes).set({ currentVersionId: version!.id }).where(eq(nodes.id, id));
    await adjustSpaceBytes(tx, parent.spaceId, content.length);
    await tx.insert(messageAttachments).values({
      messageId: file.messageId,
      nodeId: id,
      orgId: org.id,
      conversationId: conv.id,
      position: file.position,
    });
    await tx
      .update(federationFiles)
      .set({ status: 'done', nodeId: id })
      .where(eq(federationFiles.id, file.id));
    return id;
  });
  // Type sniffing and the virus scan, like an upload.
  await deps.jobs.send('blob.process', { blobId });
  return nodeId;
}

/**
 * federation.file_pull: fetches one announced file from the peer. A refusal (not found, too
 * large) marks it failed; a network error throws so pg-boss retries. When the message has no
 * file left waiting, the home installation relays it to the other organizations.
 */
export async function pullFile(deps: FedJobDeps, data: { orgId: string; fileId: string }) {
  const [file] = await deps.db
    .select()
    .from(federationFiles)
    .where(and(eq(federationFiles.id, data.fileId), eq(federationFiles.orgId, data.orgId)));
  if (!file || file.status !== 'pending' || !file.peerId || !file.originRef) return;
  const [org] = await deps.db
    .select({ id: organizations.id, name: organizations.name, settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, data.orgId));
  if (!org) return finish(deps, file, 'failed');
  const peer = await peerById(deps.db, file.peerId);
  if (!peer || !peerActive(org, peer)) return finish(deps, file, 'failed');

  const res = await fetchSigned(deps, org, peer, { type: 'file.get', ref: file.originRef });
  if (res.status >= 500) throw new Error(`file pull ${res.status}`);
  if (!res.ok) return finish(deps, file, 'failed');
  let content: Buffer;
  try {
    content = await readLimited(res, sharedSettings(org).maxFileMb * MB);
  } catch (err) {
    if (err instanceof AppError) return finish(deps, file, 'failed');
    throw err;
  }
  const conv = await loadConversation(deps.db, org.id, file.conversationId);
  await storeFile(deps, org, conv, file, content);
  await afterFiles(deps, org, conv, file.messageId, file.peerId);
}

/** A signed POST to the peer's file endpoint (only its domain, through outboundFetch). */
export async function fetchSigned(
  deps: Pick<FedJobDeps, 'db' | 'env'>,
  org: FedOrg,
  peer: PeerRow,
  request: { type: string } & Record<string, unknown>,
) {
  const url = `${baseUrl(deps.env, peer.domain)}${FILES_PATH}`;
  const { type, ...fields } = request;
  const body = JSON.stringify(newActivity(type, fields));
  const key = await instanceKey(deps.db, deps.env.AUTH_SECRET, org.id);
  const headers = signRequest({
    method: 'POST',
    url,
    body,
    keyId: ownDomain(deps.env),
    privateKey: key!.privateKey,
  });
  return outboundFetch(url, {
    method: 'POST',
    headers: { ...headers, Accept: 'application/octet-stream' },
    body,
    redirect: 'manual',
    timeoutMs: PULL_TIMEOUT_MS,
  });
}

export async function peerById(db: DbOrTx, id: string) {
  const [peer] = await db.select().from(federationPeers).where(eq(federationPeers.id, id));
  return peer ?? null;
}

async function finish(
  deps: FedJobDeps,
  file: typeof federationFiles.$inferSelect,
  status: 'failed',
) {
  await deps.db.update(federationFiles).set({ status }).where(eq(federationFiles.id, file.id));
  const [org] = await deps.db
    .select({ id: organizations.id, name: organizations.name, settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, file.orgId));
  const conv = await loadConversation(deps.db, file.orgId, file.conversationId).catch(() => null);
  if (org && conv) await afterFiles(deps, org, conv, file.messageId, file.peerId);
}

/** Every file of the message is in (or failed): show it and, on the home, relay it on. */
async function afterFiles(
  deps: FedJobDeps,
  org: FedOrg,
  conv: ConversationRow,
  messageId: string,
  fromPeerId: string | null,
) {
  const [msg] = await deps.db.select().from(messages).where(eq(messages.id, messageId));
  if (!msg) return;
  await publishMessage(deps, conv, 'message.updated', msg);
  const [waiting] = await deps.db
    .select({ id: federationFiles.id })
    .from(federationFiles)
    .where(
      and(
        eq(federationFiles.messageId, messageId),
        eq(federationFiles.kind, 'in'),
        eq(federationFiles.status, 'pending'),
      ),
    )
    .limit(1);
  if (waiting) return;
  const [link] = await deps.db
    .select({ homeDomain: federationConversations.homeDomain })
    .from(federationConversations)
    .where(eq(federationConversations.conversationId, conv.id))
    .limit(1);
  if (link?.homeDomain !== ownDomain(deps.env)) return;
  await federateMessage(deps, conv, msg, fromPeerId ?? undefined);
}
