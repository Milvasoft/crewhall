import { DESKTOP_RAW_PATHS, DesktopPlatform } from '@crewhall/shared';
import type { Context } from 'hono';
import type { Deps } from '../deps';
import { clientIp } from '../http/client-ip';
import { AppError } from '../http/errors';
import type { Router } from '../http/route';
import type { AppEnv } from '../http/types';
import {
  abortDesktopUpload,
  completeDesktopUpload,
  startDesktopUpload,
  deleteDesktopRelease,
  listDesktopReleases,
  publishDesktopRelease,
  requireReleaseManager,
} from '../services/desktop/admin';
import { updateFileResponse, updateSources } from '../services/desktop/releases';
import { take } from '../services/mcp/rate-limit';

/**
 * Per IP and minute. Whole files and the feed are few (a check every few hours per app); range
 * requests of a differential update come in bursts of one per changed block.
 */
const FULL_PER_MINUTE = 60;
const RANGES_PER_MINUTE = 1200;

/**
 * Desktop app downloads and the electron-updater feed (no session: installers are not secret),
 * from DESKTOP_UPDATES_DIR or the S3 bucket (services/desktop/releases).
 */
export function registerDesktop(r: Router) {
  const handler = async ({ c, deps }: { c: Context<AppEnv>; deps: Deps }) => {
    const sources = updateSources(deps);
    const platform = DesktopPlatform.safeParse(c.req.param('platform'));
    const file = c.req.param('file') ?? '';
    if (!sources.length || !platform.success) throw new AppError('not_found');

    const range = c.req.header('range');
    const ip = clientIp(c);
    if (ip) {
      const limit = await take(deps.db, `ip:${ip}`, {
        kind: range ? 'desktop_update_range' : 'desktop_update',
        perMinute: range ? RANGES_PER_MINUTE : FULL_PER_MINUTE,
      });
      if (!limit.allowed) {
        c.header('Retry-After', String(limit.retryAfter));
        throw new AppError('rate_limited', { retryAfter: limit.retryAfter });
      }
    }

    const res = await updateFileResponse(sources, platform.data, file, {
      range,
      head: c.req.method === 'HEAD',
    });
    if (!res) throw new AppError('not_found');
    return res;
  };
  r.rawPublic('GET', DESKTOP_RAW_PATHS.updateFile, handler);
  r.rawPublic('HEAD', DESKTOP_RAW_PATHS.updateFile, handler);

  // Yönetim › Masaüstü sürümleri (services/desktop/admin).
  const who = (ctx: { org: { id: string }; user: { id: string } }) => ({
    orgId: ctx.org.id,
    userId: ctx.user.id,
  });
  r.org('listDesktopReleases', async (ctx) => {
    await requireReleaseManager(ctx.deps, ctx);
    return listDesktopReleases(ctx.deps);
  });
  r.org('startDesktopUpload', async (ctx) => {
    await requireReleaseManager(ctx.deps, ctx);
    return startDesktopUpload(ctx.deps, who(ctx), ctx.body, ctx.req);
  });
  r.org('completeDesktopUpload', async (ctx) => {
    await requireReleaseManager(ctx.deps, ctx);
    return completeDesktopUpload(ctx.deps, ctx.params.upload, ctx.body);
  });
  r.org('abortDesktopUpload', async (ctx) => {
    await requireReleaseManager(ctx.deps, ctx);
    return abortDesktopUpload(ctx.deps, ctx.params.upload, ctx.query);
  });
  r.org('publishDesktopRelease', async (ctx) => {
    await requireReleaseManager(ctx.deps, ctx);
    return publishDesktopRelease(ctx.deps, who(ctx), ctx.body, ctx.req);
  });
  r.org('deleteDesktopRelease', async (ctx) => {
    await requireReleaseManager(ctx.deps, ctx);
    return deleteDesktopRelease(
      ctx.deps,
      who(ctx),
      { ...ctx.params, blockmaps: ctx.query.blockmaps === 'true' },
      ctx.req,
    );
  });
}
