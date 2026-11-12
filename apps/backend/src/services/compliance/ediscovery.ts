import { strToU8, zipSync, type Zippable } from 'fflate';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  auditLogs,
  blobs,
  boardCards,
  conversationMembers,
  conversations,
  ediscoveryExports,
  heldMessages,
  messages,
  nodes,
  nodeVersions,
  pages,
  spaces,
  users,
  type Db,
  type DbOrTx,
} from '@crewhall/db';
import type { CreateEdiscoveryExport, EdiscoveryExport, EdiscoveryScope } from '@crewhall/shared';
import { AppError } from '../../http/errors';
import type { RequestInfo } from '../../http/types';
import type { Jobs } from '../../jobs/queue';
import type { Logger } from '../../logger';
import type { Storage } from '../../storage/s3';
import { z } from 'zod';
import { identityAudit } from '../identity/audit';

/**
 * eDiscovery (roadmap 25): an admin collects what custodians wrote and what their spaces
 * hold in a date range into one ZIP: chat (with held originals), pages as Markdown, board
 * cards, files and the audit trail, as JSON Lines plus a manifest. The worker builds it
 * (`ediscovery.export`); it stays downloadable for 7 days.
 */

const KEEP_DAYS = 7;
/** Files are copied while their total stays under this; the rest are only listed. */
const FILE_BYTES_CAP = 200 * 1024 * 1024;
const FILE_MAX = 50 * 1024 * 1024;

type Row = typeof ediscoveryExports.$inferSelect;
type Scope = z.infer<typeof EdiscoveryScopeShape>;
/** The stored scope (defaults already applied when it was created). */
const EdiscoveryScopeShape = z.object({
  userIds: z.array(z.string()),
  spaceIds: z.array(z.string()),
  from: z.string().nullable(),
  to: z.string().nullable(),
  include: z.array(z.enum(['chat', 'pages', 'cards', 'files', 'audit'])),
});

async function view(db: DbOrTx, rows: Row[]): Promise<EdiscoveryExport[]> {
  const ids = [...new Set(rows.map((r) => r.requestedBy).filter((v): v is string => !!v))];
  const people = new Map(
    (ids.length ? await db.select().from(users).where(inArray(users.id, ids)) : []).map((u) => [
      u.id,
      { id: u.id, name: u.name, email: u.email, imageUrl: u.image },
    ]),
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status as EdiscoveryExport['status'],
    scope: EdiscoveryScopeShape.parse(r.scope),
    sizeBytes: r.sizeBytes,
    counts: r.counts ?? null,
    error: r.error,
    requestedBy: r.requestedBy ? (people.get(r.requestedBy) ?? null) : null,
    createdAt: r.createdAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    expiresAt: r.expiresAt?.toISOString() ?? null,
  }));
}

export async function listExports(db: DbOrTx, orgId: string) {
  const rows = await db
    .select()
    .from(ediscoveryExports)
    .where(eq(ediscoveryExports.orgId, orgId))
    .orderBy(desc(ediscoveryExports.createdAt))
    .limit(50);
  return view(db, rows);
}

export async function createExport(
  deps: { db: Db; jobs: Jobs },
  actor: { orgId: string; userId: string },
  input: CreateEdiscoveryExport,
  req?: RequestInfo,
) {
  const scope: EdiscoveryScope = input.scope;
  if (scope.spaceIds.length) {
    const found = await deps.db
      .select({ id: spaces.id })
      .from(spaces)
      .where(and(eq(spaces.orgId, actor.orgId), inArray(spaces.id, scope.spaceIds)));
    if (found.length !== new Set(scope.spaceIds).size) throw new AppError('not_found');
  }
  const [row] = await deps.db
    .insert(ediscoveryExports)
    .values({ orgId: actor.orgId, requestedBy: actor.userId, name: input.name, scope })
    .returning();
  await identityAudit(
    deps.db,
    {
      orgId: actor.orgId,
      actorId: actor.userId,
      action: 'compliance.export.create',
      targetType: 'ediscovery_export',
      targetId: row!.id,
      meta: { name: input.name, scope },
    },
    req,
  );
  await deps.jobs.send('ediscovery.export', { exportId: row!.id });
  const [fresh] = await deps.db
    .select()
    .from(ediscoveryExports)
    .where(eq(ediscoveryExports.id, row!.id));
  return (await view(deps.db, [fresh!]))[0]!;
}

export async function exportDownload(
  deps: { db: DbOrTx; storage: Storage | null },
  actor: { orgId: string; userId: string },
  exportId: string,
  req?: RequestInfo,
) {
  const [row] = await deps.db
    .select()
    .from(ediscoveryExports)
    .where(and(eq(ediscoveryExports.id, exportId), eq(ediscoveryExports.orgId, actor.orgId)));
  if (!row || row.status !== 'ready' || !row.storageKey) throw new AppError('not_found');
  if (row.expiresAt && row.expiresAt <= new Date()) throw new AppError('not_found');
  if (!deps.storage) throw new AppError('internal', { reason: 'storage_not_configured' });
  await identityAudit(
    deps.db,
    {
      orgId: actor.orgId,
      actorId: actor.userId,
      action: 'compliance.export.download',
      targetType: 'ediscovery_export',
      targetId: row.id,
    },
    req,
  );
  const link = await deps.storage.presignGet(row.storageKey, {
    fileName: `ediscovery-${row.id}.zip`,
    contentType: 'application/zip',
  });
  return { url: link.url, expiresAt: link.expiresAt.toISOString() };
}

const inRange = (col: SQL | Parameters<typeof gte>[0], s: Scope) =>
  and(
    s.from ? gte(col as never, new Date(s.from)) : undefined,
    s.to ? lte(col as never, new Date(s.to)) : undefined,
  );

const jsonl = (rows: unknown[]) =>
  strToU8(rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));

/** A name usable as a path segment in the archive: no separators or control characters. */
const safe = (name: string) =>
  [...name]
    .map((ch) => (ch.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(ch) ? '_' : ch))
    .join('')
    .slice(0, 120) || 'adsiz';

export interface EdiscoveryJobDeps {
  db: Db;
  storage: Storage | null;
  logger: Logger;
}

/** ediscovery.export: builds the archive and stores it. */
export async function runExport(deps: EdiscoveryJobDeps, exportId: string) {
  const { db } = deps;
  const [row] = await db
    .update(ediscoveryExports)
    .set({ status: 'running' })
    .where(and(eq(ediscoveryExports.id, exportId), eq(ediscoveryExports.status, 'queued')))
    .returning();
  if (!row) return;
  const fail = (error: string) =>
    db
      .update(ediscoveryExports)
      .set({ status: 'failed', error, finishedAt: new Date() })
      .where(eq(ediscoveryExports.id, exportId));
  if (!deps.storage) return void (await fail('storage_unavailable'));
  try {
    const scope = EdiscoveryScopeShape.parse(row.scope);
    const { files, counts } = await collect(db, deps.storage, row.orgId, scope);
    files['manifest.json'] = strToU8(
      JSON.stringify(
        {
          export: { id: row.id, name: row.name, createdAt: row.createdAt.toISOString() },
          generatedAt: new Date().toISOString(),
          scope,
          counts,
          note: 'Crewhall eDiscovery. JSON Lines files have one record per line.',
        },
        null,
        2,
      ),
    );
    const zip = Buffer.from(zipSync(files, { level: 6 }));
    const key = `orgs/${row.orgId}/ediscovery/${row.id}.zip`;
    await deps.storage.put(key, zip, 'application/zip');
    const finishedAt = new Date();
    await db
      .update(ediscoveryExports)
      .set({
        status: 'ready',
        storageKey: key,
        sizeBytes: zip.length,
        counts,
        finishedAt,
        expiresAt: new Date(finishedAt.getTime() + KEEP_DAYS * 86_400_000),
      })
      .where(eq(ediscoveryExports.id, exportId));
  } catch (err) {
    deps.logger.error({ err, exportId }, 'ediscovery export failed');
    await fail((err instanceof Error ? err.message : String(err)).slice(0, 500));
  }
}

async function collect(db: Db, storage: Storage, orgId: string, s: Scope) {
  const files: Zippable = {};
  const counts: Record<string, number> = {};
  const people = s.userIds;
  const spaceIds = s.spaceIds;
  const byPeopleOrSpaces = (spaceCol: SQL, authorCol: SQL) =>
    or(
      spaceIds.length
        ? sql`${spaceCol} in (${sql.join(
            spaceIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`
        : undefined,
      people.length
        ? sql`${authorCol} in (${sql.join(
            people.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`
        : undefined,
    );

  if (s.include.includes('chat')) {
    // Conversations of the custodians and of the spaces.
    const convRows = await db
      .selectDistinct({
        id: conversations.id,
        name: conversations.name,
        type: conversations.type,
        spaceId: conversations.spaceId,
      })
      .from(conversations)
      .leftJoin(conversationMembers, eq(conversationMembers.conversationId, conversations.id))
      .where(
        and(
          eq(conversations.orgId, orgId),
          byPeopleOrSpaces(sql`${conversations.spaceId}`, sql`${conversationMembers.userId}`),
        ),
      );
    const convIds = convRows.map((c) => c.id);
    let total = 0;
    if (convIds.length) {
      const msgs = await db
        .select({ m: messages, author: users.email })
        .from(messages)
        .leftJoin(users, eq(users.id, messages.authorId))
        .where(and(inArray(messages.conversationId, convIds), inRange(messages.createdAt, s)))
        .orderBy(asc(messages.conversationId), asc(messages.seq));
      for (const c of convRows) {
        const list = msgs.filter((r) => r.m.conversationId === c.id);
        if (!list.length) continue;
        total += list.length;
        files[`chat/${c.type}-${c.id}.jsonl`] = jsonl(
          list.map(({ m, author }) => ({
            seq: m.seq,
            at: m.createdAt.toISOString(),
            author,
            kind: m.kind,
            text: m.text,
            editedAt: m.editedAt?.toISOString() ?? null,
            deletedAt: m.deletedAt?.toISOString() ?? null,
          })),
        );
      }
      files['chat/conversations.json'] = strToU8(JSON.stringify(convRows, null, 2));
      const held = await db
        .select()
        .from(heldMessages)
        .where(
          and(
            eq(heldMessages.orgId, orgId),
            inArray(heldMessages.conversationId, convIds),
            inRange(heldMessages.sentAt, s),
          ),
        );
      if (held.length) {
        files['chat/held-originals.jsonl'] = jsonl(
          held.map((h) => ({
            messageId: h.messageId,
            conversationId: h.conversationId,
            authorId: h.authorId,
            kind: h.kind,
            text: h.text,
            sentAt: h.sentAt.toISOString(),
            archivedAt: h.archivedAt.toISOString(),
          })),
        );
      }
      counts.heldOriginals = held.length;
    }
    counts.chatMessages = total;
  }

  if (s.include.includes('pages')) {
    const rows = await db
      .select({ node: nodes, markdown: pages.markdown, space: spaces.name })
      .from(pages)
      .innerJoin(nodes, eq(nodes.id, pages.nodeId))
      .innerJoin(spaces, eq(spaces.id, nodes.spaceId))
      .where(
        and(
          eq(nodes.orgId, orgId),
          byPeopleOrSpaces(sql`${nodes.spaceId}`, sql`${nodes.createdBy}`),
          inRange(nodes.updatedAt, s),
        ),
      );
    for (const r of rows) {
      const head = `---\nid: ${r.node.id}\nspace: ${JSON.stringify(r.space)}\ntitle: ${JSON.stringify(r.node.name)}\nupdated: ${r.node.updatedAt.toISOString()}\ndeleted: ${r.node.deletedAt ? r.node.deletedAt.toISOString() : 'false'}\n---\n\n`;
      files[`pages/${safe(r.space)}/${safe(r.node.name)}-${r.node.id.slice(0, 8)}.md`] = strToU8(
        head + r.markdown,
      );
    }
    counts.pages = rows.length;
  }

  if (s.include.includes('cards')) {
    const rows = await db
      .select({ c: boardCards, board: nodes.name, spaceId: nodes.spaceId })
      .from(boardCards)
      .innerJoin(nodes, eq(nodes.id, boardCards.boardNodeId))
      .where(
        and(
          eq(boardCards.orgId, orgId),
          byPeopleOrSpaces(sql`${nodes.spaceId}`, sql`${boardCards.createdBy}`),
          inRange(boardCards.updatedAt, s),
        ),
      );
    files['cards.jsonl'] = jsonl(
      rows.map(({ c, board, spaceId }) => ({
        id: c.id,
        board,
        spaceId,
        number: c.number,
        title: c.title,
        description: c.descText,
        labels: c.labels,
        dueAt: c.dueAt?.toISOString() ?? null,
        doneAt: c.doneAt?.toISOString() ?? null,
        deletedAt: c.deletedAt?.toISOString() ?? null,
        createdBy: c.createdBy,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
      })),
    );
    counts.cards = rows.length;
  }

  if (s.include.includes('files')) {
    const rows = await db
      .select({ node: nodes, key: blobs.storageKey, size: blobs.size, space: spaces.name })
      .from(nodes)
      .innerJoin(spaces, eq(spaces.id, nodes.spaceId))
      .innerJoin(nodeVersions, eq(nodeVersions.id, nodes.currentVersionId))
      .innerJoin(blobs, eq(blobs.id, nodeVersions.blobId))
      .where(
        and(
          eq(nodes.orgId, orgId),
          eq(nodes.type, 'file'),
          byPeopleOrSpaces(sql`${nodes.spaceId}`, sql`${nodes.createdBy}`),
          inRange(nodes.updatedAt, s),
        ),
      )
      .orderBy(asc(nodes.updatedAt));
    let copied = 0;
    let bytes = 0;
    const listed = [];
    for (const r of rows) {
      const path = `files/${safe(r.space)}/${r.node.id.slice(0, 8)}-${safe(r.node.name)}`;
      const fits = r.size <= FILE_MAX && bytes + r.size <= FILE_BYTES_CAP;
      if (fits) {
        const chunks: Buffer[] = [];
        for await (const chunk of await storage.getStream(r.key)) chunks.push(chunk as Buffer);
        files[path] = new Uint8Array(Buffer.concat(chunks));
        bytes += r.size;
        copied++;
      }
      listed.push({
        id: r.node.id,
        name: r.node.name,
        space: r.space,
        size: r.size,
        createdBy: r.node.createdBy,
        updatedAt: r.node.updatedAt.toISOString(),
        deletedAt: r.node.deletedAt?.toISOString() ?? null,
        inArchive: fits ? path : null,
      });
    }
    files['files/index.jsonl'] = jsonl(listed);
    counts.files = rows.length;
    counts.filesCopied = copied;
  }

  if (s.include.includes('audit') && people.length) {
    const rows = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.orgId, orgId),
          inArray(auditLogs.actorId, people),
          inRange(auditLogs.at, s),
          isNotNull(auditLogs.actorId),
        ),
      )
      .orderBy(asc(auditLogs.at));
    files['audit.jsonl'] = jsonl(
      rows.map((a) => ({
        at: a.at.toISOString(),
        actorId: a.actorId,
        action: a.action,
        targetType: a.targetType,
        targetId: a.targetId,
        ip: a.ip,
        meta: a.meta,
        via: a.via,
      })),
    );
    counts.auditEntries = rows.length;
  }
  return { files, counts };
}

/** Expired archives leave the bucket and the list (called from the nightly retention job). */
export async function purgeExpiredExports(db: Db, storage: Storage | null, now = new Date()) {
  const rows = await db
    .select()
    .from(ediscoveryExports)
    .where(and(isNotNull(ediscoveryExports.expiresAt), lt(ediscoveryExports.expiresAt, now)));
  for (const r of rows) {
    if (r.storageKey && storage) await storage.delete(r.storageKey).catch(() => undefined);
    await db.delete(ediscoveryExports).where(eq(ediscoveryExports.id, r.id));
  }
  return rows.length;
}
