import { and, asc, count, eq, isNull, sql } from 'drizzle-orm';
import {
  dataTables,
  spaceMembers,
  spaces,
  tableFields,
  tableRows,
  tableViews,
  type DbOrTx,
} from '@crewhall/db';
import {
  can,
  TableFieldOptions,
  ViewConfig,
  type SpaceAction,
  type SpaceRole,
  type Table,
  type TableField,
  type TableFieldType,
  type TableView,
  type TablesWsEvent,
} from '@crewhall/shared';
import { AppError } from '../../http/errors';
import { publishToUsers, type Bus } from '../../realtime/bus';
import { usersById } from '../chat/views';
import { spaceRoleOf, type DriveActor } from '../drive/access';
import { invalidateModules, isModuleEnabled } from '../identity/modules';
import { orgContext } from '../membership';

/** Tables of a space: loading with the caller's role, checks, wire shapes, change events. */

export type TableRow_ = typeof dataTables.$inferSelect;
export type FieldRow = typeof tableFields.$inferSelect;
export type ViewRow = typeof tableViews.$inferSelect;
export type RowRow = typeof tableRows.$inferSelect;

export function tablesEnabled(db: DbOrTx, orgId: string) {
  return isModuleEnabled(db, orgId, 'tables');
}

export function forgetTablesSwitch(orgId?: string) {
  invalidateModules(orgId);
}

export interface TableAccess {
  table: TableRow_;
  space: typeof spaces.$inferSelect;
  role: SpaceRole | null;
}

export function canTables(a: DriveActor, role: SpaceRole | null, action: SpaceAction) {
  return can(a.actor, action, { type: 'space', org: orgContext(a.org), myRole: role });
}

/** Without view rights the table does not exist for the caller. */
export function requireTables(a: DriveActor, role: SpaceRole | null, action: SpaceAction) {
  if (!canTables(a, role, action)) {
    throw new AppError(canTables(a, role, 'space.view') ? 'forbidden' : 'not_found');
  }
}

export async function loadTable(
  db: DbOrTx,
  a: DriveActor,
  tableId: string,
  action: SpaceAction = 'space.view',
  opts: { forUpdate?: boolean } = {},
): Promise<TableAccess> {
  const q = db
    .select({ table: dataTables, space: spaces })
    .from(dataTables)
    .innerJoin(spaces, eq(spaces.id, dataTables.spaceId))
    .where(and(eq(dataTables.id, tableId), eq(dataTables.orgId, a.org.id)));
  const [row] = opts.forUpdate ? await q.for('update', { of: dataTables }) : await q;
  if (!row || row.space.deletedAt) throw new AppError('not_found');
  const role = await spaceRoleOf(db, row.space.id, a.userId);
  requireTables(a, role, action);
  return { ...row, role };
}

export async function fieldsOf(db: DbOrTx, tableId: string): Promise<TableField[]> {
  const rows = await db
    .select()
    .from(tableFields)
    .where(eq(tableFields.tableId, tableId))
    .orderBy(asc(tableFields.position));
  return rows.map(toField);
}

export async function viewsOf(db: DbOrTx, tableId: string): Promise<TableView[]> {
  const rows = await db
    .select()
    .from(tableViews)
    .where(eq(tableViews.tableId, tableId))
    .orderBy(asc(tableViews.position));
  return rows.map(toView);
}

export const toField = (f: FieldRow): TableField => ({
  id: f.id,
  tableId: f.tableId,
  name: f.name,
  type: f.type as TableFieldType,
  options: TableFieldOptions.parse(f.options),
  description: f.description,
  primary: f.primary,
  position: f.position,
});

export const toView = (v: ViewRow): TableView => ({
  id: v.id,
  tableId: v.tableId,
  name: v.name,
  type: v.type,
  config: ViewConfig.parse(v.config),
  position: v.position,
});

export async function liveRowCount(db: DbOrTx, tableId: string) {
  const [r] = await db
    .select({ n: count() })
    .from(tableRows)
    .where(and(eq(tableRows.tableId, tableId), isNull(tableRows.deletedAt)));
  return Number(r?.n ?? 0);
}

export async function toTable(db: DbOrTx, a: DriveActor, access: TableAccess): Promise<Table> {
  const { table } = access;
  const people = table.createdBy ? await usersById(db, [table.createdBy]) : new Map();
  return {
    id: table.id,
    spaceId: table.spaceId,
    name: table.name,
    description: table.description,
    icon: table.icon,
    fields: await fieldsOf(db, table.id),
    views: await viewsOf(db, table.id),
    rowCount: await liveRowCount(db, table.id),
    rev: table.rev,
    createdBy: table.createdBy ? (people.get(table.createdBy) ?? null) : null,
    createdAt: table.createdAt.toISOString(),
    updatedAt: table.updatedAt.toISOString(),
    canEdit: canTables(a, access.role, 'tables.edit'),
  };
}

/** Bumps the table's revision; returns it for the change event. */
export async function bump(db: DbOrTx, tableId: string) {
  const [r] = await db
    .update(dataTables)
    .set({ rev: sql`${dataTables.rev} + 1` })
    .where(eq(dataTables.id, tableId))
    .returning({ rev: dataTables.rev });
  return r?.rev ?? 0;
}

/**
 * Tells the space's members (open grids, cards) that rows or the schema changed; rowIds null
 * means "refetch everything". Never fails the write.
 */
export async function announce(
  deps: { db: DbOrTx; bus: Bus },
  table: Pick<TableRow_, 'id' | 'spaceId'>,
  rev: number,
  rowIds: string[] | null,
) {
  try {
    const members = await deps.db
      .select({ userId: spaceMembers.userId })
      .from(spaceMembers)
      .where(eq(spaceMembers.spaceId, table.spaceId));
    const event: TablesWsEvent = { type: 'tables.changed', tableId: table.id, rev, rowIds };
    publishToUsers(
      deps.bus,
      members.map((m) => m.userId),
      event,
    );
  } catch {
    /* realtime is best effort; clients also refetch on focus */
  }
}
