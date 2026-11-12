import { eq, sql } from 'drizzle-orm';
import * as Y from 'yjs';
import { pages, type DbOrTx } from '@crewhall/db';
import { pageDocumentName } from '@crewhall/shared';
import type { Env } from '../../env';
import { AppError } from '../../http/errors';
import type { Jobs } from '../../jobs/queue';
import type { Logger } from '../../logger';
import { collabConfig } from './config';
import {
  appendContent,
  docFromState,
  encodeState,
  replaceContent,
  setTaskChecked,
  type PMDoc,
} from './doc';
import { signInternal } from './token';

export type EditSource = 'web' | 'mobile' | 'mcp' | 'api';

export interface LiveDeps {
  db: DbOrTx;
  env: Env;
  logger: Logger;
  jobs: Jobs;
}

/**
 * Persists a page's Yjs state (collab's Database extension and the api fallback). The new
 * state is merged with the stored one, so nothing written elsewhere in between is lost;
 * then the derive job is queued (doc 17 §6 steps 4-5).
 */
export async function storePageState(
  deps: Pick<LiveDeps, 'db' | 'jobs'>,
  nodeId: string,
  state: Uint8Array,
  by: { userId: string | null; source: EditSource | null },
) {
  const stored = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select({ ydoc: pages.ydoc })
      .from(pages)
      .where(eq(pages.nodeId, nodeId))
      .for('update');
    if (!row) return false;
    const merged = row.ydoc?.length ? Y.mergeUpdates([row.ydoc, state]) : state;
    await tx
      .update(pages)
      .set({
        ydoc: Buffer.from(merged),
        snapshotRev: sql`${pages.snapshotRev} + 1`,
        editedAt: new Date(),
        ...(by.userId ? { editedBy: by.userId } : {}),
        ...(by.source ? { lastSource: by.source } : {}),
        pendingEditors: by.userId
          ? sql`array(select distinct unnest(${pages.pendingEditors} || ${by.userId}::uuid))`
          : pages.pendingEditors,
      })
      .where(eq(pages.nodeId, nodeId));
    return true;
  });
  if (stored) await deps.jobs.send('page.snapshot', { nodeId });
  return stored;
}

export async function loadPageState(db: DbOrTx, nodeId: string): Promise<Buffer | null> {
  const [row] = await db.select({ ydoc: pages.ydoc }).from(pages).where(eq(pages.nodeId, nodeId));
  return row?.ydoc ?? null;
}

export interface LiveEdit {
  op: 'replace' | 'append';
  doc: PMDoc;
  userId: string;
  source: EditSource;
  /** Stateless message for open editors, e.g. 'restored' (design 5.10). */
  notice?: 'restored';
}

/** Applies an edit to the in-memory doc (collab) or a doc loaded from the database. */
export function applyEdit(doc: Y.Doc, edit: Pick<LiveEdit, 'op' | 'doc'>, origin?: unknown) {
  if (edit.op === 'replace') replaceContent(doc, edit.doc, origin);
  else appendContent(doc, edit.doc, origin);
}

/**
 * Changes a page body so open editors see it live: through the collab server's internal
 * endpoint (Hocuspocus direct connection). When collab cannot be reached the edit is
 * applied to the stored state instead; editors that reconnect merge it.
 */
export async function editPage(
  deps: LiveDeps,
  nodeId: string,
  edit: LiveEdit,
): Promise<'live' | 'stored'> {
  const { internalUrl } = collabConfig(deps.env);
  const body = JSON.stringify(edit);
  try {
    const res = await fetch(
      `${internalUrl}/internal/docs/${encodeURIComponent(pageDocumentName(nodeId))}/edit`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-crewhall-signature': signInternal(deps.env.AUTH_SECRET, body),
        },
        body,
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (res.ok) return 'live';
    deps.logger.warn({ status: res.status, nodeId }, 'collab edit refused; storing directly');
  } catch (err) {
    deps.logger.debug({ err, nodeId }, 'collab unreachable; storing directly');
  }
  const doc = docFromState(await loadPageState(deps.db, nodeId));
  const before = Y.encodeStateVector(doc);
  applyEdit(doc, edit);
  const ok = await storePageState(deps, nodeId, Y.encodeStateAsUpdate(doc, before), {
    userId: edit.userId,
    source: edit.source,
  });
  if (!ok) throw new AppError('not_found');
  return 'stored';
}

/**
 * Ticks a to-do so open editors see it. Stored by the time this returns, so a read right after
 * shows it. `page_task_changed` when the page no longer has that to-do.
 */
export async function setPageTask(
  deps: LiveDeps,
  nodeId: string,
  task: { index: number; text: string; checked: boolean },
  who: { userId: string; source: EditSource },
): Promise<void> {
  const { internalUrl } = collabConfig(deps.env);
  const body = JSON.stringify({ task, ...who });
  try {
    const res = await fetch(
      `${internalUrl}/internal/docs/${encodeURIComponent(pageDocumentName(nodeId))}/task`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-crewhall-signature': signInternal(deps.env.AUTH_SECRET, body),
        },
        body,
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (res.status === 409) throw new AppError('page_task_changed');
    if (res.ok) return;
    deps.logger.warn({ status: res.status, nodeId }, 'collab task refused; storing directly');
  } catch (err) {
    if (err instanceof AppError) throw err;
    deps.logger.debug({ err, nodeId }, 'collab unreachable; storing directly');
  }
  const doc = docFromState(await loadPageState(deps.db, nodeId));
  const before = Y.encodeStateVector(doc);
  if (!setTaskChecked(doc, task)) throw new AppError('page_task_changed');
  const ok = await storePageState(deps, nodeId, Y.encodeStateAsUpdate(doc, before), who);
  if (!ok) throw new AppError('not_found');
}

/** Best-effort signal to the collab server (meta change, rights recheck); never throws. */
export async function notifyCollab(
  deps: Pick<LiveDeps, 'env' | 'logger'>,
  nodeId: string,
  event: 'meta' | 'recheck' | 'flush',
) {
  const { internalUrl } = collabConfig(deps.env);
  const body = JSON.stringify({ event });
  try {
    await fetch(
      `${internalUrl}/internal/docs/${encodeURIComponent(pageDocumentName(nodeId))}/notify`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-crewhall-signature': signInternal(deps.env.AUTH_SECRET, body),
        },
        body,
        signal: AbortSignal.timeout(3_000),
      },
    );
  } catch {
    // Collab not running: nothing is open there.
  }
}

/** Current stored state as a Y.Doc (read paths: content, export, versions). */
export async function storedDoc(db: DbOrTx, nodeId: string) {
  return docFromState(await loadPageState(db, nodeId));
}

export { encodeState };
