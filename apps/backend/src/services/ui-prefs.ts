import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { nodes, pages, userUiPrefs, type DbOrTx, type UiPrefsData } from '@crewhall/db';
import type { UiPrefs, UpdateUiPrefs } from '@crewhall/shared';

/** What the client reads: the menu order always, sidebar choices once saved. */
function toPrefs(s: UiPrefsData): UiPrefs {
  return {
    navOrder: s.navOrder ?? [],
    ...(s.railOrder ? { railOrder: s.railOrder } : {}),
    ...(s.railHidden ? { railHidden: s.railHidden } : {}),
    ...(s.railShortcuts ? { railShortcuts: s.railShortcuts } : {}),
    ...(s.sidebarWidths ? { sidebarWidths: s.sidebarWidths } : {}),
    ...(s.sidebarCollapsed ? { sidebarCollapsed: s.sidebarCollapsed } : {}),
    ...(s.pagesFullWidth !== undefined ? { pagesFullWidth: s.pagesFullWidth } : {}),
    ...(s.pagesHideDone ? { pagesHideDone: s.pagesHideDone } : {}),
  };
}

/**
 * Full width used to be stored per page (API level < 7). Who switched it on was not recorded,
 * so a person starts with it on when a full-width page in the org was created or last edited
 * by them (kararlar.md, 2026-10-23).
 */
async function hadFullWidthPage(db: DbOrTx, orgId: string, userId: string): Promise<boolean> {
  const [hit] = await db
    .select({ id: pages.nodeId })
    .from(pages)
    .innerJoin(nodes, eq(nodes.id, pages.nodeId))
    .where(
      and(
        eq(pages.orgId, orgId),
        eq(pages.fullWidth, true),
        isNull(nodes.deletedAt),
        or(eq(nodes.createdBy, userId), eq(nodes.updatedBy, userId)),
      ),
    )
    .limit(1);
  return Boolean(hit);
}

/** Fills `pagesFullWidth` once from the old per-page choice; a value saved meanwhile wins. */
async function seedPagesFullWidth(db: DbOrTx, orgId: string, userId: string): Promise<UiPrefsData> {
  const value = { pagesFullWidth: await hadFullWidthPage(db, orgId, userId) };
  await db.insert(userUiPrefs).values({ orgId, userId, settings: value }).onConflictDoNothing();
  await db
    .update(userUiPrefs)
    .set({ settings: sql`${userUiPrefs.settings} || ${JSON.stringify(value)}::jsonb` })
    .where(
      and(
        eq(userUiPrefs.orgId, orgId),
        eq(userUiPrefs.userId, userId),
        sql`not (${userUiPrefs.settings} ? 'pagesFullWidth')`,
      ),
    );
  const [row] = await db
    .select()
    .from(userUiPrefs)
    .where(and(eq(userUiPrefs.orgId, orgId), eq(userUiPrefs.userId, userId)));
  return row?.settings ?? value;
}

/** The person's interface choices in this org (menu order, sidebars); defaults when none saved. */
export async function getUiPrefs(db: DbOrTx, orgId: string, userId: string): Promise<UiPrefs> {
  const [row] = await db
    .select()
    .from(userUiPrefs)
    .where(and(eq(userUiPrefs.orgId, orgId), eq(userUiPrefs.userId, userId)));
  const settings = row?.settings ?? {};
  if (settings.pagesFullWidth === undefined) {
    return toPrefs(await seedPagesFullWidth(db, orgId, userId));
  }
  return toPrefs(settings);
}

/** Each field given replaces the stored one whole (the web sends complete values). */
export async function updateUiPrefs(
  db: DbOrTx,
  orgId: string,
  userId: string,
  input: UpdateUiPrefs,
): Promise<UiPrefs> {
  const current = await getUiPrefs(db, orgId, userId);
  const settings: UiPrefsData = { ...current };
  // Duplicates dropped, first one wins; ids the web does not know are kept (harmless, and a
  // module turned off now keeps its place for when it comes back).
  if (input.navOrder) settings.navOrder = [...new Set(input.navOrder)];
  if (input.railOrder) settings.railOrder = [...new Set(input.railOrder)];
  if (input.railHidden) settings.railHidden = [...new Set(input.railHidden)];
  if (input.railShortcuts) settings.railShortcuts = input.railShortcuts;
  if (input.sidebarWidths) settings.sidebarWidths = input.sidebarWidths;
  if (input.sidebarCollapsed) settings.sidebarCollapsed = [...new Set(input.sidebarCollapsed)];
  if (input.pagesFullWidth !== undefined) settings.pagesFullWidth = input.pagesFullWidth;
  if (input.pagesHideDone) settings.pagesHideDone = [...new Set(input.pagesHideDone)];
  await db
    .insert(userUiPrefs)
    .values({ orgId, userId, settings })
    .onConflictDoUpdate({
      target: [userUiPrefs.orgId, userUiPrefs.userId],
      set: { settings, updatedAt: sql`now()` },
    });
  return toPrefs(settings);
}
