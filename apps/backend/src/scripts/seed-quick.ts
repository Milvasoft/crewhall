import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  newId,
  nodes,
  orgMembers,
  organizations,
  spaces,
  surfaceCards,
  surfaces,
  users,
} from '@crewhall/db';
import type { Deps } from '../deps';
import { toActor } from '../services/membership';
import { createFolder } from '../services/drive/nodes';
import { upsertLink } from '../services/quick/links';
import { ensureSurfaces } from '../services/quick/surfaces';
import { SEED_FOLDERS, SEED_LINKS, SEED_NOTE, SEED_ORG, SEED_TODOS, SEED_USERS } from './seed-data';

/**
 * Phase 1 sample: the owner's Benim surface (link group, note, to-do), the default
 * space's surface and a few Drive folders. Idempotent: skipped when Benim has cards.
 */
export async function seedQuickAccess(deps: Deps) {
  const { db } = deps;
  const [org] = await db.select().from(organizations).where(eq(organizations.slug, SEED_ORG.slug));
  const [owner] = await db.select().from(users).where(eq(users.email, SEED_USERS[0]!.email));
  if (!org || !owner) return false;
  const [member] = await db
    .select()
    .from(orgMembers)
    .where(and(eq(orgMembers.organizationId, org.id), eq(orgMembers.userId, owner.id)));
  if (!member) return false;
  const a = { org, actor: toActor(member), userId: owner.id };
  await ensureSurfaces(db, a);
  const [mine] = await db
    .select()
    .from(surfaces)
    .where(
      and(
        eq(surfaces.orgId, org.id),
        eq(surfaces.ownerType, 'user'),
        eq(surfaces.ownerId, owner.id),
      ),
    );
  if (!mine) return false;
  const existing = await db
    .select({ id: surfaceCards.id })
    .from(surfaceCards)
    .where(and(eq(surfaceCards.surfaceId, mine.id), isNull(surfaceCards.deletedAt)));
  if (existing.length) {
    await markSeededSurfaces(org.id, owner.id);
    return false;
  }

  const items = [];
  for (const l of SEED_LINKS) {
    const link = await upsertLink(
      db,
      org.id,
      { url: l.url, title: l.title, checkEnabled: true, intervalSeconds: 300 },
      { title: l.title, faviconUrl: null },
    );
    items.push({ id: newId(), linkId: link.id, title: l.title, description: null });
  }
  const group = {
    title: SEED_ORG.name,
    color: 's1',
    view: 'list',
    sort: 'manual',
    sectionsAsTabs: false,
    showUrls: true,
    showHealth: true,
    sections: [{ id: newId(), title: '', items }],
  };
  const base = { orgId: org.id, createdBy: owner.id };
  await db.insert(surfaceCards).values([
    { ...base, surfaceId: mine.id, type: 'link_group', x: 0, y: 0, w: 3, h: 4, config: group },
    {
      ...base,
      surfaceId: mine.id,
      type: 'note',
      x: 3,
      y: 0,
      w: 3,
      h: 2,
      config: { text: SEED_NOTE, color: 's3', fontSize: 'normal' },
    },
    {
      ...base,
      surfaceId: mine.id,
      type: 'todo',
      x: 6,
      y: 0,
      w: 3,
      h: 3,
      config: {
        title: 'Bu hafta',
        items: SEED_TODOS.map((text, i) => ({
          id: newId(),
          text,
          done: i < 2,
          doneAt: i < 2 ? new Date().toISOString() : null,
        })),
      },
    },
  ]);

  const [defaultSpace] = await db
    .select()
    .from(spaces)
    .where(and(eq(spaces.orgId, org.id), eq(spaces.isDefault, true)));
  if (defaultSpace) {
    const [spaceSurface] = await db
      .select()
      .from(surfaces)
      .where(and(eq(surfaces.ownerType, 'space'), eq(surfaces.ownerId, defaultSpace.id)));
    if (spaceSurface) {
      await db.insert(surfaceCards).values({
        ...base,
        surfaceId: spaceSurface.id,
        type: 'note',
        x: 0,
        y: 0,
        w: 4,
        h: 2,
        config: {
          text: "PR'lar en az bir onayla birleşir. Prod'a Cuma 17:00'den sonra çıkılmaz.",
          color: 's2',
          fontSize: 'normal',
        },
      });
    }
    for (const name of SEED_FOLDERS) {
      const [exists] = await db
        .select({ id: nodes.id })
        .from(nodes)
        .where(
          and(eq(nodes.spaceId, defaultSpace.id), eq(nodes.name, name), isNull(nodes.parentId)),
        );
      if (!exists) await createFolder(db, a, defaultSpace.id, { parentId: null, name });
    }
  }
  await markSeededSurfaces(org.id, owner.id);
  return true;

  /** Surfaces with seeded cards show "Son değişiklik" (2.8): set who changed them last. */
  async function markSeededSurfaces(orgId: string, ownerId: string) {
    await db
      .update(surfaces)
      .set({ updatedBy: ownerId, updatedAt: new Date() })
      .where(
        and(
          eq(surfaces.orgId, orgId),
          isNull(surfaces.updatedBy),
          sql`exists (select 1 from ${surfaceCards} c where c.surface_id = "surfaces"."id" and c.deleted_at is null)`,
        ),
      );
  }
}
