import { and, eq, lt, sql } from 'drizzle-orm';
import { davLocks, nodes, type DbOrTx } from '@crewhall/db';
import { escapeXml } from './xml';

export type LockRow = typeof davLocks.$inferSelect;

export const LOCK_PREFIX = 'opaquelocktoken:';
/** Default and longest lock life; clients refresh before it runs out. */
export const DEFAULT_LOCK_SECONDS = 3600;
export const MAX_LOCK_SECONDS = 24 * 3600;

export const lockToken = (lock: Pick<LockRow, 'id'>) => `${LOCK_PREFIX}${lock.id}`;

/** Lock ids in an If header (RFC 4918 §10.4), read leniently: every token it names. */
export function submittedTokens(ifHeader: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const m of (ifHeader ?? '').matchAll(/<opaquelocktoken:([0-9a-f-]{36})>/gi)) {
    out.add(m[1]!.toLowerCase());
  }
  return out;
}

/** "Second-600", "Infinite, Second-4100000000" → seconds, capped. */
export function lockTimeout(header: string | undefined): number {
  for (const part of (header ?? '').split(',')) {
    const m = /^\s*Second-(\d+)\s*$/i.exec(part);
    if (m) return Math.max(1, Math.min(MAX_LOCK_SECONDS, Number(m[1])));
    if (/^\s*Infinite\s*$/i.test(part)) return MAX_LOCK_SECONDS;
  }
  return DEFAULT_LOCK_SECONDS;
}

export async function dropExpiredLocks(db: DbOrTx) {
  await db.delete(davLocks).where(lt(davLocks.expiresAt, new Date()));
}

/**
 * Live locks that cover `path`: on the node itself, or depth-infinity locks on an ancestor;
 * with `subtree`, also locks anywhere below it (deleting or moving a folder).
 */
export async function locksCovering(db: DbOrTx, path: string, subtree = false) {
  const rows = await db
    .select({ lock: davLocks })
    .from(davLocks)
    .innerJoin(nodes, eq(nodes.id, davLocks.nodeId))
    .where(
      and(
        sql`${davLocks.expiresAt} > now()`,
        subtree
          ? sql`((${nodes.path} @> ${path}::ltree and (${nodes.path} = ${path}::ltree or ${davLocks.depth} = 'infinity')) or ${nodes.path} <@ ${path}::ltree)`
          : sql`(${nodes.path} @> ${path}::ltree and (${nodes.path} = ${path}::ltree or ${davLocks.depth} = 'infinity'))`,
      ),
    );
  return rows.map((r) => r.lock);
}

/** A write passes when every covering lock is the caller's and its token was sent. */
export function locksSatisfied(locks: LockRow[], userId: string, tokens: Set<string>) {
  return locks.every((l) => l.userId === userId && tokens.has(l.id));
}

export function activeLockXml(lock: LockRow, rootHref: string): string {
  const left = Math.max(0, Math.round((lock.expiresAt.getTime() - Date.now()) / 1000));
  return (
    '<D:activelock>' +
    '<D:locktype><D:write/></D:locktype>' +
    `<D:lockscope><D:${lock.scope}/></D:lockscope>` +
    `<D:depth>${lock.depth === '0' ? '0' : 'infinity'}</D:depth>` +
    (lock.owner ? `<D:owner>${lock.owner}</D:owner>` : '') +
    `<D:timeout>Second-${left}</D:timeout>` +
    `<D:locktoken><D:href>${lockToken(lock)}</D:href></D:locktoken>` +
    `<D:lockroot><D:href>${escapeXml(rootHref)}</D:href></D:lockroot>` +
    '</D:activelock>'
  );
}

export const SUPPORTED_LOCK =
  '<D:supportedlock>' +
  '<D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry>' +
  '<D:lockentry><D:lockscope><D:shared/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry>' +
  '</D:supportedlock>';

export async function lockById(db: DbOrTx, id: string) {
  const [row] = await db.select().from(davLocks).where(eq(davLocks.id, id));
  return row ?? null;
}
