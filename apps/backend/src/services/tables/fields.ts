import { and, asc, eq, sql } from 'drizzle-orm';
import { dataTables, tableFields, tableRows, tableViews, type DbOrTx } from '@crewhall/db';
import {
  cellText,
  coerceCell,
  CreateTableField,
  formulaRefs,
  isComputed,
  parseFormula,
  TABLE_LIMITS,
  UpdateTableField,
  ViewConfig,
  type ChoiceColor,
  type TableField,
  type TableFieldOptions,
  type TableFieldType,
} from '@crewhall/shared';
import type { z } from 'zod';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import { keyBetween } from '../../util/position';
import type { DriveActor } from '../drive/access';
import { announce, bump, fieldsOf, loadTable, toField, type TableAccess } from './access';

/** Fields of a table: settings checked per type, type changes convert values. */

const PRIMARY_TYPES: readonly TableFieldType[] = [
  'text',
  'number',
  'email',
  'url',
  'phone',
  'date',
  'formula',
];
const COLORS: ChoiceColor[] = [
  'blue',
  'green',
  'yellow',
  'orange',
  'red',
  'pink',
  'purple',
  'teal',
  'gray',
];

/** Keeps the settings a type uses and checks that what they point to exists. */
async function cleanOptions(
  db: DbOrTx,
  access: TableAccess,
  fields: TableField[],
  self: string | null,
  type: TableFieldType,
  o: TableFieldOptions,
): Promise<TableFieldOptions> {
  const bad = (reason: string) => new AppError('table_field_invalid', { reason });
  switch (type) {
    case 'single_select':
    case 'multi_select': {
      const choices = o.choices ?? [];
      if (new Set(choices.map((c) => c.id)).size !== choices.length) throw bad('choice_ids');
      return { choices };
    }
    case 'number':
      return { precision: o.precision ?? 0 };
    case 'currency':
      return { precision: o.precision ?? 2, currency: o.currency ?? 'TRY' };
    case 'date':
      return { includeTime: o.includeTime === true };
    case 'rating':
      return { max: o.max ?? 5 };
    case 'person':
      return { multiple: o.multiple === true };
    case 'relation': {
      if (!o.tableId) throw bad('relation_table');
      const [target] = await db
        .select({ spaceId: dataTables.spaceId })
        .from(dataTables)
        .where(and(eq(dataTables.id, o.tableId), eq(dataTables.orgId, access.table.orgId)));
      // Same space: whoever sees the table sees the rows it links to.
      if (!target || target.spaceId !== access.table.spaceId) throw bad('relation_table');
      return { tableId: o.tableId, multiple: o.multiple !== false };
    }
    case 'lookup':
    case 'rollup': {
      const rel = fields.find((f) => f.id === o.relationFieldId && f.type === 'relation');
      if (!rel || !rel.options.tableId) throw bad('relation_field');
      const targets = await fieldsOf(db, rel.options.tableId);
      if (!targets.some((f) => f.id === o.targetFieldId)) throw bad('target_field');
      return {
        relationFieldId: rel.id,
        targetFieldId: o.targetFieldId,
        ...(type === 'rollup' ? { fn: o.fn ?? 'count', precision: o.precision ?? 0 } : {}),
      };
    }
    case 'formula': {
      const src = (o.formula ?? '').trim();
      try {
        parseFormula(src);
      } catch {
        throw new AppError('table_formula_invalid');
      }
      const known = fields.filter((f) => f.id !== self).map((f) => f.name.toLocaleLowerCase('tr'));
      const missing = formulaRefs(src).filter((r) => !known.includes(r.toLocaleLowerCase('tr')));
      if (missing.length) throw new AppError('table_formula_invalid', { missing });
      return { formula: src, ...(o.precision !== undefined ? { precision: o.precision } : {}) };
    }
    default:
      return {};
  }
}

async function nextPosition(
  db: DbOrTx,
  tableId: string,
  afterId: string | null | undefined,
  self?: string,
) {
  const all = (
    await db
      .select()
      .from(tableFields)
      .where(eq(tableFields.tableId, tableId))
      .orderBy(asc(tableFields.position))
  ).filter((f) => f.id !== self);
  if (afterId === undefined) return keyBetween(all.at(-1)?.position ?? null, null);
  if (afterId === null) return keyBetween(null, all[0]?.position ?? null);
  const i = all.findIndex((f) => f.id === afterId);
  if (i < 0) throw new AppError('table_field_invalid', { reason: 'after' });
  return keyBetween(all[i]!.position, all[i + 1]?.position ?? null);
}

export async function createField(
  deps: Pick<Deps, 'db' | 'bus'>,
  a: DriveActor,
  tableId: string,
  input: z.output<typeof CreateTableField>,
) {
  const { db } = deps;
  let changed = null as { table: TableAccess['table']; rev: number } | null;
  const out = await db.transaction(async (tx) => {
    const access = await loadTable(tx, a, tableId, 'tables.edit', { forUpdate: true });
    const fields = await fieldsOf(tx, tableId);
    if (fields.length >= TABLE_LIMITS.fields)
      throw new AppError('table_limit_reached', { fields: TABLE_LIMITS.fields });
    const options = await cleanOptions(tx, access, fields, null, input.type, input.options);
    const [row] = await tx
      .insert(tableFields)
      .values({
        orgId: a.org.id,
        tableId,
        name: input.name,
        type: input.type,
        options,
        description: input.description ?? null,
        primary: fields.length === 0,
        position: await nextPosition(tx, tableId, input.afterId),
      })
      .returning();
    const rev = await bump(tx, tableId);
    changed = { table: access.table, rev };
    return toField(row!);
  });
  if (changed) await announce(deps, changed.table, changed.rev, null);
  return out;
}

/** Choices made from the distinct texts of a column (text → select conversion). */
function choicesFrom(texts: string[]) {
  const seen = new Map<string, string>();
  for (const t of texts
    .flatMap((x) => x.split(','))
    .map((x) => x.trim())
    .filter(Boolean)) {
    const k = t.toLocaleLowerCase('tr');
    if (!seen.has(k)) seen.set(k, t);
  }
  return [...seen.values()].slice(0, TABLE_LIMITS.choices).map((label, i) => ({
    id: `c${i + 1}_${Math.random().toString(36).slice(2, 7)}`,
    label,
    color: COLORS[i % COLORS.length]!,
  }));
}

export async function updateField(
  deps: Pick<Deps, 'db' | 'bus'>,
  a: DriveActor,
  tableId: string,
  fieldId: string,
  input: z.output<typeof UpdateTableField>,
) {
  const { db } = deps;
  let changed = null as { table: TableAccess['table']; rev: number } | null;
  const out = await db.transaction(async (tx) => {
    const access = await loadTable(tx, a, tableId, 'tables.edit', { forUpdate: true });
    const fields = await fieldsOf(tx, tableId);
    const old = fields.find((f) => f.id === fieldId);
    if (!old) throw new AppError('not_found');
    const type = input.type ?? old.type;
    let rawOptions = input.options ?? (input.type && input.type !== old.type ? {} : old.options);
    const rows =
      type !== old.type
        ? await tx.select().from(tableRows).where(eq(tableRows.tableId, tableId))
        : [];
    if (
      type !== old.type &&
      (type === 'single_select' || type === 'multi_select') &&
      !rawOptions.choices?.length
    ) {
      rawOptions = {
        ...rawOptions,
        choices:
          old.type === 'single_select' || old.type === 'multi_select'
            ? old.options.choices
            : choicesFrom(rows.map((r) => cellText(old, r.values[fieldId] ?? null))),
      };
    }
    const options = await cleanOptions(tx, access, fields, fieldId, type, rawOptions);
    const primary = input.primary === true || old.primary;
    if (primary && !PRIMARY_TYPES.includes(type))
      throw new AppError('table_field_invalid', { reason: 'primary_type' });
    if (input.primary) {
      await tx.update(tableFields).set({ primary: false }).where(eq(tableFields.tableId, tableId));
    }
    const [row] = await tx
      .update(tableFields)
      .set({
        name: input.name ?? old.name,
        type,
        options,
        description: input.description !== undefined ? input.description : old.description,
        primary,
        ...(input.afterId !== undefined
          ? { position: await nextPosition(tx, tableId, input.afterId, fieldId) }
          : {}),
      })
      .where(eq(tableFields.id, fieldId))
      .returning();
    const next = toField(row!);
    if (type !== old.type) {
      // Values go through their text form: "12" → 12, choice label → choice id, else empty.
      for (const r of rows) {
        const before = r.values[fieldId];
        if (before === undefined) continue;
        const values = { ...r.values };
        if (isComputed(type)) delete values[fieldId];
        else {
          const text = cellText(old, before ?? null);
          const source =
            old.type === 'multi_select' || old.type === 'person' || old.type === 'relation'
              ? before
              : text;
          const c = coerceCell(next, (type === 'multi_select' ? text : source) as never);
          values[fieldId] = c.ok ? c.value : null;
        }
        await tx
          .update(tableRows)
          .set({ values, updatedAt: r.updatedAt })
          .where(eq(tableRows.id, r.id));
      }
    }
    const rev = await bump(tx, tableId);
    changed = { table: access.table, rev };
    return next;
  });
  if (changed) await announce(deps, changed.table, changed.rev, null);
  return out;
}

export async function deleteField(
  deps: Pick<Deps, 'db' | 'bus'>,
  a: DriveActor,
  tableId: string,
  fieldId: string,
) {
  const { db } = deps;
  let changed = null as { table: TableAccess['table']; rev: number } | null;
  const out = await db.transaction(async (tx) => {
    const access = await loadTable(tx, a, tableId, 'tables.edit', { forUpdate: true });
    const [field] = await tx
      .select()
      .from(tableFields)
      .where(and(eq(tableFields.id, fieldId), eq(tableFields.tableId, tableId)));
    if (!field) throw new AppError('not_found');
    if (field.primary) throw new AppError('table_primary_field');
    await tx.delete(tableFields).where(eq(tableFields.id, fieldId));
    await tx
      .update(tableRows)
      .set({
        values: sql`${tableRows.values} - ${fieldId}::text`,
        updatedAt: sql`${tableRows.updatedAt}`,
      })
      .where(eq(tableRows.tableId, tableId));
    // Views forget the field.
    const views = await tx.select().from(tableViews).where(eq(tableViews.tableId, tableId));
    for (const v of views) {
      const c = ViewConfig.parse(v.config);
      const drop = (id: string | null) => (id === fieldId ? null : id);
      const config = {
        ...c,
        filters: c.filters.filter((f) => f.fieldId !== fieldId),
        sorts: c.sorts.filter((s) => s.fieldId !== fieldId),
        hidden: c.hidden.filter((id) => id !== fieldId),
        order: c.order.filter((id) => id !== fieldId),
        groupBy: drop(c.groupBy),
        kanbanFieldId: drop(c.kanbanFieldId),
        dateFieldId: drop(c.dateFieldId),
        endDateFieldId: drop(c.endDateFieldId),
        coverFieldId: drop(c.coverFieldId),
      };
      await tx.update(tableViews).set({ config }).where(eq(tableViews.id, v.id));
    }
    const rev = await bump(tx, tableId);
    changed = { table: access.table, rev };
    return {};
  });
  if (changed) await announce(deps, changed.table, changed.rev, null);
  return out;
}
