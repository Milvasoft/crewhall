import type { IncomingMessage, ServerResponse } from 'node:http';
import { Database } from '@hocuspocus/extension-database';
import { Server, type Connection, type Document, type Hocuspocus } from '@hocuspocus/server';
import { z } from 'zod';
import type { Db } from '@crewhall/db';
import { parsePageDocumentName } from '@crewhall/shared';
import type { Env } from '../env';
import type { Jobs } from '../jobs/queue';
import type { Logger } from '../logger';
import { AppError } from '../http/errors';
import {
  parseDocumentName as parseBoardsDocumentName,
  verifyCollabToken as verifyBoardsToken,
  type CollabContext as BoardsCollabContext,
} from '../services/boards/collab';
import { actorFor, canDo, canEditBody, loadPage } from '../services/wiki/access';
import { setTaskChecked } from '../services/wiki/doc';
import { applyEdit, loadPageState, storePageState, type EditSource } from '../services/wiki/live';
import { verifyCollabToken, verifyInternal } from '../services/wiki/token';

/**
 * Collab server (doc 17 §3 apps/collab, §6 "Ortak düzenleme"): Hocuspocus on its own port
 * and process, one server for every module's documents: `page:<nodeId>` (wiki) and the
 * boards module's `card:<cardId>` / `drawing:<nodeId>` (`boardsCollabDocs`: their own token,
 * rights, load and store). Clients authenticate with the api-signed document token; rights come from
 * the same `can()` as the api (viewers and locked pages are read-only). The Database
 * extension persists `encodeStateAsUpdate` to pages.ydoc 2 s after the last change (10 s at
 * most) and queues `page.snapshot`. Rights are re-checked every 30 s: a connection that lost
 * edit rights turns read-only, one that lost view rights is closed.
 *
 * Internal endpoints for the api (HMAC-signed with AUTH_SECRET):
 *   POST /internal/docs/:name/edit    replace / append content through a direct connection
 *   POST /internal/docs/:name/task    ticks one to-do, stored before it answers
 *   POST /internal/docs/:name/notify  { event: meta | recheck | flush }
 */

export interface CollabContext {
  userId: string;
  orgId: string;
  /** The page of a `page:` document; '' for other modules' documents. */
  nodeId: string;
  source: EditSource;
}

type Rights = 'edit' | 'read' | null;

export interface CollabDeps {
  db: Db;
  env: Env;
  logger: Logger;
  jobs: Jobs;
}

export interface CollabServerOptions {
  port: number;
  /** Seconds between rights re-checks of open connections. */
  recheckSeconds?: number;
  debounce?: number;
  maxDebounce?: number;
}

const EditBody = z.object({
  op: z.enum(['replace', 'append']),
  doc: z.object({ type: z.literal('doc'), content: z.array(z.any()) }),
  userId: z.uuid(),
  source: z.enum(['web', 'mobile', 'mcp', 'api']),
  notice: z.string().max(40).optional(),
});
const TaskBody = z.object({
  task: z.object({ index: z.number().int().min(0), text: z.string(), checked: z.boolean() }),
  userId: z.uuid(),
  source: z.enum(['web', 'mobile', 'mcp', 'api']),
});
const NotifyBody = z.object({ event: z.enum(['meta', 'recheck', 'flush']) });

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** What a person may do on a page right now: 'edit', 'read' or null (no access). */
export async function pageRights(db: Db, ctx: Pick<CollabContext, 'orgId' | 'userId' | 'nodeId'>) {
  const actor = await actorFor(db, ctx.orgId, ctx.userId);
  if (!actor) return null;
  try {
    const access = await loadPage(db, actor, ctx.nodeId);
    if (!canDo(actor, access.role, 'space.view')) return null;
    return canEditBody(actor, access) ? 'edit' : 'read';
  } catch (err) {
    if (err instanceof AppError) return null;
    throw err;
  }
}

export function createCollabServer(deps: CollabDeps, options: CollabServerOptions) {
  const { db, env, logger } = deps;
  const boardsCtx: BoardsCollabContext = { db, jobs: deps.jobs };

  /** Current rights on a document; undefined when no module owns the name. */
  async function rightsFor(
    name: string,
    user: { userId: string; orgId: string },
  ): Promise<Rights | undefined> {
    const nodeId = parsePageDocumentName(name);
    if (nodeId) return pageRights(db, { ...user, nodeId });
    const boards = parseBoardsDocumentName(name);
    if (!boards) return undefined;
    const access = await boards.type.authorize(boardsCtx, user, boards.id);
    return access === 'write' ? 'edit' : access === 'read' ? 'read' : null;
  }

  const server = new Server<CollabContext>({
    port: options.port,
    quiet: true,
    stopOnSignals: false,
    name: 'crewhall-collab',
    debounce: options.debounce ?? 2000,
    maxDebounce: options.maxDebounce ?? 10_000,
    timeout: 30_000,

    async onAuthenticate({ token, documentName, connectionConfig }) {
      if (parseBoardsDocumentName(documentName)) {
        const payload = verifyBoardsToken(env.AUTH_SECRET, token);
        if (!payload || payload.d !== documentName) throw new Error('unauthorized');
        const user = { userId: payload.u, orgId: payload.o };
        // Rights are re-checked here, not only when the token was issued.
        const rights = await rightsFor(documentName, user);
        if (!rights) throw new Error('forbidden');
        connectionConfig.readOnly = rights !== 'edit' || payload.r;
        return { ...user, nodeId: '', source: 'web' } satisfies CollabContext;
      }
      const nodeId = parsePageDocumentName(documentName);
      const payload = verifyCollabToken(env.AUTH_SECRET, token);
      if (!nodeId || !payload || payload.d !== documentName) {
        throw new Error('unauthorized');
      }
      const ctx: CollabContext = {
        userId: payload.u,
        orgId: payload.o,
        nodeId,
        source: payload.src,
      };
      const rights = await pageRights(db, ctx);
      if (!rights) throw new Error('forbidden');
      connectionConfig.readOnly = rights !== 'edit';
      return ctx;
    },

    async onRequest({ request, response }) {
      const url = new URL(request.url ?? '/', 'http://collab');
      if (url.pathname === '/healthz') {
        send(response, 200, { status: 'ok' });
        return Promise.reject(null);
      }
      const m = /^\/internal\/docs\/([^/]+)\/(edit|task|notify)$/.exec(url.pathname);
      if (!m || request.method !== 'POST') return;
      try {
        const body = await readBody(request);
        if (
          !verifyInternal(env.AUTH_SECRET, body, request.headers['x-crewhall-signature'] as string)
        ) {
          send(response, 401, { code: 'unauthenticated' });
        } else {
          const name = decodeURIComponent(m[1]!);
          const status = await internal(
            server.hocuspocus,
            name,
            m[2] as 'edit' | 'task' | 'notify',
            body,
          );
          send(response, status, {});
        }
      } catch (err) {
        logger.error({ err }, 'collab internal request failed');
        send(response, 500, { code: 'internal' });
      }
      return Promise.reject(null);
    },

    extensions: [
      new Database({
        fetch: async ({ documentName }) => {
          const boards = parseBoardsDocumentName(documentName);
          if (boards) {
            const state = await boards.type.load(boardsCtx, boards.id);
            return state && state.length ? new Uint8Array(state) : null;
          }
          const nodeId = parsePageDocumentName(documentName);
          if (!nodeId) return null;
          const state = await loadPageState(db, nodeId);
          return state && state.length ? new Uint8Array(state) : null;
        },
        store: async ({ documentName, document, state, lastContext }) => {
          const ctx = (lastContext ?? {}) as Partial<CollabContext>;
          const boards = parseBoardsDocumentName(documentName);
          if (boards) {
            await boards.type.store(boardsCtx, boards.id, document, ctx.userId ?? null);
            return;
          }
          const nodeId = parsePageDocumentName(documentName);
          if (!nodeId) return;
          await storePageState(deps, nodeId, state, {
            userId: ctx.userId ?? null,
            source: ctx.source ?? null,
          });
        },
      }),
    ],
  });

  async function internal(
    hp: Hocuspocus<CollabContext>,
    name: string,
    kind: 'edit' | 'task' | 'notify',
    raw: string,
  ) {
    const nodeId = parsePageDocumentName(name);
    if (!nodeId) return 404;
    if (kind === 'edit') {
      const parsed = EditBody.safeParse(JSON.parse(raw));
      if (!parsed.success) return 400;
      if ((await loadPageState(db, nodeId)) === null) return 404;
      const edit = parsed.data;
      const conn = await hp.openDirectConnection(name, {
        userId: edit.userId,
        orgId: '',
        nodeId,
        source: edit.source,
      });
      await conn.transact((doc) => applyEdit(doc, { op: edit.op, doc: edit.doc }));
      if (edit.notice) {
        conn.document?.broadcastStateless(JSON.stringify({ type: edit.notice, by: edit.userId }));
      }
      await conn.disconnect();
      return 200;
    }
    if (kind === 'task') {
      const parsed = TaskBody.safeParse(JSON.parse(raw));
      if (!parsed.success) return 400;
      if ((await loadPageState(db, nodeId)) === null) return 404;
      const { task, userId, source } = parsed.data;
      const conn = await hp.openDirectConnection(name, { userId, orgId: '', nodeId, source });
      let applied = false;
      await conn.transact((doc) => {
        applied = setTaskChecked(doc, task);
      });
      await conn.disconnect();
      if (!applied) return 409;
      // Stored before answering: the card that ticked it reads the page right after.
      const id = `onStoreDocument-${name}`;
      if (hp.debouncer.isDebounced(id)) await hp.debouncer.executeNow(id);
      return 200;
    }
    const parsed = NotifyBody.safeParse(JSON.parse(raw));
    if (!parsed.success) return 400;
    const doc = hp.documents.get(name);
    if (!doc) return 200;
    if (parsed.data.event === 'flush') {
      const id = `onStoreDocument-${name}`;
      if (hp.debouncer.isDebounced(id)) await hp.debouncer.executeNow(id);
      return 200;
    }
    if (parsed.data.event === 'recheck') await recheckDocument(doc);
    doc.broadcastStateless(JSON.stringify({ type: 'meta' }));
    return 200;
  }

  async function recheckDocument(doc: Document) {
    const cache = new Map<string, Rights | undefined>();
    for (const conn of doc.getConnections() as Connection<CollabContext>[]) {
      const ctx = conn.context;
      if (!ctx?.userId) continue;
      if (!cache.has(ctx.userId)) cache.set(ctx.userId, await rightsFor(doc.name, ctx));
      const rights = cache.get(ctx.userId);
      if (rights === undefined) return;
      if (rights === null) {
        logger.info({ document: doc.name, userId: ctx.userId }, 'collab access lost; closing');
        conn.close({ code: 4403, reason: 'forbidden' });
      } else {
        const readOnly = rights !== 'edit';
        if (conn.readOnly !== readOnly) {
          conn.readOnly = readOnly;
          conn.sendStateless(JSON.stringify({ type: 'rights', readOnly }));
        }
      }
    }
  }

  let timer: NodeJS.Timeout | null = null;
  const recheckAll = async () => {
    for (const doc of server.hocuspocus.documents.values()) {
      await recheckDocument(doc).catch((err) => logger.warn({ err }, 'collab recheck failed'));
    }
  };

  return {
    server,
    get hocuspocus() {
      return server.hocuspocus;
    },
    async listen() {
      await server.listen();
      const every = (options.recheckSeconds ?? 30) * 1000;
      const loop = () => {
        timer = setTimeout(() => {
          void recheckAll().finally(() => {
            if (timer) loop();
          });
        }, every);
      };
      loop();
      logger.info({ port: server.address.port }, 'crewhall collab listening');
      return server.address.port;
    },
    recheckAll,
    async close() {
      if (timer) clearTimeout(timer);
      timer = null;
      server.hocuspocus.flushPendingStores();
      await server.destroy();
    },
  };
}

export type CollabServer = ReturnType<typeof createCollabServer>;
