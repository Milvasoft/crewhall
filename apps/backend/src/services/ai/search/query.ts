import { and, eq, inArray, sql } from 'drizzle-orm';
import { boardCards, searchChunks, type DbOrTx } from '@crewhall/db';
import type { Actor, AiSearchHit, AiSearchKind, ModuleKey } from '@crewhall/shared';
import type { Deps } from '../../../deps';
import type { OrgRow } from '../../../http/types';
import { historyFrom, requireMember } from '../../chat/access';
import { loadNode } from '../../drive/access';
import { isModuleEnabled } from '../../identity/modules';
import { requireNodeModule } from '../../identity/node-types';
import { snippetOf, tsQueryOf } from './chunk';
import { embed, vectorModeOf, type EmbedConfig } from './embed';

/**
 * Search over `search_chunks` for one person (yol haritası #11). Candidates come from the
 * full-text index and, with an embedding model, from vector similarity; they are merged by
 * reciprocal rank and then checked one by one with the module's own rules — `loadNode`
 * (`can(…, 'space.view', …)`, shares, trash) for Drive, pages and boards, chat membership and
 * visible history for messages — so nothing the person cannot open is returned.
 */

export interface SearchCaller {
  org: OrgRow;
  actor: Actor;
  userId: string;
}

export interface Candidate {
  id: string;
  kind: AiSearchKind;
  refId: string;
  chunk: number;
  nodeId: string | null;
  spaceId: string | null;
  conversationId: string | null;
  seq: number | null;
  title: string;
  body: string;
  sourceAt: Date;
}

export interface FoundChunk extends Candidate {
  hit: AiSearchHit;
}

const CANDIDATES = 150;
const RRF_K = 60;

const MODULE_OF_KIND: Record<AiSearchKind, ModuleKey | null> = {
  page: 'wiki',
  file: null,
  folder: null,
  board: 'boards',
  drawing: 'drawings',
  card: 'boards',
  message: 'chat',
  // Live kinds come from the Ask tools, never from the index.
  event: 'calendar',
  meeting: 'meet',
  todo: null,
  person: 'contacts',
  contact: 'contacts',
  mail: 'mail',
  row: 'tables',
};

const columns = {
  id: searchChunks.id,
  kind: searchChunks.kind,
  refId: searchChunks.refId,
  chunk: searchChunks.chunk,
  nodeId: searchChunks.nodeId,
  spaceId: searchChunks.spaceId,
  conversationId: searchChunks.conversationId,
  seq: searchChunks.seq,
  title: searchChunks.title,
  body: searchChunks.body,
  sourceAt: searchChunks.sourceAt,
};

async function textCandidates(db: DbOrTx, orgId: string, q: string, kinds: AiSearchKind[]) {
  const tsq = tsQueryOf(q);
  if (!tsq) return [];
  const query = sql`to_tsquery('simple', ${tsq})`;
  const rows = await db
    .select(columns)
    .from(searchChunks)
    .where(
      and(
        eq(searchChunks.orgId, orgId),
        inArray(searchChunks.kind, kinds),
        sql`${searchChunks.search} @@ ${query}`,
      ),
    )
    .orderBy(
      sql`ts_rank_cd(${searchChunks.search}, ${query}) desc`,
      sql`${searchChunks.sourceAt} desc`,
    )
    .limit(CANDIDATES);
  return rows as Candidate[];
}

async function vectorCandidates(
  db: DbOrTx,
  orgId: string,
  q: string,
  kinds: AiSearchKind[],
  cfg: EmbedConfig,
) {
  const [vector] = await embed(cfg, [q]);
  if (!vector?.length) return [];
  const mode = await vectorModeOf(db);
  const literal = `{${vector.map((v) => (Number.isFinite(v) ? v : 0)).join(',')}}`;
  const distance =
    mode === 'pgvector'
      ? sql`(${searchChunks.embedding}::vector <=> ${literal}::real[]::vector)`
      : sql`(1 - (select sum(a * b) from unnest(${searchChunks.embedding}, ${literal}::real[]) as t(a, b))
          / nullif(sqrt((select sum(a * a) from unnest(${searchChunks.embedding}) as t(a)))
            * sqrt((select sum(b * b) from unnest(${literal}::real[]) as t(b))), 0))`;
  const rows = await db
    .select(columns)
    .from(searchChunks)
    .where(
      and(
        eq(searchChunks.orgId, orgId),
        inArray(searchChunks.kind, kinds),
        eq(searchChunks.embeddingModel, cfg.model),
        sql`array_length(${searchChunks.embedding}, 1) = ${vector.length}`,
      ),
    )
    .orderBy(sql`${distance} asc nulls last`)
    .limit(CANDIDATES);
  return rows as Candidate[];
}

/** Reciprocal rank fusion of the candidate lists; one entry per source (its best chunk). */
function merge(lists: Candidate[][]): Candidate[] {
  const score = new Map<string, { c: Candidate; s: number }>();
  for (const list of lists) {
    list.forEach((c, rank) => {
      const key = `${c.kind}:${c.refId}`;
      const prev = score.get(key);
      const s = 1 / (RRF_K + rank + 1);
      if (!prev) score.set(key, { c, s });
      else prev.s += s;
    });
  }
  return [...score.values()].sort((a, b) => b.s - a.s).map((x) => x.c);
}

/** Per-request memo of the permission checks. */
function accessChecker(deps: Pick<Deps, 'db'>, caller: SearchCaller) {
  const a = { org: caller.org, actor: caller.actor, userId: caller.userId };
  const nodes = new Map<string, Promise<boolean>>();
  const conversations = new Map<string, Promise<number | null>>();
  const modules = new Map<ModuleKey, Promise<boolean>>();
  const moduleOn = (key: ModuleKey) => {
    let p = modules.get(key);
    if (!p) {
      p = isModuleEnabled(deps.db, caller.org.id, key);
      modules.set(key, p);
    }
    return p;
  };
  return {
    moduleOn,
    async allowed(c: Candidate): Promise<boolean> {
      const mod = MODULE_OF_KIND[c.kind];
      if (mod && !(await moduleOn(mod))) return false;
      if (c.kind === 'message') {
        if (!c.conversationId || c.seq === null) return false;
        let from = conversations.get(c.conversationId);
        if (!from) {
          from = requireMember(deps.db, a, c.conversationId).then(
            (m) => historyFrom(m),
            () => null,
          );
          conversations.set(c.conversationId, from);
        }
        const first = await from;
        return first !== null && c.seq >= first;
      }
      if (!c.nodeId) return false;
      let ok = nodes.get(c.nodeId);
      if (!ok) {
        ok = loadNode(deps.db, a, c.nodeId).then(
          async (access) => {
            await requireNodeModule(deps.db, caller.org.id, access.node.type);
            return true;
          },
          () => false,
        );
        nodes.set(c.nodeId, ok);
      }
      return ok;
    },
  };
}

/**
 * The best chunks the caller may open, as hits with the matched text. `embedCfg` adds semantic
 * candidates; when the embedding call fails the text results still come back.
 */
export async function searchChunksFor(
  deps: Pick<Deps, 'db' | 'logger'>,
  caller: SearchCaller,
  input: { q: string; kinds: AiSearchKind[]; limit: number; embedCfg: EmbedConfig | null },
): Promise<FoundChunk[]> {
  const check = accessChecker(deps, caller);
  const kinds = input.kinds.length
    ? input.kinds
    : (['page', 'file', 'folder', 'board', 'drawing', 'card', 'message'] as AiSearchKind[]);
  const lists = [await textCandidates(deps.db, caller.org.id, input.q, kinds)];
  if (input.embedCfg) {
    try {
      lists.push(await vectorCandidates(deps.db, caller.org.id, input.q, kinds, input.embedCfg));
    } catch (err) {
      deps.logger.warn({ err }, 'semantic search failed; text results only');
    }
  }
  const out: FoundChunk[] = [];
  for (const c of merge(lists)) {
    if (out.length >= input.limit) break;
    if (!(await check.allowed(c))) continue;
    out.push({ ...c, hit: await toHit(deps.db, c, input.q) });
  }
  return out;
}

async function toHit(db: DbOrTx, c: Candidate, q: string): Promise<AiSearchHit> {
  let cardNumber: number | null = null;
  if (c.kind === 'card') {
    const [card] = await db
      .select({ number: boardCards.number })
      .from(boardCards)
      .where(eq(boardCards.id, c.refId));
    cardNumber = card?.number ?? null;
  }
  return {
    kind: c.kind,
    refId: c.refId,
    title: c.title,
    snippet: snippetOf(c.body || c.title, q),
    nodeId: c.kind === 'message' || c.kind === 'card' ? null : c.nodeId,
    spaceId: c.spaceId,
    conversationId: c.conversationId,
    seq: c.seq,
    boardId: c.kind === 'card' ? c.nodeId : null,
    cardNumber,
    updatedAt: c.sourceAt.toISOString(),
  };
}
