import { and, eq } from 'drizzle-orm';
import { newId, surfaceCards } from '@crewhall/db';
import type { Card, Surface } from '@crewhall/shared';
import { z } from 'zod';
import * as quick from '../../quick/surfaces';
import { defineTool, ToolError, type ToolContext } from './types';

/** The space a surface belongs to; the person's own "Benim" counts as the personal space. */
export async function surfaceSpaceId(ctx: ToolContext, surface: Pick<Surface, 'owner'>) {
  return surface.owner.type === 'space' ? surface.owner.spaceId : await ctx.personalSpaceId();
}

async function pickSurface(ctx: ToolContext, surfaceId: string | undefined) {
  const list = await quick.listSurfaces(ctx.deps.db, ctx.a);
  const summary = surfaceId ? list.find((s) => s.id === surfaceId) : list[0];
  if (!summary) throw new ToolError('not_found', 'Hızlı erişim yüzeyi bulunamadı.');
  const spaceId = await surfaceSpaceId(ctx, summary);
  if (spaceId) ctx.assertSpace(spaceId);
  return summary;
}

const surfaceName = (s: { owner: Surface['owner'] }) =>
  s.owner.type === 'space' ? s.owner.spaceName : 'Benim';

interface LinkRowOut {
  surface_id: string;
  surface: string;
  card_id: string;
  item_id: string;
  group: string | null;
  section: string | null;
  title: string;
  url: string;
  status: string;
}

function linksOf(surface: Surface): LinkRowOut[] {
  const out: LinkRowOut[] = [];
  const name = surfaceName(surface);
  for (const card of surface.cards as Card[]) {
    if (card.type === 'link') {
      const link = card.links[card.config.item.linkId];
      if (!link) continue;
      out.push({
        surface_id: surface.id,
        surface: name,
        card_id: card.id,
        item_id: card.config.item.id,
        group: null,
        section: null,
        title: card.config.item.title,
        url: link.url,
        status: link.health.status,
      });
    } else if (card.type === 'link_group') {
      for (const section of card.config.sections) {
        for (const item of section.items) {
          const link = card.links[item.linkId];
          if (!link) continue;
          out.push({
            surface_id: surface.id,
            surface: name,
            card_id: card.id,
            item_id: item.id,
            group: card.config.title,
            section: section.title || null,
            title: item.title,
            url: link.url,
            status: link.health.status,
          });
        }
      }
    }
  }
  return out;
}

export const listLinks = defineTool({
  name: 'list_links',
  title: 'List quick access links',
  description:
    'Links on the quick access surfaces ("Benim" and space surfaces) with their health. Link groups list every item with its card_id for add_link.',
  scope: 'hub:read',
  write: false,
  approval: null,
  annotations: { readOnly: true, destructive: false, idempotent: true },
  input: z.object({
    surface_id: z.uuid().optional().describe('One surface; omit for all'),
    cursor: z.string().max(20).optional(),
    limit: z.number().int().min(1).max(200).default(100),
  }),
  async run(ctx, input) {
    const list = await quick.listSurfaces(ctx.deps.db, ctx.a);
    const chosen = input.surface_id ? list.filter((s) => s.id === input.surface_id) : list;
    if (input.surface_id && chosen.length === 0) {
      throw new ToolError('not_found', 'Hızlı erişim yüzeyi bulunamadı.');
    }
    const rows: LinkRowOut[] = [];
    const surfaces: { id: string; name: string; can_edit: boolean }[] = [];
    for (const s of chosen) {
      const spaceId = await surfaceSpaceId(ctx, s);
      if (ctx.spaceIds !== null && (!spaceId || !ctx.spaceIds.includes(spaceId))) continue;
      const full = await quick.getSurface(ctx.deps.db, ctx.a, s.id);
      surfaces.push({ id: s.id, name: surfaceName(s), can_edit: s.canEdit });
      rows.push(...linksOf(full));
    }
    const offset = Number(input.cursor ?? 0) || 0;
    const items = rows.slice(offset, offset + input.limit);
    const next = offset + input.limit < rows.length ? String(offset + input.limit) : null;
    return { data: { surfaces, items, next_cursor: next }, summary: String(rows.length) };
  },
});

export const addLink = defineTool({
  name: 'add_link',
  title: 'Add link',
  description:
    'Adds a link to quick access: as its own card on a surface (default: the person\'s "Benim"), or into a link group with group_card_id. A health check is scheduled for the link.',
  scope: 'quick:write',
  write: true,
  approval: null,
  annotations: { readOnly: false, destructive: false, idempotent: false },
  input: z.object({
    url: z.url().max(2048),
    title: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(200).optional(),
    surface_id: z.uuid().optional(),
    group_card_id: z.uuid().optional().describe('Link group card from list_links'),
    section_id: z.uuid().optional(),
  }),
  example: { url: 'https://status.example.com', title: 'Status' },
  async run(ctx, input) {
    const link = {
      url: input.url,
      title: input.title,
      description: input.description,
      checkEnabled: true,
      intervalSeconds: 60 as const,
    };
    if (input.group_card_id) {
      const [row] = await ctx.deps.db
        .select({ surfaceId: surfaceCards.surfaceId })
        .from(surfaceCards)
        .where(and(eq(surfaceCards.id, input.group_card_id), eq(surfaceCards.orgId, ctx.a.org.id)));
      if (!row) throw new ToolError('not_found', 'Link grubu bulunamadı.');
      await pickSurface(ctx, row.surfaceId);
      const card = await ctx.deps.db.transaction((tx) =>
        quick.addGroupLink(tx, ctx.a, input.group_card_id!, {
          link,
          sectionId: input.section_id,
        }),
      );
      if (card.type !== 'link_group')
        throw new ToolError('bad_request', 'Bu kart bir link grubu değil.');
      const section = input.section_id
        ? card.config.sections.find((s) => s.id === input.section_id)
        : card.config.sections[0];
      const item = section?.items[section.items.length - 1];
      return {
        data: { card_id: card.id, item_id: item?.id ?? null, group: card.config.title },
        target: {
          type: 'card',
          id: card.id,
          label: `${card.config.title} · ${item?.title ?? input.url}`,
        },
        summary: `${card.config.title} · ${item?.title ?? input.url}`,
        undo: item
          ? {
              kind: 'remove_group_link',
              cardId: card.id,
              itemId: item.id,
              revs: { [card.id]: card.updatedAt },
            }
          : undefined,
      };
    }
    const surface = await pickSurface(ctx, input.surface_id);
    const card = await ctx.deps.db.transaction((tx) =>
      quick.createCard(tx, ctx.a, surface.id, { type: 'link', link }, ctx.req.locale),
    );
    const title = card.type === 'link' ? card.config.item.title : input.url;
    return {
      data: { card_id: card.id, surface_id: surface.id, title },
      target: { type: 'card', id: card.id, label: `${surfaceName(surface)} · ${title}` },
      summary: `${surfaceName(surface)} · ${title}`,
      undo: { kind: 'delete_card', cardId: card.id, revs: { [card.id]: card.updatedAt } },
    };
  },
});

export const addQuickCard = defineTool({
  name: 'add_quick_card',
  title: 'Add quick access card',
  description:
    'Adds a note (Markdown) or a to-do list card to a quick access surface (default: "Benim").',
  scope: 'quick:write',
  write: true,
  approval: null,
  annotations: { readOnly: false, destructive: false, idempotent: false },
  input: z.object({
    type: z.enum(['note', 'todo']),
    title: z.string().trim().min(1).max(60).optional().describe('To-do list title'),
    text: z.string().max(20_000).optional().describe('Note text, Markdown'),
    items: z.array(z.string().trim().min(1).max(300)).max(200).optional().describe('To-do items'),
    surface_id: z.uuid().optional(),
  }),
  example: { type: 'todo', title: 'Sürüm 1.5', items: ['Sürüm notları', 'Blog duyurusu'] },
  async run(ctx, input) {
    const surface = await pickSurface(ctx, input.surface_id);
    const create =
      input.type === 'note'
        ? { type: 'note' as const, config: { text: input.text ?? '' } }
        : {
            type: 'todo' as const,
            config: {
              title: input.title ?? 'Yapılacaklar',
              items: (input.items ?? []).map((text) => ({
                id: newId(),
                text,
                done: false,
                doneAt: null,
              })),
            },
          };
    const card = await ctx.deps.db.transaction((tx) =>
      quick.createCard(tx, ctx.a, surface.id, create, ctx.req.locale),
    );
    const label = input.type === 'todo' ? (input.title ?? 'Yapılacaklar') : 'Not';
    return {
      data: { card_id: card.id, surface_id: surface.id, type: input.type },
      target: { type: 'card', id: card.id, label: `${surfaceName(surface)} · ${label}` },
      summary: `${surfaceName(surface)} · ${label}`,
      undo: { kind: 'delete_card', cardId: card.id, revs: { [card.id]: card.updatedAt } },
    };
  },
});
