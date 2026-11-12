import { desc, eq } from 'drizzle-orm';
import { portalImports, type DbOrTx } from '@crewhall/db';
import { PortalImportReport } from '@crewhall/shared';
import { loadSite, requireView, userSummaries, type PortalActor } from './access';

/** Import reports for design 10.16 (written by `pnpm portal:import`). */
export async function listImports(db: DbOrTx, a: PortalActor, siteId: string) {
  requireView(a);
  const site = await loadSite(db, a, siteId);
  const rows = await db
    .select()
    .from(portalImports)
    .where(eq(portalImports.siteId, site.id))
    .orderBy(desc(portalImports.createdAt))
    .limit(20);
  const people = await userSummaries(
    db,
    rows.map((r) => r.actorId),
  );
  return {
    items: rows.map((r) =>
      PortalImportReport.parse({
        ...r.report,
        id: r.id,
        actor: r.actorId ? (people.get(r.actorId) ?? null) : null,
      }),
    ),
  };
}
