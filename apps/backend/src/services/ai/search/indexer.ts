import { and, eq, isNull, ne, or, sql } from 'drizzle-orm';
import { aiSettings, newId, searchChunks, type DbOrTx } from '@crewhall/db';
import type { AiSearchKind } from '@crewhall/shared';
import type { Deps } from '../../../deps';
import { modelConfigOf } from '../settings';
import { chunkText } from './chunk';
import { embed, embedConfigOf, EMBED_BATCH } from './embed';

/**
 * Keeps `search_chunks` in step with the sources (yol haritası #11). The worker runs a sweep
 * every 5 minutes: each source lists what changed since it was indexed (its revision differs or
 * it has no row), the rows are rewritten, gone sources are removed, then new chunks get
 * embeddings when the org has an embedding model. Vault items are never a source.
 */

interface SourceDoc {
  kind: AiSearchKind;
  refId: string;
  orgId: string;
  nodeId: string | null;
  spaceId: string | null;
  conversationId: string | null;
  seq: number | null;
  title: string;
  body: string;
  rev: string;
  at: Date;
}

/**
 * Extra text for a Drive file beyond its extracted content (e.g. OCR later). Returns null when
 * there is nothing more.
 */
export type FileTextSource = (db: DbOrTx, nodeId: string) => Promise<string | null>;
const fileTextSources: FileTextSource[] = [];
export function registerFileTextSource(source: FileTextSource) {
  fileTextSources.push(source);
}

const BATCH = 200;

type Row = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** Mention tokens (<@uuid>, <@all>) are noise in the index. */
const stripMentions = (text: string) => text.replace(/<@[0-9a-zA-Z-]+>/g, '@');

function orgFilter(column: string, orgId: string | undefined) {
  return orgId ? sql`and ${sql.raw(column)} = ${orgId}` : sql``;
}

async function changedPages(db: DbOrTx, orgId?: string): Promise<SourceDoc[]> {
  const r = await db.execute(sql`
    select n.id, n.org_id, n.space_id, n.name, p.body_text as body, n.updated_at as at,
      p.derived_rev::text || ':' || (extract(epoch from n.updated_at) * 1000)::bigint::text as rev
    from nodes n
    join pages p on p.node_id = n.id
    join spaces s on s.id = n.space_id
    left join search_chunks c on c.kind = 'page' and c.ref_id = n.id and c.chunk = 0
    where n.type = 'page' and n.deleted_at is null and s.deleted_at is null
      ${orgFilter('n.org_id', orgId)}
      and (c.id is null or c.source_rev <> p.derived_rev::text || ':' || (extract(epoch from n.updated_at) * 1000)::bigint::text)
    limit ${BATCH}`);
  return r.rows.map((x: Row) => ({
    kind: 'page',
    refId: String(x.id),
    orgId: String(x.org_id),
    nodeId: String(x.id),
    spaceId: String(x.space_id),
    conversationId: null,
    seq: null,
    title: String(x.name),
    body: String(x.body ?? ''),
    rev: String(x.rev),
    at: new Date(String(x.at)),
  }));
}

/**
 * Drive items: name, folder path and MIME, plus the extracted text of a file's current version
 * (`blob_contents`, yol haritası #10) once it is ready. The revision includes the extraction
 * time, so a file is indexed again when its text arrives.
 */
async function changedNodes(db: DbOrTx, orgId?: string): Promise<SourceDoc[]> {
  const rev = sql.raw(
    "(extract(epoch from n.updated_at) * 1000)::bigint::text || ':' || coalesce((extract(epoch from bc.extracted_at) * 1000)::bigint::text, '')",
  );
  const r = await db.execute(sql`
    select n.id, n.org_id, n.space_id, n.type, n.name, n.mime, n.updated_at as at,
      bc.content, ${rev} as rev,
      (select string_agg(a.name, ' › ' order by nlevel(a.path))
         from nodes a where a.path @> n.path and a.id <> n.id and a.space_id = n.space_id) as parents
    from nodes n
    join spaces s on s.id = n.space_id
    left join node_versions v on v.id = n.current_version_id
    left join blob_contents bc on bc.blob_id = v.blob_id and bc.status = 'ready'
    left join search_chunks c on c.kind = n.type::text and c.ref_id = n.id and c.chunk = 0
    where n.type in ('file', 'folder', 'board', 'drawing') and n.deleted_at is null
      and s.deleted_at is null ${orgFilter('n.org_id', orgId)}
      and (c.id is null or c.source_rev <> ${rev})
    limit ${BATCH}`);
  const out: SourceDoc[] = [];
  for (const x of r.rows as Row[]) {
    const id = String(x.id);
    let body = [str(x.parents), str(x.mime)].filter(Boolean).join('\n');
    if (x.content) body += `\n\n${String(x.content)}`;
    if (x.type === 'file') {
      for (const source of fileTextSources) {
        const text = await source(db, id).catch(() => null);
        if (text) body += `\n\n${text}`;
      }
    }
    out.push({
      kind: x.type as AiSearchKind,
      refId: id,
      orgId: String(x.org_id),
      nodeId: id,
      spaceId: String(x.space_id),
      conversationId: null,
      seq: null,
      title: String(x.name),
      body,
      rev: String(x.rev),
      at: new Date(String(x.at)),
    });
  }
  return out;
}

async function changedCards(db: DbOrTx, orgId?: string): Promise<SourceDoc[]> {
  const r = await db.execute(sql`
    select k.id, k.org_id, k.board_node_id, b.space_id, k.title, k.desc_text, k.labels,
      b.name as board, k.updated_at as at,
      (extract(epoch from k.updated_at) * 1000)::bigint::text as rev
    from board_cards k
    join nodes b on b.id = k.board_node_id
    left join search_chunks c on c.kind = 'card' and c.ref_id = k.id and c.chunk = 0
    where k.deleted_at is null and k.archived_at is null and b.deleted_at is null
      ${orgFilter('k.org_id', orgId)}
      and (c.id is null or c.source_rev <> (extract(epoch from k.updated_at) * 1000)::bigint::text)
    limit ${BATCH}`);
  return r.rows.map((x: Row) => ({
    kind: 'card',
    refId: String(x.id),
    orgId: String(x.org_id),
    nodeId: String(x.board_node_id),
    spaceId: String(x.space_id),
    conversationId: null,
    seq: null,
    title: String(x.title),
    body: [
      String(x.desc_text ?? ''),
      Array.isArray(x.labels) ? (x.labels as string[]).join(', ') : '',
      `${String(x.board)}`,
    ]
      .filter(Boolean)
      .join('\n'),
    rev: String(x.rev),
    at: new Date(String(x.at)),
  }));
}

async function changedMessages(db: DbOrTx, orgId?: string): Promise<SourceDoc[]> {
  const r = await db.execute(sql`
    select m.id, m.org_id, m.conversation_id, m.seq, m.text, cv.name as conversation,
      cv.space_id, m.created_at as at,
      (extract(epoch from m.updated_at) * 1000)::bigint::text as rev
    from messages m
    join conversations cv on cv.id = m.conversation_id
    left join search_chunks c on c.kind = 'message' and c.ref_id = m.id and c.chunk = 0
    where m.kind in ('user', 'webhook') and m.deleted_at is null and m.text <> ''
      ${orgFilter('m.org_id', orgId)}
      and (c.id is null or c.source_rev <> (extract(epoch from m.updated_at) * 1000)::bigint::text)
    limit ${BATCH}`);
  return r.rows.map((x: Row) => ({
    kind: 'message',
    refId: String(x.id),
    orgId: String(x.org_id),
    nodeId: null,
    spaceId: str(x.space_id),
    conversationId: String(x.conversation_id),
    seq: num(x.seq),
    title: String(x.conversation ?? ''),
    body: stripMentions(String(x.text)),
    rev: String(x.rev),
    at: new Date(String(x.at)),
  }));
}

/** Chunks whose source was deleted, trashed or edited away. */
async function removeGone(db: DbOrTx, orgId?: string) {
  const org = orgFilter('c.org_id', orgId);
  await db.execute(sql`
    delete from search_chunks c where c.kind in ('page', 'file', 'folder', 'board', 'drawing') ${org}
      and not exists (select 1 from nodes n join spaces s on s.id = n.space_id
        where n.id = c.ref_id and n.deleted_at is null and s.deleted_at is null)`);
  await db.execute(sql`
    delete from search_chunks c where c.kind = 'card' ${org}
      and not exists (select 1 from board_cards k join nodes b on b.id = k.board_node_id
        where k.id = c.ref_id and k.deleted_at is null and k.archived_at is null
          and b.deleted_at is null)`);
  await db.execute(sql`
    delete from search_chunks c where c.kind = 'message' ${org}
      and not exists (select 1 from messages m where m.id = c.ref_id and m.deleted_at is null
        and m.text <> '')`);
}

async function write(db: DbOrTx, docs: SourceDoc[]) {
  if (!docs.length) return;
  await db.transaction(async (tx) => {
    for (const d of docs) {
      await tx
        .delete(searchChunks)
        .where(and(eq(searchChunks.kind, d.kind), eq(searchChunks.refId, d.refId)));
      const pieces = chunkText(d.body);
      const bodies = pieces.length ? pieces : [''];
      await tx.insert(searchChunks).values(
        bodies.map((body, chunk) => ({
          id: newId(),
          orgId: d.orgId,
          kind: d.kind,
          refId: d.refId,
          chunk,
          nodeId: d.nodeId,
          spaceId: d.spaceId,
          conversationId: d.conversationId,
          seq: d.seq,
          title: d.title,
          body,
          sourceRev: d.rev,
          sourceAt: d.at,
        })),
      );
    }
  });
}

/** Embeddings for chunks that have none (or one from another model), per org. */
async function embedPending(deps: Pick<Deps, 'db' | 'env' | 'logger'>, orgId?: string) {
  const orgs = await deps.db
    .select()
    .from(aiSettings)
    .where(orgId ? eq(aiSettings.orgId, orgId) : sql`true`);
  let done = 0;
  for (const settings of orgs) {
    if (!settings.embeddingModel) continue;
    let cfg;
    try {
      cfg = embedConfigOf(modelConfigOf(deps, settings), settings.embeddingModel);
    } catch {
      continue;
    }
    if (!cfg) continue;
    for (let round = 0; round < 20; round++) {
      const pending = await deps.db
        .select({ id: searchChunks.id, title: searchChunks.title, body: searchChunks.body })
        .from(searchChunks)
        .where(
          and(
            eq(searchChunks.orgId, settings.orgId),
            or(
              isNull(searchChunks.embedding),
              isNull(searchChunks.embeddingModel),
              ne(searchChunks.embeddingModel, cfg.model),
            ),
          ),
        )
        .limit(EMBED_BATCH);
      if (!pending.length) break;
      let vectors: number[][];
      try {
        vectors = await embed(
          cfg,
          pending.map((p) => `${p.title}\n${p.body}`.slice(0, 4_000)),
        );
      } catch (err) {
        deps.logger.warn({ err, orgId: settings.orgId }, 'search embeddings failed');
        break;
      }
      for (const [i, p] of pending.entries()) {
        await deps.db
          .update(searchChunks)
          .set({ embedding: vectors[i]!, embeddingModel: cfg.model })
          .where(eq(searchChunks.id, p.id));
      }
      done += pending.length;
    }
  }
  return done;
}

/**
 * One sweep: every changed source (in batches until nothing is left or `maxRounds` is hit),
 * removals, then embeddings. `orgId` limits it to one org (admin "rebuild").
 */
export async function sweepSearch(
  deps: Pick<Deps, 'db' | 'env' | 'logger'>,
  opts: { orgId?: string; maxRounds?: number } = {},
) {
  const sources = [changedPages, changedNodes, changedCards, changedMessages];
  let indexed = 0;
  for (const source of sources) {
    for (let round = 0; round < (opts.maxRounds ?? 25); round++) {
      const docs = await source(deps.db, opts.orgId);
      if (!docs.length) break;
      await write(deps.db, docs);
      indexed += docs.length;
      if (docs.length < BATCH) break;
    }
  }
  await removeGone(deps.db, opts.orgId);
  const embedded = await embedPending(deps, opts.orgId);
  return { indexed, embedded };
}

/** Drops the embeddings of an org (embedding model changed or removed). */
export async function clearEmbeddings(db: DbOrTx, orgId: string) {
  await db
    .update(searchChunks)
    .set({ embedding: null, embeddingModel: null })
    .where(eq(searchChunks.orgId, orgId));
}

export async function indexCounts(db: DbOrTx, orgId: string) {
  const r = await db.execute(sql`
    select count(*)::int as chunks,
      count(distinct (kind, ref_id))::int as documents,
      count(embedding)::int as embedded,
      max(indexed_at) as last
    from search_chunks where org_id = ${orgId}`);
  const row = (r.rows[0] ?? {}) as Row;
  return {
    chunks: Number(row.chunks ?? 0),
    documents: Number(row.documents ?? 0),
    embedded: Number(row.embedded ?? 0),
    lastIndexedAt: row.last ? new Date(String(row.last)).toISOString() : null,
  };
}
