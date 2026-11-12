import type { Router } from '../http/route';
import type { OrgCtx } from '../http/types';
import { applyTemplate } from '../services/templates/apply';
import * as gallery from '../services/templates/service';
import { localeOf as headerLocale } from '../services/wiki/templates';
import { driveActor } from './drive';

/** The caller's language, else the org default: built-in templates and their content follow it. */
const localeOf = (ctx: Pick<OrgCtx<never>, 'req' | 'user' | 'org'>): 'tr' | 'en' => {
  const userLocale = (ctx.user as { locale?: string | null }).locale;
  if (userLocale === 'tr' || userLocale === 'en') return userLocale;
  return headerLocale(ctx.req.locale, ctx.org.settings.defaultLocale === 'en' ? 'en' : 'tr');
};

/** Built-in ids carry a colon (`builtin:board:sprint`) and arrive URL-encoded. */
const templateIdOf = (raw: string) => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

/** Template gallery (roadmap 8). Endpoints: packages/shared/src/endpoints/templates.ts. */
export function registerTemplates(r: Router) {
  r.org('listTemplates', async (ctx) =>
    gallery.listTemplates(ctx.deps.db, driveActor(ctx), localeOf(ctx), ctx.query),
  );
  r.org(
    'createTemplate',
    async (ctx) => gallery.createTemplate(ctx.deps.db, driveActor(ctx), ctx.body),
    { status: 201 },
  );
  r.org('deleteTemplate', async (ctx) => {
    await gallery.deleteTemplate(
      ctx.deps.db,
      driveActor(ctx),
      templateIdOf(ctx.params.templateRef),
    );
    return {};
  });
  r.org(
    'applyTemplate',
    async (ctx) =>
      applyTemplate(
        ctx.deps,
        driveActor(ctx),
        templateIdOf(ctx.params.templateRef),
        ctx.body,
        localeOf(ctx),
        ctx.req,
      ),
    { status: 201 },
  );
}
