import { and, asc, eq, inArray } from 'drizzle-orm';
import { portalRedirects, type DbOrTx } from '@crewhall/db';
import type { PortalRedirect } from '@crewhall/shared';
import { AppError } from '../../http/errors';
import type { RequestInfo } from '../../http/types';
import { audit } from '../audit';
import { loadSite, requireEdit, requireView, type PortalActor } from './access';

type RedirectRow = typeof portalRedirects.$inferSelect;

export const normalizePath = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);

export const toRedirect = (r: RedirectRow): PortalRedirect => ({
  id: r.id,
  fromPath: r.fromPath,
  toPath: r.toPath,
  code: r.code === 308 ? 308 : 301,
  auto: r.auto,
  createdAt: r.createdAt.toISOString(),
});

export async function listRedirects(db: DbOrTx, a: PortalActor, siteId: string) {
  requireView(a);
  const site = await loadSite(db, a, siteId);
  const rows = await db
    .select()
    .from(portalRedirects)
    .where(eq(portalRedirects.siteId, site.id))
    .orderBy(asc(portalRedirects.fromPath));
  return { items: rows.map(toRedirect) };
}

/** Follows `to` through the existing rules; true when it comes back to `from`. */
async function loops(db: DbOrTx, siteId: string, from: string, to: string) {
  let current = to;
  for (let i = 0; i < 20; i++) {
    if (current === from) return true;
    const [next] = await db
      .select({ to: portalRedirects.toPath })
      .from(portalRedirects)
      .where(and(eq(portalRedirects.siteId, siteId), eq(portalRedirects.fromPath, current)));
    if (!next) return false;
    current = next.to;
  }
  return true;
}

export async function createRedirect(
  db: DbOrTx,
  a: PortalActor,
  siteId: string,
  input: { fromPath: string; toPath: string; code: 301 | 308 },
  req: RequestInfo,
) {
  requireEdit(a);
  const site = await loadSite(db, a, siteId);
  const from = normalizePath(input.fromPath);
  const to = input.toPath.startsWith('/') ? normalizePath(input.toPath) : input.toPath;
  if (from === to || (await loops(db, site.id, from, to)))
    throw new AppError('portal_redirect_loop');
  const [row] = await db
    .insert(portalRedirects)
    .values({
      orgId: site.orgId,
      siteId: site.id,
      fromPath: from,
      toPath: to,
      code: input.code,
      createdBy: a.userId,
    })
    .onConflictDoUpdate({
      target: [portalRedirects.siteId, portalRedirects.fromPath],
      set: { toPath: to, code: input.code, auto: false, createdBy: a.userId },
    })
    .returning();
  await audit(
    db,
    {
      orgId: site.orgId,
      actorId: a.userId,
      action: 'portal.redirect.create',
      targetType: 'portal_site',
      targetId: site.id,
      meta: { from, to },
    },
    req,
  );
  return toRedirect(row!);
}

export async function deleteRedirect(db: DbOrTx, a: PortalActor, redirectId: string) {
  requireEdit(a);
  const [row] = await db
    .select()
    .from(portalRedirects)
    .where(and(eq(portalRedirects.id, redirectId), eq(portalRedirects.orgId, a.org.id)));
  if (!row) throw new AppError('not_found');
  await db.delete(portalRedirects).where(eq(portalRedirects.id, row.id));
  return {};
}

/**
 * Slug change (design 10 "URL'ler kutsal"): old → new as an automatic 301; rules that pointed
 * at the old path follow it, and a rule starting at the new path is dropped (no loop).
 */
export async function addAutoRedirects(
  db: DbOrTx,
  site: { id: string; orgId: string },
  moves: { from: string; to: string }[],
  actorId: string | null,
) {
  for (const m of moves) {
    const from = normalizePath(m.from);
    const to = normalizePath(m.to);
    if (from === to) continue;
    await db
      .delete(portalRedirects)
      .where(and(eq(portalRedirects.siteId, site.id), eq(portalRedirects.fromPath, to)));
    await db
      .update(portalRedirects)
      .set({ toPath: to })
      .where(and(eq(portalRedirects.siteId, site.id), eq(portalRedirects.toPath, from)));
    await db
      .insert(portalRedirects)
      .values({
        orgId: site.orgId,
        siteId: site.id,
        fromPath: from,
        toPath: to,
        code: 301,
        auto: true,
        createdBy: actorId,
      })
      .onConflictDoUpdate({
        target: [portalRedirects.siteId, portalRedirects.fromPath],
        set: { toPath: to, code: 301, auto: true },
      });
  }
}

/** Drops rules whose source path is served again (a page came back at that URL). */
export async function dropRedirectsFrom(db: DbOrTx, siteId: string, paths: string[]) {
  if (!paths.length) return 0;
  const dropped = await db
    .delete(portalRedirects)
    .where(
      and(
        eq(portalRedirects.siteId, siteId),
        inArray(portalRedirects.fromPath, paths.map(normalizePath)),
      ),
    )
    .returning({ id: portalRedirects.id });
  return dropped.length;
}
