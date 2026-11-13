import { linkOpens } from '@crewhall/db';
import { AppError } from '../http/errors';
import type { Router } from '../http/route';
import { onLinkStatusChange } from '../services/notifications/link-events';
import { checkUrl, recordCheck } from '../services/quick/link-check';
import * as links from '../services/quick/links';
import * as surfaces from '../services/quick/surfaces';
import { take } from '../services/mcp/rate-limit';
import { driveActor } from './drive';

/** resolveLink per person and minute. */
const RESOLVES_PER_MINUTE = 30;

export function registerQuick(r: Router) {
  r.org('listSurfaces', async (ctx) => ({
    items: await surfaces.listSurfaces(ctx.deps.db, driveActor(ctx)),
  }));
  r.org('getSurface', async (ctx) =>
    surfaces.getSurface(ctx.deps.db, driveActor(ctx), ctx.params.surfaceId),
  );
  r.org('updateSurfaceLayout', async (ctx) =>
    ctx.deps.db.transaction((tx) =>
      surfaces.updateLayout(tx, driveActor(ctx), ctx.params.surfaceId, ctx.body),
    ),
  );
  r.org(
    'createCard',
    async (ctx) => {
      links.assertIconUrls(ctx.deps.env.HUB_URL, ctx.body);
      return surfaces.createCard(
        ctx.deps.db,
        driveActor(ctx),
        ctx.params.surfaceId,
        ctx.body,
        ctx.req.locale,
      );
    },
    { status: 201 },
  );
  r.org('updateCard', async (ctx) => {
    links.assertIconUrls(ctx.deps.env.HUB_URL, ctx.body);
    return surfaces.updateCard(ctx.deps.db, driveActor(ctx), ctx.params.cardId, ctx.body);
  });
  r.org('deleteCard', async (ctx) => {
    await surfaces.deleteCard(ctx.deps.db, driveActor(ctx), ctx.params.cardId);
    return {};
  });
  r.org('restoreCard', async (ctx) =>
    surfaces.restoreCard(ctx.deps.db, driveActor(ctx), ctx.params.cardId),
  );
  r.org(
    'duplicateCard',
    async (ctx) => surfaces.duplicateCard(ctx.deps.db, driveActor(ctx), ctx.params.cardId),
    { status: 201 },
  );
  r.org('listCardMoveTargets', async (ctx) => ({
    items: await surfaces.moveTargets(ctx.deps.db, driveActor(ctx), ctx.params.cardId),
  }));
  r.org('moveCard', async (ctx) => {
    const { card, surfaceIds } = await ctx.deps.db.transaction((tx) =>
      surfaces.moveCard(tx, driveActor(ctx), ctx.params.cardId, ctx.body),
    );
    // A lost event only delays the other screens: they refetch surfaces every minute anyway.
    await surfaces
      .publishSurfacesChanged(ctx.deps, surfaceIds)
      .catch((err: unknown) => ctx.deps.logger.warn({ err }, 'surface event failed'));
    return card;
  });
  r.org(
    'pinCard',
    async (ctx) =>
      surfaces.pinCard(ctx.deps.db, driveActor(ctx), ctx.params.cardId, ctx.body.surfaceId),
    { status: 201 },
  );
  r.org('addGroupLink', async (ctx) => {
    links.assertIconUrls(ctx.deps.env.HUB_URL, ctx.body);
    return surfaces.addGroupLink(ctx.deps.db, driveActor(ctx), ctx.params.cardId, ctx.body);
  });

  // A link card changing its address: the org-wide Link for the new URL (2.4 resolution).
  r.org('resolveLink', async (ctx) => {
    const a = driveActor(ctx);
    if (ctx.body.cardId) await surfaces.requireCardEdit(ctx.deps.db, a, ctx.body.cardId);
    else if (a.actor.orgRole === 'guest') throw new AppError('forbidden');
    // Each new URL fetches the site once; keep that from becoming a crawler.
    const limit = await take(
      ctx.deps.db,
      `user:${ctx.user.id}`,
      { kind: 'link_resolve', perMinute: RESOLVES_PER_MINUTE },
      ctx.org.id,
    );
    if (!limit.allowed) {
      ctx.c.header('Retry-After', String(limit.retryAfter));
      throw new AppError('rate_limited', { retryAfter: limit.retryAfter });
    }
    const row = await links.upsertLink(ctx.deps.db, ctx.org.id, {
      url: ctx.body.url,
      checkEnabled: ctx.body.checkEnabled ?? true,
      intervalSeconds: ctx.body.intervalSeconds ?? 60,
    });
    return (await links.linksByIds(ctx.deps.db, ctx.org.id, [row.id])).get(row.id)!;
  });
  r.org('removeGroupLink', async (ctx) =>
    surfaces.removeGroupLink(ctx.deps.db, driveActor(ctx), ctx.params.cardId, ctx.params.itemId),
  );

  r.org('previewLink', async (ctx) => {
    let url: string;
    try {
      url = new URL(ctx.body.url).href;
    } catch {
      throw new AppError('validation_failed', {
        in: 'body',
        issues: [{ path: ['url'], code: 'invalid_url', message: 'invalid URL' }],
      });
    }
    const meta = await links.fetchSiteMeta(url);
    const existing = await links.existingCardIds(ctx.deps.db, driveActor(ctx), url);
    return {
      url,
      host: new URL(url).host,
      title: meta.title,
      faviconUrl: meta.faviconUrl,
      description: meta.description,
      imageUrl: meta.imageUrl,
      existingCardIds: existing,
    };
  });
  r.org('getLink', async (ctx) => {
    const a = driveActor(ctx);
    if (!(await surfaces.canSeeLink(ctx.deps.db, a, ctx.params.linkId)))
      throw new AppError('not_found');
    const map = await links.linksByIds(ctx.deps.db, ctx.org.id, [ctx.params.linkId]);
    const link = map.get(ctx.params.linkId);
    if (!link) throw new AppError('not_found');
    return link;
  });
  r.org('updateLink', async (ctx) => {
    const a = driveActor(ctx);
    if (!(await surfaces.canEditLink(ctx.deps.db, a, ctx.params.linkId)))
      throw new AppError('forbidden');
    await links.updateLinkSettings(ctx.deps.db, ctx.org.id, ctx.params.linkId, ctx.body);
    return (await links.linksByIds(ctx.deps.db, ctx.org.id, [ctx.params.linkId])).get(
      ctx.params.linkId,
    )!;
  });
  r.org('getLinkHistory', async (ctx) => {
    if (!(await surfaces.canSeeLink(ctx.deps.db, driveActor(ctx), ctx.params.linkId))) {
      throw new AppError('not_found');
    }
    return links.linkHistory(ctx.deps.db, ctx.params.linkId, ctx.query.hours);
  });
  r.org('checkLinkNow', async (ctx) => {
    if (!(await surfaces.canSeeLink(ctx.deps.db, driveActor(ctx), ctx.params.linkId))) {
      throw new AppError('not_found');
    }
    const row = await links.linkRow(ctx.deps.db, ctx.org.id, ctx.params.linkId);
    const updated = await recordCheck(ctx.deps.db, row, await checkUrl(row.url));
    if (updated.status !== row.status) {
      await onLinkStatusChange(ctx.deps, row, updated).catch((err: unknown) =>
        ctx.deps.logger.warn({ err }, 'link status event failed'),
      );
    }
    const opens = await links.opensFor(ctx.deps.db, [row.id]);
    return links.toLink(updated, opens.get(row.id) ?? 0);
  });
  r.org('recordLinkOpen', async (ctx) => {
    const row = await links.linkRow(ctx.deps.db, ctx.org.id, ctx.params.linkId);
    await ctx.deps.db
      .insert(linkOpens)
      .values({ orgId: ctx.org.id, linkId: row.id, userId: ctx.user.id });
    return {};
  });
}
