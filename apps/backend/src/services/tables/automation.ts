import { spaceMembers, users, type DbOrTx } from '@crewhall/db';
import { coerceCell, Id, isComputed, type CellValue, type TableField } from '@crewhall/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from '../../http/errors';
import { registerAction, registerTrigger } from '../automations/registry';
import type { DriveActor } from '../drive/access';
import { fieldsOf, loadTable, type TableAccess } from './access';
import { rowPath, rowWritten } from './events';
import { createRow, updateRow } from './rows';

/**
 * Tables in automations (roadmap › Tablolar): "Satır eklendi" / "Satır değişti" triggers and
 * "Satır ekle" / "Satırı güncelle" actions. Action values are `{{…}}` templates per field; the
 * rendered text is read like an imported cell (choices by label, people by e-mail or name), and
 * values that do not fit are skipped instead of failing the run.
 */

const optionalId = Id.nullable().default(null);
const Values = z.record(z.string(), z.string().max(4000)).default({});

const key = (s: string) => s.trim().toLocaleLowerCase('tr');

/** The field a key names: its id or (from forms and imports) its name. */
export const fieldFor = (fields: TableField[], k: string) =>
  fields.find((f) => f.id === k) ?? fields.find((f) => key(f.name) === key(k));

/**
 * Text per field (id or name) → stored cell values. People are matched by e-mail or name among
 * the space members; relations need row ids. Returns the names of fields whose text did not fit.
 */
export async function valuesFromText(
  db: DbOrTx,
  access: TableAccess,
  fields: TableField[],
  input: Record<string, string | null | undefined>,
) {
  const values: Record<string, CellValue> = {};
  const skipped: string[] = [];
  let members: { id: string; name: string; email: string }[] | null = null;
  for (const [k, raw] of Object.entries(input)) {
    const f = fieldFor(fields, k);
    if (!f || isComputed(f.type) || f.type === 'attachment') continue;
    const text = (raw ?? '').trim();
    let cell: CellValue = text;
    if (f.type === 'person' && text) {
      members ??= await db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(spaceMembers)
        .innerJoin(users, eq(users.id, spaceMembers.userId))
        .where(eq(spaceMembers.spaceId, access.space.id));
      const ids = text
        .split(/[,;\n]/)
        .map((t) => key(t))
        .filter(Boolean)
        .map((t) => members!.find((m) => m.id === t || key(m.email) === t || key(m.name) === t)?.id);
      if (ids.some((x) => !x)) {
        skipped.push(f.name);
        continue;
      }
      cell = ids as string[];
    } else if (f.type === 'relation' && text) {
      cell = text
        .split(/[,;\s]+/)
        .map((t) => t.trim())
        .filter((t) => Id.safeParse(t).success);
    }
    const r = coerceCell(f, cell);
    if (r.ok) values[f.id] = r.value;
    else skipped.push(f.name);
  }
  return { values, skipped };
}

async function editableTable(db: DbOrTx, a: DriveActor, spaceId: string, tableId: string) {
  const access = await loadTable(db, a, tableId, 'tables.edit').catch(() => {
    throw new AppError('automation_target_invalid', { field: 'tableId' });
  });
  if (access.table.spaceId !== spaceId) throw new AppError('automation_target_invalid', { field: 'tableId' });
  return access;
}

async function checkValueKeys(db: DbOrTx, tableId: string, values: Record<string, string>) {
  const fields = await fieldsOf(db, tableId);
  for (const id of Object.keys(values)) {
    const f = fields.find((x) => x.id === id);
    if (!f || isComputed(f.type)) throw new AppError('automation_target_invalid', { field: 'values' });
  }
}

/* --------------------------------- triggers --------------------------------- */

const ROW_VARIABLES = ['table.name', 'row.id', 'row.title', 'row.url', 'values', 'actor.name'];

const sampleRow = () => ({
  table: { id: null, name: 'Örnek tablo' },
  row: { id: null, title: 'Örnek satır', url: '/' },
  values: { _text: 'Ad: Örnek satır' },
  before: null,
  changed: [],
  actor: { id: null, name: 'Crewhall' },
});

registerTrigger({
  type: 'tables.row_created',
  module: 'tables',
  config: z.object({ tableId: Id }),
  fields: [{ key: 'tableId', kind: 'table', required: true, options: [], dependsOn: null }],
  variables: ROW_VARIABLES,
  async validate(db, a, spaceId, c) {
    const access = await loadTable(db, a, c.tableId).catch(() => {
      throw new AppError('automation_target_invalid', { field: 'tableId' });
    });
    if (access.table.spaceId !== spaceId) throw new AppError('automation_target_invalid', { field: 'tableId' });
  },
  matches: (c, e) => e.match?.tableId === c.tableId,
  sample: sampleRow,
});

registerTrigger({
  type: 'tables.row_updated',
  module: 'tables',
  config: z.object({ tableId: Id, fieldId: optionalId }),
  fields: [
    { key: 'tableId', kind: 'table', required: true, options: [], dependsOn: null },
    { key: 'fieldId', kind: 'table_field', required: false, options: [], dependsOn: 'tableId' },
  ],
  variables: [...ROW_VARIABLES, 'before', 'changed'],
  async validate(db, a, spaceId, c) {
    const access = await loadTable(db, a, c.tableId).catch(() => {
      throw new AppError('automation_target_invalid', { field: 'tableId' });
    });
    if (access.table.spaceId !== spaceId) throw new AppError('automation_target_invalid', { field: 'tableId' });
    if (c.fieldId && !(await fieldsOf(db, c.tableId)).some((f) => f.id === c.fieldId)) {
      throw new AppError('automation_target_invalid', { field: 'fieldId' });
    }
  },
  matches: (c, e) => {
    if (e.match?.tableId !== c.tableId) return false;
    const changed = Array.isArray(e.match.changedFieldIds) ? (e.match.changedFieldIds as string[]) : [];
    return !c.fieldId || changed.includes(c.fieldId);
  },
  sample: sampleRow,
});

/* ---------------------------------- actions ---------------------------------- */

registerAction({
  type: 'tables.create_row',
  module: 'tables',
  config: z.object({ tableId: Id, values: Values }),
  fields: [
    { key: 'tableId', kind: 'table', required: true, options: [], dependsOn: null },
    { key: 'values', kind: 'table_values', required: false, options: [], dependsOn: 'tableId' },
  ],
  async validate(db, a, spaceId, c) {
    await editableTable(db, a, spaceId, c.tableId);
    await checkValueKeys(db, c.tableId, c.values);
  },
  async run(ctx, c) {
    const { db } = ctx.deps;
    const access = await loadTable(db, ctx.actor, c.tableId, 'tables.edit');
    const fields = await fieldsOf(db, c.tableId);
    const rendered = Object.fromEntries(Object.entries(c.values).map(([k, v]) => [k, ctx.render(v)]));
    const { values, skipped } = await valuesFromText(db, access, fields, rendered);
    const out = await createRow(ctx.deps, ctx.actor, c.tableId, { values });
    await rowWritten(ctx.deps, ctx.actor, out);
    return { rowId: out.row.id, url: rowPath(c.tableId, out.row.id), skipped: skipped.join(', ') };
  },
});

registerAction({
  type: 'tables.update_row',
  module: 'tables',
  config: z.object({ tableId: Id, rowId: z.string().trim().min(1).max(200), values: Values }),
  fields: [
    { key: 'tableId', kind: 'table', required: true, options: [], dependsOn: null },
    { key: 'rowId', kind: 'template', required: true, options: [], dependsOn: null },
    { key: 'values', kind: 'table_values', required: false, options: [], dependsOn: 'tableId' },
  ],
  async validate(db, a, spaceId, c) {
    await editableTable(db, a, spaceId, c.tableId);
    await checkValueKeys(db, c.tableId, c.values);
  },
  async run(ctx, c) {
    const { db } = ctx.deps;
    const rowId = ctx.render(c.rowId).trim();
    if (!Id.safeParse(rowId).success) throw new AppError('not_found');
    const access = await loadTable(db, ctx.actor, c.tableId, 'tables.edit');
    const fields = await fieldsOf(db, c.tableId);
    const rendered = Object.fromEntries(Object.entries(c.values).map(([k, v]) => [k, ctx.render(v)]));
    const { values, skipped } = await valuesFromText(db, access, fields, rendered);
    const out = await updateRow(ctx.deps, ctx.actor, c.tableId, rowId, values);
    await rowWritten(ctx.deps, ctx.actor, out);
    return { rowId, url: rowPath(c.tableId, rowId), changed: out.changedFieldIds.length, skipped: skipped.join(', ') };
  },
});

