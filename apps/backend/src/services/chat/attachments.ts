import { and, desc, eq, gte, isNull, lt, or, sql } from 'drizzle-orm';
import {
  conversations,
  messageAttachments,
  messages,
  newId,
  nodes,
  type DbOrTx,
} from '@crewhall/db';
import { resources } from '@crewhall/i18n';
import type { Disposition, PreviewKind } from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import { fileDownload, filePreview } from '../drive/files';
import { childPath, findByName, freeName, positionIn } from '../drive/tree';
import { personalSpaceId } from '../spaces';
import {
  historyFrom,
  requireMember,
  requireMessage,
  requirePermission,
  spaceBound,
  type ChatActor,
} from './access';
import { toMessages } from './views';

/**
 * Chat attachments live in Drive (design 4.9, 04 rules): a space conversation's under
 * Space › Ekler › <conversation>, direct and group ones in the sender's
 * Kişisel › Chat ekleri. Folders are created by the server on first use.
 */

const folderNames = (locale: 'tr' | 'en') => resources[locale].email.chat.folders;

async function ensureFolder(
  db: DbOrTx,
  orgId: string,
  spaceId: string,
  parent: { id: string; path: string } | null,
  name: string,
  userId: string,
) {
  const found = await findByName(db, spaceId, parent?.id ?? null, name);
  if (found && found.type === 'folder') {
    const [row] = await db.select().from(nodes).where(eq(nodes.id, found.id));
    return row!;
  }
  const finalName = found ? await freeName(db, spaceId, parent?.id ?? null, name) : name;
  const id = newId();
  const [row] = await db
    .insert(nodes)
    .values({
      id,
      orgId,
      spaceId,
      parentId: parent?.id ?? null,
      type: 'folder',
      name: finalName,
      position: await positionIn(db, spaceId, parent?.id ?? null),
      path: childPath(parent?.path ?? null, id),
      createdBy: userId,
      updatedBy: userId,
    })
    .returning();
  return row!;
}

async function liveNode(db: DbOrTx, id: string | null) {
  if (!id) return null;
  const [row] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), isNull(nodes.deletedAt)));
  return row ?? null;
}

export async function attachmentFolder(deps: Deps, a: ChatActor, conversationId: string) {
  const { db } = deps;
  const m = await requireMember(db, a, conversationId);
  requirePermission(a, m, 'write');
  const names = folderNames(a.org.branding.defaultLocale);
  // Space viewers may chat but not add to the space: their files go to the personal folder.
  if (spaceBound(m.conv) && m.spaceRole && m.spaceRole !== 'viewer' && !m.conv.archivedAt) {
    const existing = await liveNode(db, m.conv.attachmentsNodeId);
    if (existing) return { spaceId: existing.spaceId, folderId: existing.id };
    const folder = await db.transaction(async (tx) => {
      const root = await ensureFolder(
        tx,
        a.org.id,
        m.conv.spaceId!,
        null,
        names.attachments,
        a.userId,
      );
      const title = m.conv.name ?? names.attachments;
      const f = await ensureFolder(tx, a.org.id, m.conv.spaceId!, root, title, a.userId);
      await tx
        .update(conversations)
        .set({ attachmentsNodeId: f.id })
        .where(eq(conversations.id, m.conv.id));
      return f;
    });
    return { spaceId: folder.spaceId, folderId: folder.id };
  }
  const spaceId = await personalSpaceId(db, a.org.id, a.userId);
  if (!spaceId) throw new AppError('forbidden', { reason: 'no_personal_space' });
  const folder = await ensureFolder(db, a.org.id, spaceId, null, names.chatAttachments, a.userId);
  return { spaceId, folderId: folder.id };
}

interface FilesCursor {
  t: string;
  m: string;
}

export async function listChatFiles(
  db: DbOrTx,
  a: ChatActor,
  conversationId: string,
  q: { cursor?: string | undefined; limit: number },
) {
  const m = await requireMember(db, a, conversationId);
  const from = historyFrom(m);
  const base = and(
    eq(messageAttachments.conversationId, conversationId),
    isNull(messages.deletedAt),
    gte(messages.seq, from),
  );
  let cursor: FilesCursor | null = null;
  if (q.cursor) {
    try {
      cursor = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8')) as FilesCursor;
    } catch {
      throw new AppError('bad_request', { reason: 'invalid_cursor' });
    }
  }
  const rows = await db
    .select({ att: messageAttachments, msg: messages })
    .from(messageAttachments)
    .innerJoin(messages, eq(messages.id, messageAttachments.messageId))
    .where(
      cursor
        ? and(
            base,
            or(
              lt(messageAttachments.createdAt, new Date(cursor.t)),
              and(
                eq(messageAttachments.createdAt, new Date(cursor.t)),
                lt(messageAttachments.messageId, cursor.m),
              ),
            ),
          )
        : base,
    )
    .orderBy(desc(messageAttachments.createdAt), desc(messageAttachments.messageId))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  const views = await toMessages(db, a.userId, [
    ...new Map(page.map((r) => [r.msg.id, r.msg])).values(),
  ]);
  const byId = new Map(views.map((v) => [v.id, v]));
  const [totals] = await db
    .select({
      n: sql<number>`count(*)::int`,
      bytes: sql<number>`coalesce(sum(${nodes.sizeBytes}), 0)::bigint`,
    })
    .from(messageAttachments)
    .innerJoin(messages, eq(messages.id, messageAttachments.messageId))
    .innerJoin(nodes, eq(nodes.id, messageAttachments.nodeId))
    .where(and(base, isNull(nodes.deletedAt)));
  const last = page.at(-1);
  return {
    items: page.flatMap((r) => {
      const v = byId.get(r.msg.id);
      const att = v?.attachments.find((x) => x.nodeId === r.att.nodeId);
      if (!v || !att) return [];
      return [
        {
          attachment: att,
          messageId: r.msg.id,
          seq: r.msg.seq,
          author: v.author,
          createdAt: r.att.createdAt.toISOString(),
        },
      ];
    }),
    nextCursor:
      rows.length > q.limit && last
        ? Buffer.from(
            JSON.stringify({ t: last.att.createdAt.toISOString(), m: last.att.messageId }),
          ).toString('base64url')
        : null,
    totalCount: totals?.n ?? 0,
    totalBytes: Number(totals?.bytes ?? 0),
  };
}

/** Signed URL checked by conversation membership, not Drive access. */
export async function attachmentUrl(
  deps: Deps,
  a: ChatActor,
  messageId: string,
  nodeId: string,
  q: { disposition?: Disposition | undefined; preview?: PreviewKind | undefined },
) {
  const { db } = deps;
  const { msg } = await requireMessage(db, a, messageId);
  if (msg.deletedAt) throw new AppError('chat_attachment_removed');
  const [row] = await db
    .select({ node: nodes })
    .from(messageAttachments)
    .innerJoin(nodes, eq(nodes.id, messageAttachments.nodeId))
    .where(and(eq(messageAttachments.messageId, messageId), eq(messageAttachments.nodeId, nodeId)));
  if (!row) throw new AppError('not_found');
  if (row.node.deletedAt) throw new AppError('chat_attachment_removed');
  if (q.preview) {
    const p = await filePreview(deps, row.node, q.preview);
    // The preview has no file name; answer in the DownloadUrl shape.
    return {
      url: p.url,
      expiresAt: p.expiresAt,
      fileName: row.node.name,
      sizeBytes: row.node.sizeBytes,
      mime: null,
      disposition: 'inline' as const,
    };
  }
  return fileDownload(deps, row.node, undefined, q.disposition);
}
