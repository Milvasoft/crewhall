import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  conversationMembers,
  newId,
  nodes,
  spaceMembers,
  spaces,
  surfaceCards,
  surfaces,
  users,
  type DbOrTx,
} from '@crewhall/db';
import { resources, resolveLocale } from '@crewhall/i18n';
import {
  can,
  BoardAssignedConfig,
  type CardLayout,
  ChatCardConfig,
  LinkCardConfig,
  LinkGroupConfig,
  MeetingCardConfig,
  NodeCardConfig,
  NoteConfig,
  PageCardConfig,
  TodoConfig,
  VaultItemCardConfig,
  type Card,
  type CardMoveTarget,
  type CardType,
  type CreateCard,
  type DriveNode,
  type Link,
  type LinkInput,
  type MobileCardWidth,
  type SpaceRole,
  type Surface,
  type SurfaceSummary,
} from '@crewhall/shared';
import type { z } from 'zod';
import { AppError } from '../../http/errors';
import { publishToUsers, type Bus } from '../../realtime/bus';
import { nodeAudience } from '../boards/access';
import { mapVisible, type DriveActor } from '../drive/access';
import { orgContext } from '../membership';
import { linksByIds, upsertLink } from './links';

type SurfaceRow = typeof surfaces.$inferSelect;
type CardRow = typeof surfaceCards.$inferSelect;

const CONFIG_SCHEMAS: Record<CardType, z.ZodType> = {
  link: LinkCardConfig,
  link_group: LinkGroupConfig,
  note: NoteConfig,
  todo: TodoConfig,
  node: NodeCardConfig,
  board_assigned: BoardAssignedConfig,
  page: PageCardConfig,
  chat: ChatCardConfig,
  meeting: MeetingCardConfig,
  vault_item: VaultItemCardConfig,
};

/** Default sizes on the 12-column grid (design 2.4: a single link card is 2 × 1). */
const DEFAULT_SIZE: Record<CardType, { w: number; h: number }> = {
  link: { w: 2, h: 1 },
  link_group: { w: 3, h: 3 },
  note: { w: 3, h: 2 },
  todo: { w: 3, h: 3 },
  node: { w: 3, h: 2 },
  board_assigned: { w: 4, h: 3 },
  page: { w: 3, h: 3 },
  chat: { w: 3, h: 3 },
  meeting: { w: 3, h: 2 },
  vault_item: { w: 3, h: 1 },
};

export interface SurfaceAccess {
  surface: SurfaceRow;
  canEdit: boolean;
  space: typeof spaces.$inferSelect | null;
}

/** Benim for the caller and one surface per shared space they belong to, created on demand. */
export async function ensureSurfaces(db: DbOrTx, a: DriveActor) {
  await db
    .insert(surfaces)
    .values({ orgId: a.org.id, ownerType: 'user', ownerId: a.userId })
    .onConflictDoNothing();
  const memberSpaces = await db
    .select({ id: spaces.id })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
    .where(
      and(
        eq(spaceMembers.userId, a.userId),
        eq(spaces.orgId, a.org.id),
        eq(spaces.kind, 'shared'),
        isNull(spaces.archivedAt),
      ),
    );
  if (memberSpaces.length) {
    await db
      .insert(surfaces)
      .values(
        memberSpaces.map((s) => ({ orgId: a.org.id, ownerType: 'space' as const, ownerId: s.id })),
      )
      .onConflictDoNothing();
  }
}

export async function surfaceAccess(
  db: DbOrTx,
  a: DriveActor,
  surfaceId: string,
): Promise<SurfaceAccess> {
  const [surface] = await db
    .select()
    .from(surfaces)
    .where(and(eq(surfaces.id, surfaceId), eq(surfaces.orgId, a.org.id)));
  if (!surface) throw new AppError('not_found');
  if (surface.ownerType === 'user') {
    if (surface.ownerId !== a.userId) throw new AppError('not_found');
    return { surface, canEdit: true, space: null };
  }
  const [row] = await db
    .select({ space: spaces, role: spaceMembers.role })
    .from(spaces)
    .leftJoin(
      spaceMembers,
      and(eq(spaceMembers.spaceId, spaces.id), eq(spaceMembers.userId, a.userId)),
    )
    .where(eq(spaces.id, surface.ownerId));
  const role = (row?.role ?? null) as SpaceRole | null;
  if (!row || !role || row.space.deletedAt) throw new AppError('not_found');
  const resource = { type: 'space' as const, org: orgContext(a.org), myRole: role };
  return {
    surface,
    space: row.space,
    canEdit: !row.space.archivedAt && can(a.actor, 'space.edit_surface', resource),
  };
}

function requireEdit(access: SurfaceAccess) {
  if (!access.canEdit) throw new AppError('forbidden');
}

/** The card exists in the org and the person may edit its surface. */
export async function requireCardEdit(db: DbOrTx, a: DriveActor, cardId: string) {
  const { access } = await cardAccess(db, a, cardId);
  requireEdit(access);
}

async function touch(db: DbOrTx, surfaceId: string, userId: string) {
  await db
    .update(surfaces)
    .set({ updatedBy: userId, updatedAt: new Date() })
    .where(eq(surfaces.id, surfaceId));
}

export async function listSurfaces(db: DbOrTx, a: DriveActor): Promise<SurfaceSummary[]> {
  await ensureSurfaces(db, a);
  const rows = await db
    .select({
      surface: surfaces,
      cards: sql<number>`(select count(*)::int from ${surfaceCards} c where c.surface_id = "surfaces"."id" and c.deleted_at is null)`,
    })
    .from(surfaces)
    .where(eq(surfaces.orgId, a.org.id));
  const out: SurfaceSummary[] = [];
  for (const r of rows) {
    if (r.surface.ownerType === 'user') {
      if (r.surface.ownerId !== a.userId) continue;
      out.unshift({ id: r.surface.id, owner: { type: 'user' }, canEdit: true, cardCount: r.cards });
      continue;
    }
    const access = await surfaceAccess(db, a, r.surface.id).catch(() => null);
    if (!access?.space || access.space.archivedAt) continue;
    out.push({
      id: r.surface.id,
      owner: {
        type: 'space',
        spaceId: access.space.id,
        spaceName: access.space.name,
        spaceColor: access.space.color,
      },
      canEdit: access.canEdit,
      cardCount: r.cards,
    });
  }
  const [mine, ...rest] = out;
  rest.sort((x, y) =>
    x.owner.type === 'space' && y.owner.type === 'space'
      ? x.owner.spaceName.localeCompare(y.owner.spaceName, 'tr')
      : 0,
  );
  return mine ? [mine, ...rest] : rest;
}

/**
 * Mobile home settings of a card (hidden, width) live beside its config under this key, so they
 * need no column of their own. They belong to the card row (a pin has its own), clients never
 * see the key, and every config write keeps it (keepMobile).
 */
const MOBILE_KEY = '_mobile';
const MOBILE_SQL = sql.raw(`'${MOBILE_KEY}'`);

interface MobileSettings {
  hidden?: boolean;
  width?: MobileCardWidth;
}

function mobileOf(config: Record<string, unknown>): MobileSettings {
  const m = config[MOBILE_KEY];
  return m && typeof m === 'object' ? (m as MobileSettings) : {};
}

function withoutMobile(config: Record<string, unknown>): Record<string, unknown> {
  if (!(MOBILE_KEY in config)) return config;
  const { [MOBILE_KEY]: _, ...rest } = config;
  return rest;
}

/** A new config for the row, keeping the row's own mobile settings. */
function keepMobile(config: Record<string, unknown>) {
  return sql<
    Record<string, unknown>
  >`${JSON.stringify(withoutMobile(config))}::jsonb || case when ${surfaceCards.config} -> ${MOBILE_SQL} is not null then jsonb_build_object(${MOBILE_SQL}, ${surfaceCards.config} -> ${MOBILE_SQL}) else '{}'::jsonb end`;
}

/** Link ids a card config refers to. */
function linkIdsOf(type: string, config: Record<string, unknown>): string[] {
  if (type === 'link') {
    const parsed = LinkCardConfig.safeParse(config);
    return parsed.success ? [parsed.data.item.linkId] : [];
  }
  if (type === 'link_group') {
    const parsed = LinkGroupConfig.safeParse(config);
    return parsed.success ? parsed.data.sections.flatMap((s) => s.items.map((i) => i.linkId)) : [];
  }
  return [];
}

/** Cards as clients see them: pinned cards show their source, links and nodes resolved. */
async function toCards(db: DbOrTx, a: DriveActor, rows: CardRow[]): Promise<Card[]> {
  const sourceIds = rows.map((r) => r.pinnedFromCardId).filter((v): v is string => !!v);
  const sources = new Map(
    (sourceIds.length
      ? await db
          .select()
          .from(surfaceCards)
          .where(and(inArray(surfaceCards.id, sourceIds), isNull(surfaceCards.deletedAt)))
      : []
    ).map((s) => [s.id, s]),
  );
  const shown = rows.map((r) => {
    const src = r.pinnedFromCardId ? sources.get(r.pinnedFromCardId) : undefined;
    return {
      row: r,
      type: src?.type ?? r.type,
      config: withoutMobile(src?.config ?? r.config),
      targetId: src?.targetId ?? r.targetId,
      src,
    };
  });

  const allLinkIds = [...new Set(shown.flatMap((s) => linkIdsOf(s.type, s.config)))];
  const linkMap = await linksByIds(db, a.org.id, allLinkIds);

  // Node and page cards carry their node (or null: deleted or not visible, shown locked).
  const hasNode = (type: string) => type === 'node' || type === 'page';
  const nodeIds = shown.filter((s) => hasNode(s.type) && s.targetId).map((s) => s.targetId!);
  const nodeRows = nodeIds.length
    ? await db
        .select()
        .from(nodes)
        .where(and(inArray(nodes.id, nodeIds), eq(nodes.orgId, a.org.id), isNull(nodes.deletedAt)))
    : [];
  const visibleNodes = new Map((await mapVisible(db, a, nodeRows)).map((n) => [n.id, n]));

  const out: Card[] = [];
  for (const s of shown) {
    const links: Record<string, Link> = {};
    for (const id of linkIdsOf(s.type, s.config)) {
      const l = linkMap.get(id);
      if (l) links[id] = l;
    }
    const node = hasNode(s.type) && s.targetId ? (visibleNodes.get(s.targetId) ?? null) : null;
    let children: DriveNode[] = [];
    if (node && node.type === 'folder') {
      const max = NodeCardConfig.safeParse(s.config).data?.maxItems ?? 6;
      const kids = await db
        .select()
        .from(nodes)
        .where(and(eq(nodes.parentId, node.id), isNull(nodes.deletedAt)))
        .orderBy(sql`(${nodes.type} <> 'folder')`, asc(nodes.name))
        .limit(max);
      children = await mapVisible(db, a, kids);
    }
    out.push({
      type: s.type,
      config: s.config,
      id: s.row.id,
      surfaceId: s.row.surfaceId,
      layout: { x: s.row.x, y: s.row.y, w: s.row.w, h: s.row.h },
      mobileOrder: s.row.mobileOrder,
      mobileHidden: mobileOf(s.row.config).hidden ?? false,
      mobileWidth: mobileOf(s.row.config).width ?? null,
      links,
      node,
      children,
      pinnedFrom:
        s.row.pinnedFromCardId && s.src ? { cardId: s.src.id, surfaceId: s.src.surfaceId } : null,
      sourceMissing:
        s.row.pinnedFromCardId !== null && !s.src ? true : s.row.sourceRemovedAt !== null,
      createdAt: s.row.createdAt.toISOString(),
      updatedAt: s.row.updatedAt.toISOString(),
    } as Card);
  }
  return out;
}

export async function getSurface(db: DbOrTx, a: DriveActor, surfaceId: string): Promise<Surface> {
  const access = await surfaceAccess(db, a, surfaceId);
  const rows = await db
    .select()
    .from(surfaceCards)
    .where(and(eq(surfaceCards.surfaceId, surfaceId), isNull(surfaceCards.deletedAt)))
    .orderBy(asc(surfaceCards.y), asc(surfaceCards.x));
  const count = rows.length;
  const [by] = access.surface.updatedBy
    ? await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(eq(users.id, access.surface.updatedBy))
    : [];
  return {
    id: access.surface.id,
    owner: access.space
      ? {
          type: 'space',
          spaceId: access.space.id,
          spaceName: access.space.name,
          spaceColor: access.space.color,
        }
      : { type: 'user' },
    canEdit: access.canEdit,
    cardCount: count,
    layoutRev: access.surface.layoutRev,
    cards: await toCards(db, a, rows),
    updatedAt: access.surface.updatedAt.toISOString(),
    updatedBy: by ?? null,
  };
}

async function cardAccess(
  db: DbOrTx,
  a: DriveActor,
  cardId: string,
  options: { includeDeleted?: boolean } = {},
) {
  const [card] = await db
    .select()
    .from(surfaceCards)
    .where(and(eq(surfaceCards.id, cardId), eq(surfaceCards.orgId, a.org.id)));
  if (!card || (card.deletedAt && !options.includeDeleted)) throw new AppError('not_found');
  const access = await surfaceAccess(db, a, card.surfaceId);
  return { card, access };
}

async function bottomOf(db: DbOrTx, surfaceId: string) {
  const [row] = await db
    .select({ y: sql<number>`coalesce(max(${surfaceCards.y} + ${surfaceCards.h}), 0)::int` })
    .from(surfaceCards)
    .where(and(eq(surfaceCards.surfaceId, surfaceId), isNull(surfaceCards.deletedAt)));
  return row?.y ?? 0;
}

async function cardOut(db: DbOrTx, a: DriveActor, id: string) {
  const [row] = await db.select().from(surfaceCards).where(eq(surfaceCards.id, id));
  return (await toCards(db, a, [row!]))[0]!;
}

function validateConfig(type: string, config: unknown) {
  const schema = CONFIG_SCHEMAS[type as CardType];
  if (!schema) throw new AppError('bad_request', { reason: 'unknown_card_type' });
  const parsed = schema.safeParse(config);
  if (!parsed.success) {
    throw new AppError('validation_failed', {
      in: 'body',
      issues: parsed.error.issues.map((i) => ({
        path: ['config', ...i.path.map(String)],
        code: i.code,
        message: i.message,
      })),
    });
  }
  return parsed.data as Record<string, unknown>;
}

const t = (locale: string | null) => resources[resolveLocale(locale)].common.quick;

export async function createCard(
  db: DbOrTx,
  a: DriveActor,
  surfaceId: string,
  input: CreateCard,
  locale: string | null,
): Promise<Card> {
  const access = await surfaceAccess(db, a, surfaceId);
  requireEdit(access);
  let config: Record<string, unknown>;
  let targetId: string | null = null;
  switch (input.type) {
    case 'link': {
      const link = await upsertLink(db, a.org.id, input.link);
      config = {
        item: {
          id: newId(),
          linkId: link.id,
          title: input.link.title ?? link.siteTitle ?? link.host,
          description: input.link.description ?? null,
          ...(input.link.iconUrl ? { iconUrl: input.link.iconUrl } : {}),
        },
      };
      break;
    }
    case 'link_group': {
      const c = input.config;
      config = {
        title: c.title,
        color: c.color ?? null,
        view: c.view ?? 'list',
        sort: c.sort ?? 'manual',
        sectionsAsTabs: c.sectionsAsTabs ?? false,
        showUrls: c.showUrls ?? true,
        showHealth: c.showHealth ?? true,
        sections: (c.sections?.length ? c.sections : [{ title: '' }]).map((s) => ({
          id: newId(),
          title: s.title,
          items: [],
        })),
      };
      break;
    }
    case 'note':
      config = { text: '', color: 's1', fontSize: 'normal', ...input.config };
      break;
    case 'todo':
      config = { title: t(locale).todoTitle, items: [], ...input.config };
      break;
    case 'node': {
      const [n] = await db
        .select({ id: nodes.id })
        .from(nodes)
        .where(and(eq(nodes.id, input.config.nodeId), eq(nodes.orgId, a.org.id)));
      if (
        !n ||
        (await mapVisible(db, a, await db.select().from(nodes).where(eq(nodes.id, n.id))))
          .length === 0
      ) {
        throw new AppError('not_found');
      }
      targetId = n.id;
      config = { ...input.config };
      break;
    }
    case 'board_assigned':
      // The boards module answers the content; the card keeps only the view settings.
      config = { scope: 'assigned', spaceId: null, limit: 6, ...input.config };
      break;
    case 'page': {
      const [n] = await db
        .select()
        .from(nodes)
        .where(
          and(
            eq(nodes.id, input.config.nodeId),
            eq(nodes.orgId, a.org.id),
            eq(nodes.type, 'page'),
            isNull(nodes.deletedAt),
          ),
        );
      if (!n || (await mapVisible(db, a, [n])).length === 0) throw new AppError('not_found');
      targetId = n.id;
      config = { nodeId: n.id };
      break;
    }
    // Chat, meeting and vault cards keep ids only; their modules answer the content with the
    // viewer's own rights (the vault item is decrypted on the viewer's device).
    case 'chat':
      config = { limit: 5, ...input.config };
      break;
    case 'meeting':
      config = { spaceId: null, ...input.config };
      break;
    case 'vault_item':
      config = { ...input.config };
      break;
  }
  config = validateConfig(input.type, config);
  const size = DEFAULT_SIZE[input.type];
  const layout = input.layout ?? { x: 0, y: await bottomOf(db, surfaceId), ...size };
  const [row] = await db
    .insert(surfaceCards)
    .values({
      orgId: a.org.id,
      surfaceId,
      type: input.type,
      ...layout,
      config,
      targetId,
      createdBy: a.userId,
    })
    .returning();
  await touch(db, surfaceId, a.userId);
  return (await toCards(db, a, [row!]))[0]!;
}

export async function updateCard(
  db: DbOrTx,
  a: DriveActor,
  cardId: string,
  input: {
    config?: unknown;
    layout?: { x: number; y: number; w: number; h: number };
    detach?: boolean;
  },
) {
  const { card, access } = await cardAccess(db, a, cardId);
  requireEdit(access);
  const patch: Partial<CardRow> = {};
  let config: Record<string, unknown> | undefined;
  if (input.detach && card.pinnedFromCardId) {
    const [src] = await db
      .select()
      .from(surfaceCards)
      .where(eq(surfaceCards.id, card.pinnedFromCardId));
    patch.pinnedFromCardId = null;
    patch.sourceRemovedAt = null;
    if (src && !src.deletedAt) {
      patch.type = src.type;
      config = src.config;
      patch.targetId = src.targetId;
    }
  } else if (input.detach && card.sourceRemovedAt) {
    patch.sourceRemovedAt = null;
  }
  if (input.config !== undefined) {
    if (card.pinnedFromCardId && !input.detach) {
      // Editing a pinned card edits the source (2.8: "kaynak değişince… güncellenir").
      const src = await cardAccess(db, a, card.pinnedFromCardId);
      requireEdit(src.access);
      const srcConfig = validateConfig(src.card.type, input.config);
      await assertLinksInOrg(db, a.org.id, src.card.type, srcConfig);
      await db
        .update(surfaceCards)
        .set({ config: keepMobile(srcConfig) })
        .where(eq(surfaceCards.id, src.card.id));
    } else {
      const type = patch.type ?? card.type;
      config = validateConfig(type, input.config);
      await assertLinksInOrg(db, a.org.id, type, config);
      if (type === 'node') patch.targetId = NodeCardConfig.parse(config).nodeId;
    }
  }
  if (input.layout) Object.assign(patch, input.layout);
  if (Object.keys(patch).length || config) {
    await db
      .update(surfaceCards)
      .set({ ...patch, ...(config ? { config: keepMobile(config) } : {}) })
      .where(eq(surfaceCards.id, card.id));
    await touch(db, card.surfaceId, a.userId);
  }
  return cardOut(db, a, card.id);
}

async function assertLinksInOrg(
  db: DbOrTx,
  orgId: string,
  type: string,
  config: Record<string, unknown>,
) {
  const ids = linkIdsOf(type, config);
  if (ids.length === 0) return;
  const found = await linksByIds(db, orgId, [...new Set(ids)]);
  if (found.size !== new Set(ids).size) {
    throw new AppError('validation_failed', {
      in: 'body',
      issues: [{ path: ['config'], code: 'unknown_link', message: 'unknown linkId' }],
    });
  }
}

export async function updateLayout(
  db: DbOrTx,
  a: DriveActor,
  surfaceId: string,
  input: {
    layoutRev: number;
    items?:
      { cardId: string; layout: { x: number; y: number; w: number; h: number } }[] | undefined;
    mobileOrder?: string[] | undefined;
    mobile?:
      | {
          cardId: string;
          hidden?: boolean | undefined;
          width?: MobileCardWidth | null | undefined;
        }[]
      | undefined;
  },
) {
  const access = await surfaceAccess(db, a, surfaceId);
  requireEdit(access);
  const [bumped] = await db
    .update(surfaces)
    .set({ layoutRev: sql`${surfaces.layoutRev} + 1`, updatedBy: a.userId, updatedAt: new Date() })
    .where(and(eq(surfaces.id, surfaceId), eq(surfaces.layoutRev, input.layoutRev)))
    .returning({ layoutRev: surfaces.layoutRev });
  if (!bumped)
    throw new AppError('conflict', { reason: 'layout_rev', layoutRev: access.surface.layoutRev });
  for (const item of input.items ?? []) {
    await db
      .update(surfaceCards)
      .set(item.layout)
      .where(and(eq(surfaceCards.id, item.cardId), eq(surfaceCards.surfaceId, surfaceId)));
  }
  for (const [i, cardId] of (input.mobileOrder ?? []).entries()) {
    await db
      .update(surfaceCards)
      .set({ mobileOrder: i })
      .where(and(eq(surfaceCards.id, cardId), eq(surfaceCards.surfaceId, surfaceId)));
  }
  for (const m of input.mobile ?? []) {
    // A null width goes back to deriving it from the web width (the key is dropped).
    const change = {
      ...(m.hidden !== undefined ? { hidden: m.hidden } : {}),
      ...(m.width !== undefined ? { width: m.width } : {}),
    };
    if (Object.keys(change).length === 0) continue;
    await db
      .update(surfaceCards)
      .set({
        config: sql`jsonb_set(${surfaceCards.config}, array[${MOBILE_SQL}], jsonb_strip_nulls(coalesce(${surfaceCards.config} -> ${MOBILE_SQL}, '{}'::jsonb) || ${JSON.stringify(change)}::jsonb))`,
      })
      .where(and(eq(surfaceCards.id, m.cardId), eq(surfaceCards.surfaceId, surfaceId)));
  }
  return { layoutRev: bumped.layoutRev };
}

/** Removes the card only (never the node it points to); pins of it show "Kaynak kaldırıldı". */
export async function deleteCard(db: DbOrTx, a: DriveActor, cardId: string) {
  const { card, access } = await cardAccess(db, a, cardId);
  requireEdit(access);
  const now = new Date();
  await db.update(surfaceCards).set({ deletedAt: now }).where(eq(surfaceCards.id, card.id));
  await db
    .update(surfaceCards)
    .set({ sourceRemovedAt: now })
    .where(eq(surfaceCards.pinnedFromCardId, card.id));
  await touch(db, card.surfaceId, a.userId);
}

export async function restoreCard(db: DbOrTx, a: DriveActor, cardId: string) {
  const { card, access } = await cardAccess(db, a, cardId, { includeDeleted: true });
  requireEdit(access);
  await db.update(surfaceCards).set({ deletedAt: null }).where(eq(surfaceCards.id, card.id));
  await db
    .update(surfaceCards)
    .set({ sourceRemovedAt: null })
    .where(eq(surfaceCards.pinnedFromCardId, card.id));
  return cardOut(db, a, card.id);
}

async function copyInto(
  db: DbOrTx,
  a: DriveActor,
  card: CardRow,
  surfaceId: string,
  pinnedFrom: string | null,
) {
  const [row] = await db
    .insert(surfaceCards)
    .values({
      orgId: a.org.id,
      surfaceId,
      type: card.type,
      x: 0,
      y: await bottomOf(db, surfaceId),
      w: card.w,
      h: card.h,
      config: withoutMobile(card.config),
      targetId: card.targetId,
      pinnedFromCardId: pinnedFrom,
      createdBy: a.userId,
    })
    .returning();
  await touch(db, surfaceId, a.userId);
  return cardOut(db, a, row!.id);
}

export async function duplicateCard(db: DbOrTx, a: DriveActor, cardId: string) {
  const { card, access } = await cardAccess(db, a, cardId);
  requireEdit(access);
  return copyInto(db, a, card, card.surfaceId, card.pinnedFromCardId);
}

/**
 * A vault card only stores ids, but they must not reach a shared surface by way of a move or a
 * pin: it goes to the caller's own surface or nowhere.
 */
function assertVaultCardTarget(card: CardRow, target: SurfaceAccess) {
  if (card.type === 'vault_item' && target.surface.ownerType !== 'user') {
    throw new AppError('quick_card_not_movable');
  }
}

/**
 * "Başka space'e taşı" (2.7): the caller edits both surfaces. The card's mobile place and
 * settings belonged to the old surface, so they start over; what it points to is not touched.
 */
export async function moveCard(
  db: DbOrTx,
  a: DriveActor,
  cardId: string,
  input: { surfaceId: string; layout?: z.output<typeof CardLayout> | undefined },
) {
  const { card, access } = await cardAccess(db, a, cardId);
  requireEdit(access);
  const target = await surfaceAccess(db, a, input.surfaceId);
  requireEdit(target);
  if (target.surface.id === card.surfaceId) throw new AppError('invalid_target');
  assertVaultCardTarget(card, target);
  await db
    .update(surfaceCards)
    .set({
      surfaceId: target.surface.id,
      ...(input.layout ?? { x: 0, y: await bottomOf(db, target.surface.id) }),
      mobileOrder: null,
      config: withoutMobile(card.config),
    })
    .where(eq(surfaceCards.id, card.id));
  await touch(db, card.surfaceId, a.userId);
  await touch(db, target.surface.id, a.userId);
  return {
    card: await cardOut(db, a, card.id),
    surfaceIds: [card.surfaceId, target.surface.id],
  };
}

/** Who can open what a card shows (a pin shows its source); null when it points at nothing. */
async function contentAudience(db: DbOrTx, card: CardRow): Promise<Set<string> | null> {
  const [source] = card.pinnedFromCardId
    ? await db.select().from(surfaceCards).where(eq(surfaceCards.id, card.pinnedFromCardId))
    : [];
  const { type, targetId, config } = source ?? card;
  if ((type === 'node' || type === 'page') && targetId) {
    const [node] = await db
      .select()
      .from(nodes)
      .where(and(eq(nodes.id, targetId), isNull(nodes.deletedAt)));
    return node ? new Set((await nodeAudience(db, node)).map((u) => u.id)) : null;
  }
  if (type === 'chat') {
    const conversationId = ChatCardConfig.safeParse(config).data?.conversationId;
    if (!conversationId) return null;
    const rows = await db
      .select({ id: conversationMembers.userId })
      .from(conversationMembers)
      .where(eq(conversationMembers.conversationId, conversationId));
    return new Set(rows.map((r) => r.id));
  }
  if (type === 'board_assigned' || type === 'meeting') {
    const schema = type === 'meeting' ? MeetingCardConfig : BoardAssignedConfig;
    const spaceId = schema.safeParse(config).data?.spaceId;
    if (!spaceId) return null;
    const rows = await db
      .select({ id: spaceMembers.userId })
      .from(spaceMembers)
      .where(eq(spaceMembers.spaceId, spaceId));
    return new Set(rows.map((r) => r.id));
  }
  return null;
}

/** The surfaces a card may move to, and who there cannot open what it points to. */
export async function moveTargets(
  db: DbOrTx,
  a: DriveActor,
  cardId: string,
): Promise<CardMoveTarget[]> {
  const { card, access } = await cardAccess(db, a, cardId);
  requireEdit(access);
  const allowed = (await listSurfaces(db, a)).filter(
    (s) =>
      s.canEdit &&
      s.id !== card.surfaceId &&
      (card.type !== 'vault_item' || s.owner.type === 'user'),
  );
  const audience = await contentAudience(db, card);
  if (!audience) return allowed.map((surface) => ({ surface, cannotOpen: 0 }));
  const spaceIds = allowed.flatMap((s) => (s.owner.type === 'space' ? [s.owner.spaceId] : []));
  const members = spaceIds.length
    ? await db
        .select({ spaceId: spaceMembers.spaceId, userId: spaceMembers.userId })
        .from(spaceMembers)
        .where(inArray(spaceMembers.spaceId, spaceIds))
    : [];
  return allowed.map((surface) => {
    const { owner } = surface;
    const people =
      owner.type === 'space'
        ? members.filter((m) => m.spaceId === owner.spaceId).map((m) => m.userId)
        : [a.userId];
    return { surface, cannotOpen: people.filter((id) => !audience.has(id)).length };
  });
}

/** Tell the people who see these surfaces that their cards changed. */
export async function publishSurfacesChanged(
  deps: { db: DbOrTx; bus?: Bus | null },
  surfaceIds: string[],
) {
  if (!deps.bus) return;
  const rows = await deps.db.select().from(surfaces).where(inArray(surfaces.id, surfaceIds));
  for (const s of rows) {
    const people =
      s.ownerType === 'user'
        ? [s.ownerId]
        : (
            await deps.db
              .select({ id: spaceMembers.userId })
              .from(spaceMembers)
              .where(eq(spaceMembers.spaceId, s.ownerId))
          ).map((m) => m.id);
    publishToUsers(deps.bus, people, { type: 'surface.changed', surfaceId: s.id });
  }
}

/** Pin (2.8): a live link to the source card; viewers of the source may pin it to Benim. */
export async function pinCard(db: DbOrTx, a: DriveActor, cardId: string, targetSurfaceId: string) {
  const { card } = await cardAccess(db, a, cardId);
  const target = await surfaceAccess(db, a, targetSurfaceId);
  requireEdit(target);
  if (target.surface.id === card.surfaceId) throw new AppError('invalid_target');
  assertVaultCardTarget(card, target);
  const source = card.pinnedFromCardId ?? card.id;
  return copyInto(db, a, card, targetSurfaceId, source);
}

async function groupCard(db: DbOrTx, a: DriveActor, cardId: string) {
  const { card, access } = await cardAccess(db, a, cardId);
  const target = card.pinnedFromCardId
    ? await cardAccess(db, a, card.pinnedFromCardId)
    : { card, access };
  requireEdit(target.access);
  if (target.card.type !== 'link_group')
    throw new AppError('bad_request', { reason: 'not_a_link_group' });
  return { shown: card, source: target.card, config: LinkGroupConfig.parse(target.card.config) };
}

export async function addGroupLink(
  db: DbOrTx,
  a: DriveActor,
  cardId: string,
  input: { link: LinkInput; sectionId?: string | undefined },
) {
  const { shown, source, config } = await groupCard(db, a, cardId);
  const section = input.sectionId
    ? config.sections.find((s) => s.id === input.sectionId)
    : config.sections[0];
  if (!section) throw new AppError('not_found');
  const link = await upsertLink(db, a.org.id, input.link);
  section.items.push({
    id: newId(),
    linkId: link.id,
    title: input.link.title ?? link.siteTitle ?? link.host,
    description: input.link.description ?? null,
    ...(input.link.iconUrl ? { iconUrl: input.link.iconUrl } : {}),
  });
  await db
    .update(surfaceCards)
    .set({ config: keepMobile(validateConfig('link_group', config)) })
    .where(eq(surfaceCards.id, source.id));
  await touch(db, source.surfaceId, a.userId);
  return cardOut(db, a, shown.id);
}

export async function removeGroupLink(db: DbOrTx, a: DriveActor, cardId: string, itemId: string) {
  const { shown, source, config } = await groupCard(db, a, cardId);
  let found = false;
  for (const s of config.sections) {
    const before = s.items.length;
    s.items = s.items.filter((i) => i.id !== itemId);
    found ||= s.items.length !== before;
  }
  if (!found) throw new AppError('not_found');
  await db
    .update(surfaceCards)
    .set({ config: keepMobile(config) })
    .where(eq(surfaceCards.id, source.id));
  await touch(db, source.surfaceId, a.userId);
  return cardOut(db, a, shown.id);
}

/** Does the caller see a card with this link on a surface they can edit? (for link settings). */
export async function canEditLink(db: DbOrTx, a: DriveActor, linkId: string) {
  const rows = await db
    .select({ surfaceId: surfaceCards.surfaceId })
    .from(surfaceCards)
    .where(
      and(
        eq(surfaceCards.orgId, a.org.id),
        isNull(surfaceCards.deletedAt),
        sql`jsonb_path_exists(${surfaceCards.config}, '$.**.linkId ? (@ == $id)', jsonb_build_object('id', ${linkId}::text))`,
      ),
    );
  for (const r of rows) {
    const access = await surfaceAccess(db, a, r.surfaceId).catch(() => null);
    if (access?.canEdit) return true;
  }
  return false;
}

export async function canSeeLink(db: DbOrTx, a: DriveActor, linkId: string) {
  const rows = await db
    .select({ surfaceId: surfaceCards.surfaceId })
    .from(surfaceCards)
    .where(
      and(
        eq(surfaceCards.orgId, a.org.id),
        isNull(surfaceCards.deletedAt),
        sql`jsonb_path_exists(${surfaceCards.config}, '$.**.linkId ? (@ == $id)', jsonb_build_object('id', ${linkId}::text))`,
      ),
    );
  for (const r of rows) {
    if (await surfaceAccess(db, a, r.surfaceId).catch(() => null)) return true;
  }
  return false;
}
