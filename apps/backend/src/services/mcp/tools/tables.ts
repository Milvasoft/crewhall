import { cellText } from '@crewhall/shared';
import { z } from 'zod';
import { fieldsOf, loadTable } from '../../tables/access';
import { valuesFromText } from '../../tables/automation';
import { peopleOf, rowPath, rowWritten } from '../../tables/events';
import { createRow, queryRows, updateRow } from '../../tables/rows';
import { listTables } from '../../tables/tables';
import { defineTool, ToolError, type ToolContext } from './types';

/**
 * Tables tools (roadmap › Tablolar): read tables and rows, add and change rows. Values are
 * given as text by field name (or id) and read like an import: choices by label, people by
 * e-mail. At most 20 rows per call, so a write never needs the bulk approval.
 */

const MAX_ROWS = 20;

async function tableFor(ctx: ToolContext, tableId: string, write = false) {
  const access = await loadTable(ctx.deps.db, ctx.a, tableId, write ? 'tables.edit' : 'space.view').catch(
    () => {
      throw new ToolError('not_found', 'Tablo bulunamadı ya da yetkin yok.');
    },
  );
  ctx.assertSpace(access.table.spaceId);
  return access;
}

const Values = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .describe('Field name (or id) → value as text; choices by label, people by e-mail');

const asText = (values: Record<string, string | number | boolean | null>) =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v === null ? '' : String(v)]));

export const listTablesTool = defineTool({
  name: 'list_tables',
  title: 'List tables',
  description: 'Tables of the spaces the person can see, with their fields (name, type, choices).',
  scope: 'hub:read',
  module: 'tables',
  write: false,
  approval: null,
  annotations: { readOnly: true, destructive: false, idempotent: true },
  input: z.object({ space_id: z.uuid().optional().describe('One space; omit for all') }),
  async run(ctx, input) {
    const spaceIds = input.space_id ? [input.space_id] : await ctx.allowedSpaceIds();
    if (input.space_id) ctx.assertSpace(input.space_id);
    const out: Record<string, unknown>[] = [];
    for (const spaceId of spaceIds) {
      const list = await listTables(ctx.deps.db, ctx.a, spaceId).catch(() => null);
      for (const t of list?.items ?? []) {
        const fields = await fieldsOf(ctx.deps.db, t.id);
        out.push({
          table_id: t.id,
          space_id: spaceId,
          name: t.name,
          rows: t.rowCount,
          fields: fields.map((f) => ({
            id: f.id,
            name: f.name,
            type: f.type,
            primary: f.primary,
            ...(f.options.choices ? { choices: f.options.choices.map((c) => c.label) } : {}),
          })),
        });
      }
    }
    return { data: { tables: out }, summary: String(out.length) };
  },
});

export const queryTableRowsTool = defineTool({
  name: 'query_table_rows',
  title: 'Query table rows',
  description:
    'Rows of a table as text by field name; optional search words and a saved view (its filters and sorts).',
  scope: 'hub:read',
  module: 'tables',
  write: false,
  approval: null,
  annotations: { readOnly: true, destructive: false, idempotent: true },
  input: z.object({
    table_id: z.uuid(),
    query: z.string().max(200).optional(),
    view_id: z.uuid().optional(),
    cursor: z.string().max(20).optional(),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  async run(ctx, input) {
    const access = await tableFor(ctx, input.table_id);
    const page = await queryRows(ctx.deps.db, ctx.a, input.table_id, {
      viewId: input.view_id,
      q: input.query,
      cursor: input.cursor,
      limit: input.limit,
    });
    const fields = await fieldsOf(ctx.deps.db, input.table_id);
    const people = await peopleOf(ctx.deps.db, fields, page.items.map((r) => r.values));
    const rows = page.items.map((r) => ({
      row_id: r.id,
      url: rowPath(input.table_id, r.id),
      values: Object.fromEntries(fields.map((f) => [f.name, cellText(f, r.values[f.id] ?? null, people)])),
    }));
    return {
      data: { table: access.table.name, total: page.total, rows, next_cursor: page.nextCursor },
      summary: `${rows.length} / ${page.total}`,
      target: { type: 'table', id: access.table.id, label: access.table.name },
    };
  },
});

export const addTableRows = defineTool({
  name: 'add_table_rows',
  title: 'Add table rows',
  description: `Adds up to ${MAX_ROWS} rows to a table. Fields that are unknown, computed or whose text does not fit are reported in skipped.`,
  scope: 'tables:write',
  module: 'tables',
  write: true,
  approval: null,
  annotations: { readOnly: false, destructive: false, idempotent: false },
  input: z.object({ table_id: z.uuid(), rows: z.array(Values).min(1).max(MAX_ROWS) }),
  example: { table_id: '00000000-0000-0000-0000-000000000000', rows: [{ Şirket: 'Acme', Aşama: 'Aday' }] },
  async run(ctx, input) {
    const access = await tableFor(ctx, input.table_id, true);
    const fields = await fieldsOf(ctx.deps.db, input.table_id);
    const added: { row_id: string; url: string; skipped: string[] }[] = [];
    for (const raw of input.rows) {
      const { values, skipped } = await valuesFromText(ctx.deps.db, access, fields, asText(raw));
      const out = await createRow(ctx.deps, ctx.a, input.table_id, { values });
      await rowWritten(ctx.deps, ctx.a, out);
      added.push({ row_id: out.row.id, url: rowPath(input.table_id, out.row.id), skipped });
    }
    return {
      data: { rows: added },
      summary: `${added.length} satır · ${access.table.name}`,
      target: { type: 'table', id: access.table.id, label: access.table.name },
    };
  },
});

export const updateTableRowTool = defineTool({
  name: 'update_table_row',
  title: 'Update table row',
  description: 'Changes the given fields of one row; other fields stay as they are.',
  scope: 'tables:write',
  module: 'tables',
  write: true,
  approval: null,
  annotations: { readOnly: false, destructive: false, idempotent: true },
  input: z.object({ table_id: z.uuid(), row_id: z.uuid(), values: Values }),
  async run(ctx, input) {
    const access = await tableFor(ctx, input.table_id, true);
    const fields = await fieldsOf(ctx.deps.db, input.table_id);
    const { values, skipped } = await valuesFromText(ctx.deps.db, access, fields, asText(input.values));
    const out = await updateRow(ctx.deps, ctx.a, input.table_id, input.row_id, values);
    await rowWritten(ctx.deps, ctx.a, out);
    return {
      data: { row_id: input.row_id, url: rowPath(input.table_id, input.row_id), changed: out.changedFieldIds.length, skipped },
      summary: `${access.table.name} · ${out.changedFieldIds.length}`,
      target: { type: 'table', id: access.table.id, label: access.table.name },
    };
  },
});
