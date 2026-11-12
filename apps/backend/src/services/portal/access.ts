import { and, eq, inArray } from 'drizzle-orm';
import { portalSites, users, type DbOrTx } from '@crewhall/db';
import { can, type Actor, type PortalCapabilities, type UserSummary } from '@crewhall/shared';
import { AppError } from '../../http/errors';
import type { OrgRow } from '../../http/types';
import { orgContext } from '../membership';

export type SiteRow = typeof portalSites.$inferSelect;

/** Who is acting on the portal: the org, the person and their org role. */
export interface PortalActor {
  org: OrgRow;
  actor: Actor;
  userId: string;
}

/**
 * Portal rights (doc 17 §5): `portal.edit` / `portal.publish` org permissions, which org
 * admins and owners have implicitly; site settings, tokens and import need an org admin.
 */
export function capabilities(a: PortalActor): PortalCapabilities {
  const org = { type: 'org' as const, org: orgContext(a.org) };
  const manage = a.actor.orgRole === 'owner' || a.actor.orgRole === 'admin';
  return {
    edit: can(a.actor, 'portal.edit', org),
    publish: can(a.actor, 'portal.publish', org),
    manage,
  };
}

export function requireView(a: PortalActor) {
  const c = capabilities(a);
  if (!c.edit && !c.publish && !c.manage) throw new AppError('forbidden', { need: 'portal.edit' });
}
export function requireEdit(a: PortalActor) {
  if (!capabilities(a).edit) throw new AppError('forbidden', { need: 'portal.edit' });
}
export function requirePublish(a: PortalActor) {
  if (!capabilities(a).publish) throw new AppError('forbidden', { need: 'portal.publish' });
}
export function requireManage(a: PortalActor) {
  if (!capabilities(a).manage) throw new AppError('forbidden', { need: 'org.admin' });
}

/** The site, scoped to the caller's org (a foreign id is 404). */
export async function loadSite(db: DbOrTx, a: PortalActor, siteId: string): Promise<SiteRow> {
  const [site] = await db
    .select()
    .from(portalSites)
    .where(and(eq(portalSites.id, siteId), eq(portalSites.orgId, a.org.id)));
  if (!site) throw new AppError('not_found');
  return site;
}

export async function userSummaries(
  db: DbOrTx,
  ids: (string | null | undefined)[],
): Promise<Map<string, UserSummary>> {
  const unique = [...new Set(ids.filter((v): v is string => !!v))];
  if (!unique.length) return new Map();
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email, image: users.image })
    .from(users)
    .where(inArray(users.id, unique));
  return new Map(
    rows.map((u) => [
      u.id,
      { id: u.id, name: u.name, email: u.email, imageUrl: validUrl(u.image) },
    ]),
  );
}

function validUrl(v: string | null): string | null {
  if (!v) return null;
  try {
    new URL(v);
    return v;
  } catch {
    return null;
  }
}

export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
