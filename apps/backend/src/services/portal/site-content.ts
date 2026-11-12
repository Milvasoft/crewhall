import { eq, sql } from 'drizzle-orm';
import { portalSites, type DbOrTx } from '@crewhall/db';
import { PortalHome, PortalNavigation } from '@crewhall/shared';
import { AppError } from '../../http/errors';
import {
  iso,
  loadSite,
  requireEdit,
  requireView,
  userSummaries,
  type PortalActor,
  type SiteRow,
} from './access';
import { SYSTEM_NAV_KINDS } from './defaults';

/** Home page sections (design 10.8): draft vs. published. */
export async function getHome(db: DbOrTx, a: PortalActor, siteId: string) {
  requireView(a);
  return homeState(db, await loadSite(db, a, siteId));
}

async function homeState(db: DbOrTx, site: SiteRow) {
  const people = await userSummaries(db, [site.homeUpdatedBy]);
  return {
    draft: PortalHome.parse(site.homeDraft),
    published: site.home ? PortalHome.parse(site.home) : null,
    changed: site.homeRev > site.homePublishedRev,
    updatedAt: iso(site.homeUpdatedAt),
    updatedBy: site.homeUpdatedBy ? (people.get(site.homeUpdatedBy) ?? null) : null,
  };
}

export async function updateHome(db: DbOrTx, a: PortalActor, siteId: string, home: PortalHome) {
  requireEdit(a);
  const site = await loadSite(db, a, siteId);
  const ids = home.sections.map((s) => s.id);
  if (new Set(ids).size !== ids.length)
    throw new AppError('validation_failed', { reason: 'duplicate_section_id' });
  const [row] = await db
    .update(portalSites)
    .set({
      homeDraft: home,
      homeRev: sql`${portalSites.homeRev} + 1`,
      homeUpdatedAt: new Date(),
      homeUpdatedBy: a.userId,
    })
    .where(eq(portalSites.id, site.id))
    .returning();
  return homeState(db, row!);
}

/** Navbar and footer (design 10.9). */
export async function getNavigation(db: DbOrTx, a: PortalActor, siteId: string) {
  requireView(a);
  return navState(db, await loadSite(db, a, siteId));
}

async function navState(db: DbOrTx, site: SiteRow) {
  const people = await userSummaries(db, [site.navUpdatedBy]);
  return {
    draft: PortalNavigation.parse(site.navDraft),
    published: site.nav ? PortalNavigation.parse(site.nav) : null,
    changed: site.navRev > site.navPublishedRev,
    updatedAt: iso(site.navUpdatedAt),
    updatedBy: site.navUpdatedBy ? (people.get(site.navUpdatedBy) ?? null) : null,
  };
}

export async function updateNavigation(
  db: DbOrTx,
  a: PortalActor,
  siteId: string,
  nav: PortalNavigation,
) {
  requireEdit(a);
  const site = await loadSite(db, a, siteId);
  // Language and version dropdowns are system items: they can be hidden, never removed.
  const kinds = new Set(nav.navbar.items.map((i) => i.kind));
  for (const kind of SYSTEM_NAV_KINDS) {
    if (!kinds.has(kind))
      throw new AppError('validation_failed', { reason: 'system_item_removed', kind });
  }
  const ids = nav.navbar.items.map((i) => i.id);
  if (new Set(ids).size !== ids.length)
    throw new AppError('validation_failed', { reason: 'duplicate_item_id' });
  const [row] = await db
    .update(portalSites)
    .set({
      navDraft: nav,
      navRev: sql`${portalSites.navRev} + 1`,
      navUpdatedAt: new Date(),
      navUpdatedBy: a.userId,
    })
    .where(eq(portalSites.id, site.id))
    .returning();
  return navState(db, row!);
}
