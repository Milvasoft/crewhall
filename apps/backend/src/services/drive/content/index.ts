import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { blobContents, blobs, nodes, nodeVersions, type DbOrTx } from '@crewhall/db';
import { SNIPPET_MARK_END, SNIPPET_MARK_START } from '@crewhall/shared';
import type { Jobs } from '../../../jobs/queue';
import type { Logger } from '../../../logger';
import type { Storage } from '../../../storage/s3';
import { searchQuery } from '../../wiki/search';
import {
  loadNode,
  nodeResource,
  roleForPath,
  spaceRoleOf,
  userSharePaths,
  type DriveActor,
  type NodeRow,
} from '../access';
import { can } from '@crewhall/shared';
import { CONTENT_MAX_BYTES, contentKind, extractText } from './extract';

/**
 * File content index (roadmap 10). The worker extracts text once per blob
 * (`content.extract`, after blob.process) into `blob_contents`, a Turkish + English tsvector.
 * This module is the public surface for the rest of the backend: Drive search and Ctrl K use
 * `searchContents`, the AI module (roadmap 11) uses `searchContents` and `fileText`; both
 * only ever return files the caller may see.
 */

export { CONTENT_MAX_CHARS, contentKind, extractText, type ContentKind } from './extract';

interface ContentDeps {
  db: DbOrTx;
  storage: Storage | null;
  logger: Logger;
}

/** A shorter text when Postgres refuses the vector ("string is too long for tsvector"). */
const FALLBACK_CHARS = 50_000;

async function save(
  db: DbOrTx,
  row: {
    blobId: string;
    orgId: string;
    status: 'ready' | 'skipped' | 'failed';
    kind: string | null;
    content?: string;
    truncated?: boolean;
    error?: string | null;
  },
) {
  const values = {
    blobId: row.blobId,
    orgId: row.orgId,
    status: row.status,
    kind: row.kind,
    content: row.content ?? '',
    truncated: row.truncated ?? false,
    chars: row.content?.length ?? 0,
    error: row.error ?? null,
    extractedAt: new Date(),
  };
  const { blobId: _blobId, orgId: _orgId, ...rest } = values;
  await db
    .insert(blobContents)
    .values(values)
    .onConflictDoUpdate({ target: blobContents.blobId, set: rest });
}

/**
 * content.extract: reads the blob, extracts its text and indexes it. Idempotent; quarantined,
 * encrypted (vault) and pending blobs are left alone.
 */
export async function extractBlobContent(deps: ContentDeps, blobId: string, force = false) {
  const { db, storage, logger } = deps;
  if (!storage) return;
  const [blob] = await db.select().from(blobs).where(eq(blobs.id, blobId));
  if (!blob || blob.status !== 'ready' || blob.encrypted) return;
  if (!force) {
    const [done] = await db
      .select({ status: blobContents.status })
      .from(blobContents)
      .where(eq(blobContents.blobId, blobId));
    if (done) return;
  }
  // The type often comes from the name alone (text files have no magic bytes).
  const [named] = await db
    .select({ name: nodes.name })
    .from(nodeVersions)
    .innerJoin(nodes, eq(nodes.id, nodeVersions.nodeId))
    .where(eq(nodeVersions.blobId, blobId))
    .orderBy(desc(nodeVersions.createdAt))
    .limit(1);
  const kind = contentKind(blob.mime, named?.name ?? null);
  const base = { blobId, orgId: blob.orgId };
  if (!kind || blob.size > CONTENT_MAX_BYTES) {
    await save(db, { ...base, status: 'skipped', kind });
    return;
  }
  try {
    const chunks: Buffer[] = [];
    for await (const c of (await storage.getStream(blob.storageKey)) as AsyncIterable<Buffer>) {
      chunks.push(c);
    }
    const { text, truncated } = await extractText(Buffer.concat(chunks), kind);
    try {
      await save(db, { ...base, status: 'ready', kind, content: text, truncated });
    } catch (err) {
      logger.warn({ err, blobId }, 'content index too large, keeping the start');
      await save(db, {
        ...base,
        status: 'ready',
        kind,
        content: text.slice(0, FALLBACK_CHARS),
        truncated: true,
      });
    }
  } catch (err) {
    logger.warn({ err, blobId, kind }, 'content extraction failed');
    await save(db, {
      ...base,
      status: 'failed',
      kind,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
    });
  }
}

/** Blobs looked at per content.backfill run. */
export const BACKFILL_BATCH = 200;

/**
 * content.backfill: files stored before the indexer (or whose job was lost) get queued for
 * extraction, newest first; a full batch queues the next run a minute later.
 */
export async function backfillContents(
  deps: { db: DbOrTx; storage: Storage | null; jobs: Jobs },
  batch = BACKFILL_BATCH,
) {
  if (!deps.storage) return 0;
  const rows = await deps.db
    .select({ id: blobs.id })
    .from(blobs)
    .where(
      and(
        eq(blobs.status, 'ready'),
        eq(blobs.encrypted, false),
        sql`not exists (select 1 from ${blobContents} c where c.blob_id = ${blobs.id})`,
        sql`exists (select 1 from ${nodeVersions} v join ${nodes} n on n.current_version_id = v.id
          where v.blob_id = ${blobs.id} and n.deleted_at is null)`,
      ),
    )
    .orderBy(desc(blobs.createdAt))
    .limit(batch);
  for (const r of rows) await deps.jobs.send('content.extract', { blobId: r.id });
  if (rows.length === batch) {
    await deps.jobs.send('content.backfill', {}, { startAfterSeconds: 60 });
  }
  return rows.length;
}

/* ---------------------------------- search ---------------------------------- */

const HEADLINE = `StartSel=${SNIPPET_MARK_START}, StopSel=${SNIPPET_MARK_END}, MaxWords=24, MinWords=8, MaxFragments=2, FragmentDelimiter=" … "`;

export interface ContentMatch {
  node: NodeRow;
  /** ts_rank_cd of the content against the query. */
  rank: number;
  /** Excerpt with matches between SNIPPET_MARK_START / SNIPPET_MARK_END. */
  snippet: string;
}

/**
 * Files whose current content matches `q` (Turkish and English stems, word prefixes), best
 * first, limited to `spaceIds` and to what the caller may see.
 */
export async function searchContents(
  db: DbOrTx,
  a: DriveActor,
  q: { q: string; spaceIds: string[]; limit: number; extra?: ReturnType<typeof sql> },
): Promise<ContentMatch[]> {
  const tq = searchQuery(q.q);
  if (!tq || q.spaceIds.length === 0 || q.limit <= 0) return [];
  const rows = await db
    .select({
      node: nodes,
      blobId: blobContents.blobId,
      rank: sql<number>`ts_rank_cd(${blobContents.search}, ${tq})`,
    })
    .from(nodes)
    .innerJoin(nodeVersions, eq(nodeVersions.id, nodes.currentVersionId))
    .innerJoin(blobContents, eq(blobContents.blobId, nodeVersions.blobId))
    .where(
      and(
        eq(nodes.orgId, a.org.id),
        inArray(nodes.spaceId, q.spaceIds),
        isNull(nodes.deletedAt),
        eq(nodes.type, 'file'),
        eq(blobContents.status, 'ready'),
        sql`${blobContents.search} @@ ${tq}`,
        q.extra,
      ),
    )
    .orderBy(sql`ts_rank_cd(${blobContents.search}, ${tq}) desc`, asc(nodes.id))
    .limit(q.limit * 3 + 10);

  const visible: typeof rows = [];
  const roles = new Map<string, Awaited<ReturnType<typeof spaceRoleOf>>>();
  const shares = new Map<string, Awaited<ReturnType<typeof userSharePaths>>>();
  for (const r of rows) {
    const spaceId = r.node.spaceId;
    if (!roles.has(spaceId)) {
      roles.set(spaceId, await spaceRoleOf(db, spaceId, a.userId));
      shares.set(spaceId, await userSharePaths(db, spaceId, a.userId));
    }
    const role = roleForPath(roles.get(spaceId)!, shares.get(spaceId)!, r.node.path);
    if (role && can(a.actor, 'space.view', nodeResource(a, role))) visible.push(r);
    if (visible.length >= q.limit) break;
  }
  if (!visible.length) return [];
  // Headlines only for the rows that are returned: ts_headline reads the whole text.
  const heads = await db
    .select({
      blobId: blobContents.blobId,
      snippet: sql<string>`ts_headline('turkish', ${blobContents.content}, ${tq}, ${HEADLINE})`,
    })
    .from(blobContents)
    .where(inArray(blobContents.blobId, [...new Set(visible.map((v) => v.blobId))]));
  const snippetOf = new Map(heads.map((h) => [h.blobId, h.snippet.trim()]));
  return visible.map((v) => ({
    node: v.node,
    rank: Number(v.rank),
    snippet: snippetOf.get(v.blobId) ?? '',
  }));
}

/**
 * Indexed text of a file's current version (AI context, previews); null when it has none
 * yet or its type is not indexed. Throws not_found when the caller may not see the file.
 */
export async function fileText(db: DbOrTx, a: DriveActor, nodeId: string) {
  const { node } = await loadNode(db, a, nodeId);
  if (node.type !== 'file' || !node.currentVersionId) return null;
  const [row] = await db
    .select({
      content: blobContents.content,
      truncated: blobContents.truncated,
      status: blobContents.status,
    })
    .from(nodeVersions)
    .innerJoin(blobContents, eq(blobContents.blobId, nodeVersions.blobId))
    .where(eq(nodeVersions.id, node.currentVersionId));
  if (!row || row.status !== 'ready') return null;
  return { text: row.content, truncated: row.truncated };
}
