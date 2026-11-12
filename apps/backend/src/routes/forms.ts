import { resolveLocale } from '@crewhall/i18n';
import { FORMS_RAW_PATHS } from '@crewhall/shared';
import { z } from 'zod';
import { AppError } from '../http/errors';
import type { Router } from '../http/route';
import { contentDisposition } from '../storage/s3';
import { formsEnabled, loadForm, requireForm } from '../services/forms/access';
import { csvOf, exportToDrive } from '../services/forms/deliver';
import * as forms from '../services/forms/forms';
import * as responses from '../services/forms/responses';
import { driveActor } from './drive';

/** Forms module routes (roadmap 16); endpoints come from packages/shared/src/endpoints/forms.ts. */
export function registerForms(r: Router) {
  // ---- building ----
  r.org('listForms', async (ctx) =>
    forms.listForms(ctx.deps.db, driveActor(ctx), ctx.params.spaceId),
  );
  r.org(
    'createForm',
    async (ctx) =>
      forms.createForm(ctx.deps, driveActor(ctx), ctx.params.spaceId, ctx.body, ctx.req),
    { status: 201 },
  );
  r.org('getForm', async (ctx) => forms.getForm(ctx.deps, driveActor(ctx), ctx.params.formId));
  r.org('updateForm', async (ctx) =>
    forms.updateForm(ctx.deps, driveActor(ctx), ctx.params.formId, ctx.body, ctx.req),
  );
  r.org('deleteForm', async (ctx) =>
    forms.deleteForm(ctx.deps, driveActor(ctx), ctx.params.formId, ctx.req),
  );
  r.org('regenerateFormLink', async (ctx) =>
    forms.regenerateLink(ctx.deps, driveActor(ctx), ctx.params.formId, ctx.req),
  );
  r.org('exportFormToDrive', async (ctx) => {
    const a = driveActor(ctx);
    const { form, role } = await loadForm(ctx.deps.db, a, ctx.params.formId);
    requireForm(a, role, 'forms.manage');
    if (!form.settings.destinations.drive) {
      throw new AppError('form_destination_invalid', { destination: 'drive' });
    }
    return exportToDrive(ctx.deps, form, a);
  });

  // ---- results ----
  r.org('listFormResponses', async (ctx) =>
    responses.listResponses(ctx.deps.db, driveActor(ctx), ctx.params.formId, ctx.query),
  );
  r.org('getFormStats', async (ctx) =>
    responses.formStats(ctx.deps.db, driveActor(ctx), ctx.params.formId),
  );
  r.org('deleteFormResponse', async (ctx) =>
    responses.deleteResponse(ctx.deps, driveActor(ctx), ctx.params.responseId, ctx.req),
  );
  r.org('getFormFileUrl', async (ctx) =>
    responses.fileUrl(ctx.deps, driveActor(ctx), ctx.params.fileId),
  );

  // ---- answering ----
  r.org('getFormToFill', async (ctx) =>
    responses.formToFill(ctx.deps, driveActor(ctx), ctx.params.formId),
  );
  r.org(
    'submitForm',
    async (ctx) => responses.submitForm(ctx.deps, driveActor(ctx), ctx.params.formId, ctx.body),
    { status: 201 },
  );
  r.org(
    'uploadFormFile',
    async (ctx) => responses.uploadFile(ctx.deps, driveActor(ctx), ctx.params.formId, ctx.body),
    { status: 201 },
  );
  r.public('getPublicForm', async (ctx) => responses.publicForm(ctx.deps, ctx.params.token));
  r.public(
    'submitPublicForm',
    async (ctx) => responses.submitPublic(ctx.deps, ctx.params.token, ctx.body, ctx.req),
    { status: 201 },
  );
  r.public(
    'uploadPublicFormFile',
    async (ctx) => responses.uploadPublicFile(ctx.deps, ctx.params.token, ctx.body, ctx.req),
    { status: 201 },
  );

  // ---- CSV download (browser link with the session cookie) ----
  r.rawOrg('GET', FORMS_RAW_PATHS.csv, async ({ c, deps, org, actor, user }) => {
    const formId = c.req.param('formId') ?? '';
    if (!z.uuid().safeParse(formId).success) throw new AppError('not_found');
    if (!(await formsEnabled(deps.db, org.id))) {
      throw new AppError('module_disabled', { module: 'forms' });
    }
    const a = { org, actor, userId: user.id };
    const { form } = await responses.loadResults(deps.db, a, formId);
    const csv = await csvOf(deps.db, form, resolveLocale(c.req.header('accept-language') ?? null));
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': contentDisposition(`${form.title.replace(/[\\/]/g, '-')}.csv`),
        'Cache-Control': 'no-store',
      },
    });
  });
}
