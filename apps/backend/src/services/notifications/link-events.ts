import { and, eq, inArray, sql } from 'drizzle-orm';
import { spaceMembers, surfaceCards, surfaces, type Db } from '@crewhall/db';
import { publishLinkStatus } from '../../realtime/events';
import { toLinkHealth, type LinkRow } from '../quick/link-check';
import { notify, type NotifyDeps } from './notify';

/**
 * A checked link changed status (doc 17 §10): everyone seeing a card with it gets a
 * `link.status` event; going down and coming back notify the card's owner and the
 * space's owners and admins.
 */
export async function onLinkStatusChange(
  deps: NotifyDeps & { db: Db },
  before: LinkRow,
  after: LinkRow,
) {
  const { db } = deps;
  const cards = await db
    .select({
      ownerType: surfaces.ownerType,
      ownerId: surfaces.ownerId,
      createdBy: surfaceCards.createdBy,
      cardId: surfaceCards.id,
    })
    .from(surfaceCards)
    .innerJoin(surfaces, eq(surfaces.id, surfaceCards.surfaceId))
    .where(
      and(
        eq(surfaceCards.orgId, after.orgId),
        sql`${surfaceCards.deletedAt} is null`,
        sql`jsonb_path_exists(${surfaceCards.config}, '$.**.linkId ? (@ == $id)', jsonb_build_object('id', ${after.id}::text))`,
      ),
    );
  if (cards.length === 0) return;
  const spaceIds = [...new Set(cards.filter((c) => c.ownerType === 'space').map((c) => c.ownerId))];
  const members = spaceIds.length
    ? await db
        .select({
          spaceId: spaceMembers.spaceId,
          userId: spaceMembers.userId,
          role: spaceMembers.role,
        })
        .from(spaceMembers)
        .where(inArray(spaceMembers.spaceId, spaceIds))
    : [];
  const viewers = new Set<string>();
  const owners = new Set<string>();
  for (const c of cards) {
    if (c.ownerType === 'user') {
      viewers.add(c.ownerId);
      owners.add(c.ownerId);
    } else {
      if (c.createdBy) owners.add(c.createdBy);
    }
  }
  for (const m of members) {
    viewers.add(m.userId);
    if (m.role === 'owner' || m.role === 'admin') owners.add(m.userId);
  }
  publishLinkStatus(deps.bus, [...viewers], after.id, toLinkHealth(after));

  const wentDown = after.status === 'down' && before.status !== 'down';
  const cameBack = before.status === 'down' && after.status !== 'down';
  if (!wentDown && !cameBack) return;
  const name = after.siteTitle ?? after.host;
  await notify(
    deps,
    [...owners]
      .filter((id) => viewers.has(id))
      .map((userId) => ({
        orgId: after.orgId,
        userId,
        type: wentDown ? 'link.down' : 'link.up',
        category: 'links' as const,
        actorId: null,
        target: { type: 'link' as const, id: after.id },
        data: { name, host: after.host, reason: after.lastReason, url: after.url },
        url: `/?link=${after.id}`,
        groupKey: `link:${after.id}`,
      })),
  );
}
