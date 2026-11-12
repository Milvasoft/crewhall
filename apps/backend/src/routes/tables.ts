import { resolveLocale } from '@crewhall/i18n';
import { TABLES_RAW_PATHS } from '@crewhall/shared';
import { z } from 'zod';
import { AppError } from '../http/errors';
import type { Router } from '../http/route';
import { contentDisposition } from '../storage/s3';
import { tablesEnabled } from '../services/tables/access';
import * as fields from '../services/tables/fields';
import { exportView, importTable } from '../services/tables/io';
import * as rows from '../services/tables/rows';
import * as tables from '../services/tables/tables';
import * as views from '../services/tables/views';
import { rowWritten } from '../services/tables/events';
import { createFormTable } from '../services/tables/forms';
import { driveActor } from './drive';

/** Tables module routes; endpoints come from packages/shared/src/endpoints/tables.ts. */
export function registerTables(r: Router) {
  // ---- tables ----
  r.org('listTables', async (ctx) =>
    tables.listTables(ctx.deps.db, driveActor(ctx), ctx.params.spaceId),
  );
  r.org(
    'createTable',
    async (ctx) =>
      tables.createTable(
        ctx.deps,
        driveActor(ctx),
        ctx.params.spaceId,
        ctx.body,
        resolveLocale(ctx.req.locale),
        ctx.req,
      ),
    { status: 201 },
  );
  r.org(
    'createFormTable',
    async (ctx) =>
      createFormTable(
        ctx.deps,
        driveActor(ctx),
        ctx.params.formId,
        resolveLocale(ctx.req.locale),
        ctx.req,
      ),
    { status: 201 },
  );
  r.org(
    'importTable',
    async (ctx) =>
      importTable(
        ctx.deps,
        driveActor(ctx),
        ctx.params.spaceId,
        ctx.body,
        resolveLocale(ctx.req.locale),
        ctx.req,
      ),
    { status: 201 },
  );
  r.org('getTable', async (ctx) =>
    tables.getTable(ctx.deps.db, driveActor(ctx), ctx.params.tableId),
  );
  r.org('updateTable', async (ctx) =>
    tables.updateTable(ctx.deps, driveActor(ctx), ctx.params.tableId, ctx.body),
  );
  r.org('deleteTable', async (ctx) =>
    tables.deleteTable(ctx.deps, driveActor(ctx), ctx.params.tableId, ctx.req),
  );
  r.org('getTableAttachmentFolder', async (ctx) =>
    tables.attachmentFolder(
      ctx.deps.db,
      driveActor(ctx),
      ctx.params.tableId,
      resolveLocale(ctx.req.locale),
    ),
  );

  // ---- fields ----
  r.org(
    'createTableField',
    async (ctx) => fields.createField(ctx.deps, driveActor(ctx), ctx.params.tableId, ctx.body),
    { status: 201 },
  );
  r.org('updateTableField', async (ctx) =>
    fields.updateField(ctx.deps, driveActor(ctx), ctx.params.tableId, ctx.params.fieldId, ctx.body),
  );
  r.org('deleteTableField', async (ctx) =>
    fields.deleteField(ctx.deps, driveActor(ctx), ctx.params.tableId, ctx.params.fieldId),
  );

  // ---- views ----
  r.org(
    'createTableView',
    async (ctx) => views.createView(ctx.deps, driveActor(ctx), ctx.params.tableId, ctx.body),
    { status: 201 },
  );
  r.org('updateTableView', async (ctx) =>
    views.updateView(ctx.deps, driveActor(ctx), ctx.params.tableId, ctx.params.viewId, ctx.body),
  );
  r.org('deleteTableView', async (ctx) =>
    views.deleteView(ctx.deps, driveActor(ctx), ctx.params.tableId, ctx.params.viewId),
  );

  // ---- rows ----
  r.org('queryTableRows', async (ctx) =>
    rows.queryRows(ctx.deps.db, driveActor(ctx), ctx.params.tableId, ctx.query),
  );
  r.org('getTableRow', async (ctx) =>
    rows.getRow(ctx.deps.db, driveActor(ctx), ctx.params.tableId, ctx.params.rowId),
  );
  r.org(
    'createTableRow',
    async (ctx) => {
      const out = await rows.createRow(ctx.deps, driveActor(ctx), ctx.params.tableId, ctx.body);
      await rowWritten(ctx.deps, driveActor(ctx), out);
      return out.row;
    },
    { status: 201 },
  );
  r.org('updateTableRow', async (ctx) => {
    const out = await rows.updateRow(
      ctx.deps,
      driveActor(ctx),
      ctx.params.tableId,
      ctx.params.rowId,
      ctx.body.values,
    );
    await rowWritten(ctx.deps, driveActor(ctx), out);
    return out.row;
  });
  r.org('moveTableRow', async (ctx) =>
    rows.moveRow(ctx.deps, driveActor(ctx), ctx.params.tableId, ctx.params.rowId, ctx.body),
  );
  r.org('deleteTableRows', async (ctx) =>
    rows.setDeleted(ctx.deps, driveActor(ctx), ctx.params.tableId, ctx.body.rowIds, true),
  );
  r.org('restoreTableRows', async (ctx) =>
    rows.setDeleted(ctx.deps, driveActor(ctx), ctx.params.tableId, ctx.body.rowIds, false),
  );
  r.org('listTableRowComments', async (ctx) =>
    rows.listComments(ctx.deps.db, driveActor(ctx), ctx.params.tableId, ctx.params.rowId),
  );
  r.org(
    'addTableRowComment',
    async (ctx) =>
      rows.addComment(
        ctx.deps,
        driveActor(ctx),
        ctx.params.tableId,
        ctx.params.rowId,
        ctx.body.text,
      ),
    { status: 201 },
  );
  r.org('deleteTableRowComment', async (ctx) =>
    rows.deleteComment(ctx.deps, driveActor(ctx), ctx.params.tableId, ctx.params.commentId),
  );
  r.org('listTableRowHistory', async (ctx) =>
    rows.listHistory(ctx.deps.db, driveActor(ctx), ctx.params.tableId, ctx.params.rowId),
  );

  // ---- export (browser download with the session cookie) ----
  r.rawOrg('GET', TABLES_RAW_PATHS.export, async ({ c, deps, org, actor, user }) => {
    const tableId = c.req.param('tableId') ?? '';
    const viewId = c.req.query('viewId');
    const format = c.req.query('format') === 'xlsx' ? 'xlsx' : 'csv';
    if (!z.uuid().safeParse(tableId).success) throw new AppError('not_found');
    if (viewId !== undefined && !z.uuid().safeParse(viewId).success)
      throw new AppError('not_found');
    if (!(await tablesEnabled(deps.db, org.id)))
      throw new AppError('module_disabled', { module: 'tables' });
    const file = await exportView(
      deps.db,
      { org, actor, userId: user.id },
      tableId,
      viewId,
      format,
    );
    return new Response(new Uint8Array(file.body), {
      headers: {
        'Content-Type': file.mime,
        'Content-Disposition': contentDisposition(file.name),
        'Cache-Control': 'no-store',
      },
    });
  });
}
