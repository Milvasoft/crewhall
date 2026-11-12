import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  boardCards,
  drawings,
  nodes,
  orgMembers,
  organizations,
  type Db,
  type DbOrTx,
} from '@crewhall/db';
import { liveMember } from '../guests';
import { BoardsCollabDocument } from '@crewhall/shared';
import * as Y from 'yjs';
import { z } from 'zod';
import type { Env } from '../../env';
import { AppError } from '../../http/errors';
import type { Jobs } from '../../jobs/queue';
import { toActor } from '../membership';
import type { DriveActor } from '../drive/access';
import { atLeast, loadCard, loadDrawing, touchBoard } from './access';
import { announce } from './boards';
import { storeScene } from './drawings';
import { descriptionText } from './ydoc';
import { clientCollabUrl, collabConfig } from '../wiki/config';
import { isModuleEnabled } from '../identity/modules';
import { boardsEnabled, drawingsEnabled } from './module';
import type { Bus } from '../../realtime/bus';
import { withBoardEvents } from './integrations';

/**
 * Collaborative documents of this module on the collab server (doc 17 §3, §6):
 * `card:<cardId>` (description) and `drawing:<nodeId>` (scene). The collab server itself
 * belongs to the wiki module (apps/backend/src/collab); it registers `boardsCollabDocs`
 * next to its own `page:` type. services/boards/dev-collab.ts is a standalone server for
 * these documents only (module tests).
 */

export type CollabAccess = 'read' | 'write';

export interface CollabContext {
  db: Db;
  jobs: Jobs | null;
  /** Board events to WebSocket clients (NOTIFY bus in the collab process); optional. */
  bus?: Bus | null;
}

export interface CollabDocType {
  prefix: string;
  authorize(
    ctx: CollabContext,
    user: { userId: string; orgId: string },
    id: string,
  ): Promise<CollabAccess | null>;
  load(ctx: CollabContext, id: string): Promise<Uint8Array | null>;
  store(ctx: CollabContext, id: string, doc: Y.Doc, userId: string | null): Promise<void>;
}

/** Org actor for a token's user, as the api builds it per request. */
export async function actorFor(
  db: DbOrTx,
  userId: string,
  orgId: string,
): Promise<DriveActor | null> {
  const [row] = await db
    .select({ member: orgMembers, org: organizations })
    .from(orgMembers)
    .innerJoin(organizations, eq(organizations.id, orgMembers.organizationId))
    .where(and(eq(orgMembers.userId, userId), eq(orgMembers.organizationId, orgId), liveMember()));
  if (!row) return null;
  return { org: row.org, actor: toActor(row.member), userId };
}

/** Merges the stored state with the live one: HTTP writes made meanwhile are kept. */
function merged(stored: Buffer | null, doc: Y.Doc) {
  const live = Y.encodeStateAsUpdate(doc);
  if (!stored || stored.length === 0) return { doc, state: Buffer.from(live) };
  const state = Y.mergeUpdates([new Uint8Array(stored), live]);
  const out = new Y.Doc();
  Y.applyUpdate(out, state);
  return { doc: out, state: Buffer.from(state) };
}

const cardDoc: CollabDocType = {
  prefix: 'card',
  async authorize(ctx, user, id) {
    // The org turned boards off: no card document opens.
    if (!(await boardsEnabled(ctx.db, user.orgId))) return null;
    const a = await actorFor(ctx.db, user.userId, user.orgId);
    if (!a) return null;
    try {
      const { role } = await loadCard(ctx.db, a, id);
      return atLeast(role, 'editor') ? 'write' : role ? 'read' : null;
    } catch {
      return null;
    }
  },
  async load(ctx, id) {
    const [row] = await ctx.db
      .select({ s: boardCards.descYdoc })
      .from(boardCards)
      .where(eq(boardCards.id, id));
    return row?.s ?? null;
  },
  async store(ctx, id, doc, userId) {
    await withBoardEvents(ctx, async (tx) => {
      const [row] = await tx.select().from(boardCards).where(eq(boardCards.id, id)).for('update');
      if (!row) return;
      const m = merged(row.descYdoc, doc);
      await tx
        .update(boardCards)
        .set({
          descYdoc: m.state,
          descText: descriptionText(m.doc),
          ...(userId ? { updatedBy: userId } : {}),
        })
        .where(eq(boardCards.id, id));
      const [node] = await tx
        .select({ id: nodes.id, orgId: nodes.orgId, spaceId: nodes.spaceId })
        .from(nodes)
        .where(eq(nodes.id, row.boardNodeId));
      if (!node) return;
      const actor = userId ?? row.updatedBy ?? row.createdBy;
      if (!actor) return;
      announce(node, await touchBoard(tx, row.boardNodeId, actor));
    });
  },
};

const drawingDoc: CollabDocType = {
  prefix: 'drawing',
  async authorize(ctx, user, id) {
    // The org turned drawings off: no drawing document opens.
    if (!(await drawingsEnabled(ctx.db, user.orgId))) return null;
    const a = await actorFor(ctx.db, user.userId, user.orgId);
    if (!a) return null;
    try {
      const { role } = await loadDrawing(ctx.db, a, id);
      return atLeast(role, 'editor') ? 'write' : role ? 'read' : null;
    } catch {
      return null;
    }
  },
  async load(ctx, id) {
    const [row] = await ctx.db
      .select({ s: drawings.ydoc })
      .from(drawings)
      .where(eq(drawings.nodeId, id));
    return row?.s ?? null;
  },
  async store(ctx, id, doc, userId) {
    await withBoardEvents(ctx, async (tx) => {
      const [row] = await tx.select().from(drawings).where(eq(drawings.nodeId, id)).for('update');
      if (!row) return;
      const m = merged(row.ydoc, doc);
      await storeScene({ db: tx, jobs: ctx.jobs }, row, m.doc, userId);
    });
  },
};

export const boardsCollabDocs: CollabDocType[] = [cardDoc, drawingDoc];

export function parseDocumentName(name: string) {
  if (!BoardsCollabDocument.safeParse(name).success) return null;
  const [prefix, id] = name.split(':') as [string, string];
  const type = boardsCollabDocs.find((d) => d.prefix === prefix);
  return type ? { type, id } : null;
}

/* ----------------------------------- tokens ----------------------------------- */

const TOKEN_TTL_MS = 10 * 60 * 1000;

const TokenPayload = z.object({
  d: z.string(),
  u: z.uuid(),
  o: z.uuid(),
  r: z.boolean(),
  e: z.number(),
});
export type CollabTokenPayload = z.infer<typeof TokenPayload>;

const sign = (secret: string, body: string) =>
  createHmac('sha256', `collab:${secret}`).update(body).digest('base64url');

/** Short-lived token bound to one document (doc 17 §3 "Belgeye özel kısa ömürlü jeton"). */
export function signCollabToken(
  secret: string,
  payload: Omit<CollabTokenPayload, 'e'>,
  now = Date.now(),
) {
  const full: CollabTokenPayload = { ...payload, e: now + TOKEN_TTL_MS };
  const body = Buffer.from(JSON.stringify(full)).toString('base64url');
  return { token: `${body}.${sign(secret, body)}`, expiresAt: new Date(full.e) };
}

export function verifyCollabToken(secret: string, token: string, now = Date.now()) {
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = Buffer.from(sign(secret, body));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const parsed = TokenPayload.safeParse(
      JSON.parse(Buffer.from(body, 'base64url').toString('utf8')),
    );
    if (!parsed.success || parsed.data.e < now) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

/**
 * Where browsers reach the collab server: COLLAB_PUBLIC_URL (wiki config); COLLAB_URL overrides.
 * A path when it is on the web origin (`clientCollabUrl`).
 */
export function collabUrl(env: Env) {
  return clientCollabUrl(env, process.env.COLLAB_URL || collabConfig(env).publicUrl);
}

export async function createToken(
  ctx: { db: Db; secret: string; env: Env },
  a: DriveActor,
  document: string,
) {
  const parsed = parseDocumentName(document);
  if (!parsed) throw new AppError('collab_document_invalid');
  // The token endpoint is in no module table: each document type answers for its own module.
  const module = parsed.type.prefix === 'drawing' ? 'drawings' : 'boards';
  if (!(await isModuleEnabled(ctx.db, a.org.id, module))) {
    throw new AppError('module_disabled', { module });
  }
  const access = await parsed.type.authorize(
    { db: ctx.db, jobs: null },
    { userId: a.userId, orgId: a.org.id },
    parsed.id,
  );
  if (!access) throw new AppError('not_found');
  const readOnly = access === 'read';
  const { token, expiresAt } = signCollabToken(ctx.secret, {
    d: document,
    u: a.userId,
    o: a.org.id,
    r: readOnly,
  });
  return {
    token,
    url: collabUrl(ctx.env),
    document,
    readOnly,
    expiresAt: expiresAt.toISOString(),
  };
}
