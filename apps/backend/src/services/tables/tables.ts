import { and, count, desc, eq, isNull } from 'drizzle-orm';
import {
  dataTables,
  newId,
  nodes,
  tableFields,
  tableRows,
  tableViews,
  type DbOrTx,
} from '@crewhall/db';
import { resources, type AppLocale } from '@crewhall/i18n';
import {
  coerceCell,
  CreateTable,
  TABLE_LIMITS,
  UpdateTable,
  ViewConfig,
  type TableField,
  type TableSummary,
  type ViewConfigInput,
} from '@crewhall/shared';
import type { z } from 'zod';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { RequestInfo } from '../../http/types';
import { keyBetween } from '../../util/position';
import { audit } from '../audit';
import { loadSpace, type DriveActor } from '../drive/access';
import { createFolder } from '../drive/nodes';
import { announce, bump, loadTable, requireTables, toTable } from './access';
import { buildTemplate, type BuiltTemplate } from './templates';

/** Tables of a space: list, create (empty or from a template), rename, delete (roadmap Tablolar). */

/** `count` positions in order: a, b, c… as fractional keys. */
export function positions(count: number, after: string | null = null): string[] {
  const out: string[] = [];
  let prev = after;
  for (let i = 0; i < count; i++) {
    prev = keyBetween(prev, null);
    out.push(prev);
  }
  return out;
}

export async function listTables(db: DbOrTx, a: DriveActor, spaceId: string) {
  const { role } = await loadSpace(db, a, spaceId);
  requireTables(a, role, 'space.view');
  const rows = await db
    .select()
    .from(dataTables)
    .where(and(eq(dataTables.spaceId, spaceId), eq(dataTables.orgId, a.org.id)))
    .orderBy(desc(dataTables.updatedAt));
  const counts = new Map<string, number>();
  for (const t of rows) {
    const [r] = await db
      .select({ n: count() })
      .from(tableRows)
      .where(and(eq(tableRows.tableId, t.id), isNull(tableRows.deletedAt)));
    counts.set(t.id, Number(r?.n ?? 0));
  }
  const items: TableSummary[] = rows.map((t) => ({
    id: t.id,
    spaceId: t.spaceId,
    name: t.name,
    description: t.description,
    icon: t.icon,
    rowCount: counts.get(t.id) ?? 0,
    updatedAt: t.updatedAt.toISOString(),
  }));
  return { items };
}

/** View config with template field keys replaced by the new field ids. */
function mapConfig(config: ViewConfigInput | undefined, ids: Map<string, string>) {
  const id = (k: string | null | undefined) => (k ? (ids.get(k) ?? k) : null);
  return ViewConfig.parse({
    ...(config ?? {}),
    groupBy: id(config?.groupBy),
    kanbanFieldId: id(config?.kanbanFieldId),
    dateFieldId: id(config?.dateFieldId),
    endDateFieldId: id(config?.endDateFieldId),
    coverFieldId: id(config?.coverFieldId),
    filters: (config?.filters ?? []).map((f) => ({ ...f, fieldId: id(f.fieldId)! })),
    sorts: (config?.sorts ?? []).map((s) => ({ ...s, fieldId: id(s.fieldId)! })),
  });
}

export async function createTable(
  deps: Pick<Deps, 'db' | 'bus'>,
  a: DriveActor,
  spaceId: string,
  input: z.output<typeof CreateTable>,
  locale: AppLocale,
  req: RequestInfo,
  /** Fields and views built elsewhere (a form's questions) instead of the template. */
  built?: BuiltTemplate,
) {
  const { db } = deps;
  const { space, role } = await loadSpace(db, a, spaceId);
  requireTables(a, role, 'tables.edit');
  if (space.archivedAt) throw new AppError('forbidden', { reason: 'space_archived' });
  const [{ n } = { n: 0 }] = await db
    .select({ n: count() })
    .from(dataTables)
    .where(eq(dataTables.spaceId, spaceId));
  if (Number(n) >= TABLE_LIMITS.tablesPerSpace) {
    throw new AppError('table_limit_reached', { tables: TABLE_LIMITS.tablesPerSpace });
  }
  const tpl = built ?? buildTemplate(input.template, locale);
  const tableId = await db.transaction(async (tx) => {
    const [table] = await tx
      .insert(dataTables)
      .values({
        orgId: a.org.id,
        spaceId,
        name: input.name,
        description: input.description ?? null,
        createdBy: a.userId,
      })
      .returning();
    const ids = new Map(tpl.fields.map((f) => [f.key, newId()]));
    const fieldPos = positions(tpl.fields.length);
    const fieldRows = tpl.fields.map((f, i) => ({
      id: ids.get(f.key)!,
      orgId: a.org.id,
      tableId: table!.id,
      name: f.name,
      type: f.type,
      options: f.options,
      primary: f.primary === true,
      position: fieldPos[i]!,
    }));
    await tx.insert(tableFields).values(fieldRows);
    const viewPos = positions(tpl.views.length);
    await tx.insert(tableViews).values(
      tpl.views.map((v, i) => ({
        orgId: a.org.id,
        tableId: table!.id,
        name: v.name,
        type: v.type,
        config: mapConfig(v.config, ids),
        position: viewPos[i]!,
        createdBy: a.userId,
      })),
    );
    if (tpl.rows.length) {
      const fields: TableField[] = fieldRows.map((f) => ({
        id: f.id,
        tableId: f.tableId,
        name: f.name,
        type: f.type,
        options: f.options,
        description: null,
        primary: f.primary,
        position: f.position,
      }));
      const rowPos = positions(tpl.rows.length);
      await tx.insert(tableRows).values(
        tpl.rows.map((r, i) => {
          const values: Record<string, never> = {};
          for (const [key, raw] of Object.entries(r)) {
            const f = fields.find((x) => x.id === ids.get(key));
            if (!f) continue;
            const c = coerceCell(f, raw as never);
            if (c.ok) (values as Record<string, unknown>)[f.id] = c.value;
          }
          return {
            orgId: a.org.id,
            tableId: table!.id,
            values,
            position: rowPos[i]!,
            createdBy: a.userId,
            updatedBy: a.userId,
          };
        }),
      );
    }
    return table!.id;
  });
  await audit(
    db,
    {
      orgId: a.org.id,
      actorId: a.userId,
      action: 'table.create',
      targetType: 'table',
      targetId: tableId,
      meta: { template: input.template },
    },
    req,
  );
  return toTable(db, a, await loadTable(db, a, tableId));
}

export async function getTable(db: DbOrTx, a: DriveActor, tableId: string) {
  return toTable(db, a, await loadTable(db, a, tableId));
}

export async function updateTable(
  deps: Pick<Deps, 'db' | 'bus'>,
  a: DriveActor,
  tableId: string,
  input: z.output<typeof UpdateTable>,
) {
  const { db } = deps;
  const access = await loadTable(db, a, tableId, 'tables.edit');
  await db
    .update(dataTables)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.icon !== undefined ? { icon: input.icon } : {}),
    })
    .where(eq(dataTables.id, tableId));
  const rev = await bump(db, tableId);
  await announce(deps, access.table, rev, null);
  return toTable(db, a, await loadTable(db, a, tableId));
}

export async function deleteTable(
  deps: Pick<Deps, 'db' | 'bus'>,
  a: DriveActor,
  tableId: string,
  req: RequestInfo,
) {
  const { db } = deps;
  const access = await loadTable(db, a, tableId, 'tables.edit');
  await db.delete(dataTables).where(eq(dataTables.id, tableId));
  await audit(
    db,
    {
      orgId: a.org.id,
      actorId: a.userId,
      action: 'table.delete',
      targetType: 'table',
      targetId: tableId,
      meta: { name: access.table.name },
    },
    req,
  );
  await announce(deps, access.table, access.table.rev + 1, null);
  return {};
}

/** "<table> · Ekler" at the space root: attachment cells upload there through Drive. */
export async function attachmentFolder(
  db: DbOrTx,
  a: DriveActor,
  tableId: string,
  locale: AppLocale,
) {
  const access = await loadTable(db, a, tableId, 'tables.edit');
  const { table, space } = access;
  if (table.attachmentFolderId) {
    const [folder] = await db
      .select({ id: nodes.id, deletedAt: nodes.deletedAt })
      .from(nodes)
      .where(eq(nodes.id, table.attachmentFolderId));
    if (folder && !folder.deletedAt) return { spaceId: space.id, folderId: folder.id };
  }
  const base = resources[locale].email.tables.attachmentsFolder.replace('{table}', table.name);
  // The app's own folder (system_role): Drive does not list it; cells link to its files.
  const folder = await createFolder(db, a, space.id, {
    parentId: null,
    name: base,
    system: `table_attachments:${table.id}`,
  });
  await db
    .update(dataTables)
    .set({ attachmentFolderId: folder.id })
    .where(eq(dataTables.id, table.id));
  return { spaceId: space.id, folderId: folder.id };
}
