import { Server } from '@hocuspocus/server';
import * as Y from 'yjs';
import type { Db } from '@crewhall/db';
import type { Jobs } from '../../jobs/queue';
import type { Logger } from '../../logger';
import { parseDocumentName, verifyCollabToken, type CollabContext } from './collab';

/**
 * A Hocuspocus server for the module's documents only, used by tests and local
 * development until the wiki module's collab server (apps/backend/src/collab) is merged
 * and registers `boardsCollabDocs` itself. Same hooks that server needs: token check,
 * can()-based access (viewers connect read-only), load from and store to the tables.
 */

interface Ctx {
  userId: string;
  orgId: string;
}

export interface BoardsCollabOptions {
  db: Db;
  jobs: Jobs | null;
  secret: string;
  logger: Logger;
  port: number;
  /** onStoreDocument debounce (doc 17 §6: 2 s, at most 10 s). */
  debounce?: number;
}

export async function startBoardsCollab(opts: BoardsCollabOptions) {
  const ctx: CollabContext = { db: opts.db, jobs: opts.jobs };
  const server = new Server<Ctx>({
    port: opts.port,
    quiet: true,
    debounce: opts.debounce ?? 2000,
    maxDebounce: 10_000,
    async onAuthenticate(data) {
      const payload = verifyCollabToken(opts.secret, data.token);
      if (!payload || payload.d !== data.documentName) throw new Error('unauthorized');
      const parsed = parseDocumentName(data.documentName);
      if (!parsed) throw new Error('unknown document');
      // Rights are re-checked here, not only when the token was issued.
      const access = await parsed.type.authorize(
        ctx,
        { userId: payload.u, orgId: payload.o },
        parsed.id,
      );
      if (!access) throw new Error('forbidden');
      data.connectionConfig.readOnly = access === 'read' || payload.r;
      return { userId: payload.u, orgId: payload.o };
    },
    async onLoadDocument(data) {
      const parsed = parseDocumentName(data.documentName);
      if (!parsed) return data.document;
      const state = await parsed.type.load(ctx, parsed.id);
      if (state && state.length) Y.applyUpdate(data.document, new Uint8Array(state));
      return data.document;
    },
    async onStoreDocument(data) {
      const parsed = parseDocumentName(data.documentName);
      if (!parsed) return;
      try {
        await parsed.type.store(ctx, parsed.id, data.document, data.lastContext?.userId ?? null);
      } catch (err) {
        opts.logger.error({ err, document: data.documentName }, 'collab store failed');
        throw err;
      }
    },
  });
  await server.listen();
  opts.logger.info({ port: opts.port }, 'boards collab server listening');
  return server;
}

/** `tsx src/services/boards/dev-collab.ts`: standalone dev server (COLLAB_PORT, default 4821). */
async function main() {
  const { loadEnv } = await import('../../env');
  const { createLogger } = await import('../../logger');
  const { createDb } = await import('@crewhall/db');
  const env = loadEnv(process.env);
  const logger = createLogger(env.LOG_LEVEL, true);
  const { createBoss, pgBossJobs } = await import('../../jobs/queue');
  const { db } = createDb(env.DATABASE_URL);
  await startBoardsCollab({
    db,
    // Thumbnails are queued for the api's in-process worker (development).
    jobs: pgBossJobs(await createBoss(env.DATABASE_URL)),
    secret: env.AUTH_SECRET,
    logger,
    port: Number(process.env.COLLAB_PORT ?? 4821),
  });
}

if (process.argv[1] && /dev-collab\.(ts|js)$/.test(process.argv[1])) {
  void main();
}
