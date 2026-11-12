import { asc, count, eq } from 'drizzle-orm';
import { tableViews } from '@crewhall/db';
import {
  CreateTableView,
  TABLE_LIMITS,
  UpdateTableView,
  ViewConfig,
  type TableField,
  type TableViewType,
} from '@crewhall/shared';
import type { z } from 'zod';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import { keyBetween } from '../../util/position';
import type { DriveActor } from '../drive/access';
import { announce, bump, fieldsOf, loadTable, toView } from './access';

/** Views of a table: each keeps its own filter, sort, grouping, hidden fields and layout fields. */

/** Starting layout fields for a new kanban, calendar, timeline or gallery view. */
function defaults(type: TableViewType, fields: TableField[]) {
  const first = (t: TableField['type']) => fields.find((f) => f.type === t)?.id ?? null;
  const dates = fields.filter((f) => f.type === 'date');
  return {
    kanbanFieldId: type === 'kanban' ? first('single_select') : null,
    dateFieldId: type === 'calendar' || type === 'timeline' ? (dates[0]?.id ?? null) : null,
    endDateFieldId: type === 'timeline' ? (dates[1]?.id ?? null) : null,
    coverFieldId: type === 'gallery' || type === 'kanban' ? first('attachment') : null,
  };
}

/** Drops references to fields that do not exist. */
function clean(config: z.output<typeof ViewConfig>, fields: TableField[]) {
  const ids = new Set(fields.map((f) => f.id));
  const keep = (id: string | null) => (id && ids.has(id) ? id : null);
  return {
    ...config,
    filters: config.filters.filter((f) => ids.has(f.fieldId)),
    sorts: config.sorts.filter((s) => ids.has(s.fieldId)),
    hidden: config.hidden.filter((id) => ids.has(id)),
    order: config.order.filter((id) => ids.has(id)),
    groupBy: keep(config.groupBy),
    kanbanFieldId: keep(config.kanbanFieldId),
    dateFieldId: keep(config.dateFieldId),
    endDateFieldId: keep(config.endDateFieldId),
    coverFieldId: keep(config.coverFieldId),
  };
}

export async function createView(
  deps: Pick<Deps, 'db' | 'bus'>,
  a: DriveActor,
  tableId: string,
  input: z.output<typeof CreateTableView>,
) {
  const { db } = deps;
  const access = await loadTable(db, a, tableId, 'tables.edit');
  const [{ n } = { n: 0 }] = await db
    .select({ n: count() })
    .from(tableViews)
    .where(eq(tableViews.tableId, tableId));
  if (Number(n) >= TABLE_LIMITS.views)
    throw new AppError('table_limit_reached', { views: TABLE_LIMITS.views });
  const fields = await fieldsOf(db, tableId);
  const last = (
    await db
      .select()
      .from(tableViews)
      .where(eq(tableViews.tableId, tableId))
      .orderBy(asc(tableViews.position))
  ).at(-1);
  const config = clean(
    ViewConfig.parse({ ...defaults(input.type, fields), ...input.config }),
    fields,
  );
  const [row] = await db
    .insert(tableViews)
    .values({
      orgId: a.org.id,
      tableId,
      name: input.name,
      type: input.type,
      config,
      position: keyBetween(last?.position ?? null, null),
      createdBy: a.userId,
    })
    .returning();
  await announce(deps, access.table, await bump(db, tableId), null);
  return toView(row!);
}

export async function updateView(
  deps: Pick<Deps, 'db' | 'bus'>,
  a: DriveActor,
  tableId: string,
  viewId: string,
  input: z.output<typeof UpdateTableView>,
) {
  const { db } = deps;
  const access = await loadTable(db, a, tableId, 'tables.edit');
  const views = await db
    .select()
    .from(tableViews)
    .where(eq(tableViews.tableId, tableId))
    .orderBy(asc(tableViews.position));
  const view = views.find((v) => v.id === viewId);
  if (!view) throw new AppError('not_found');
  const fields = await fieldsOf(db, tableId);
  let position = view.position;
  if (input.afterId !== undefined) {
    const others = views.filter((v) => v.id !== viewId);
    const i = input.afterId === null ? -1 : others.findIndex((v) => v.id === input.afterId);
    position = keyBetween(i < 0 ? null : others[i]!.position, others[i + 1]?.position ?? null);
  }
  const config = input.config
    ? clean(ViewConfig.parse({ ...ViewConfig.parse(view.config), ...input.config }), fields)
    : view.config;
  const [row] = await db
    .update(tableViews)
    .set({ name: input.name ?? view.name, config, position })
    .where(eq(tableViews.id, viewId))
    .returning();
  await announce(deps, access.table, await bump(db, tableId), null);
  return toView(row!);
}

export async function deleteView(
  deps: Pick<Deps, 'db' | 'bus'>,
  a: DriveActor,
  tableId: string,
  viewId: string,
) {
  const { db } = deps;
  const access = await loadTable(db, a, tableId, 'tables.edit');
  const views = await db
    .select({ id: tableViews.id })
    .from(tableViews)
    .where(eq(tableViews.tableId, tableId));
  if (!views.some((v) => v.id === viewId)) throw new AppError('not_found');
  if (views.length <= 1) throw new AppError('table_last_view');
  await db.delete(tableViews).where(eq(tableViews.id, viewId));
  await announce(deps, access.table, await bump(db, tableId), null);
  return {};
}
