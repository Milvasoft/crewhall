import { BrandAssetSlot, RAW_PATHS, can } from '@crewhall/shared';
import { AppError } from '../http/errors';
import type { Router } from '../http/route';
import {
  assetFile,
  clearBrandAsset,
  removeAvatar,
  setAvatar,
  setBrandAsset,
} from '../services/assets';
import { audit } from '../services/audit';
import { orgContext } from '../services/membership';

/** Profile photos and brand images (H5). */
export function registerAssets(r: Router) {
  r.user('uploadAvatar', async ({ deps, user, session, body }) =>
    setAvatar(
      deps,
      user,
      (session as { activeOrganizationId?: string | null }).activeOrganizationId ?? null,
      body,
    ),
  );
  r.user('deleteAvatar', async ({ deps, user }) => {
    await removeAvatar(deps, user.id);
    return {};
  });

  r.org('uploadBrandAsset', async ({ deps, org, actor, body, req }) => {
    if (!can(actor, 'org.update_branding', { type: 'org', org: orgContext(org) })) {
      throw new AppError('forbidden');
    }
    const branding = await setBrandAsset(deps, org, actor.userId, body.slot, body);
    await audit(
      deps.db,
      {
        orgId: org.id,
        actorId: actor.userId,
        action: 'org.branding.update',
        targetType: 'org',
        targetId: org.id,
        meta: { asset: body.slot },
      },
      req,
    );
    return branding;
  });
  r.org('deleteBrandAsset', async ({ deps, org, actor, params, req }) => {
    if (!can(actor, 'org.update_branding', { type: 'org', org: orgContext(org) })) {
      throw new AppError('forbidden');
    }
    const slot = BrandAssetSlot.safeParse(params.slot);
    if (!slot.success) throw new AppError('not_found');
    const branding = await clearBrandAsset(deps, org, slot.data);
    await audit(
      deps.db,
      {
        orgId: org.id,
        actorId: actor.userId,
        action: 'org.branding.update',
        targetType: 'org',
        targetId: org.id,
        meta: { asset: slot.data, removed: true },
      },
      req,
    );
    return branding;
  });

  // GET /api/assets/:assetId — no session: the login page and e-mails show these.
  r.rawPublic('GET', RAW_PATHS.asset, async ({ c, deps }) => {
    const id = c.req.param('assetId') ?? '';
    if (!/^[0-9a-f-]{36}$/i.test(id) || !deps.storage) throw new AppError('not_found');
    const row = await assetFile(deps.db, id);
    if (!row) throw new AppError('not_found');
    const stream = await deps.storage.getStream(row.storageKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
    // Ids never change content, so the file can be cached for good.
    c.header('Content-Type', row.mime);
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
    c.header('Content-Disposition', 'inline');
    return c.body(Buffer.concat(chunks));
  });
}
