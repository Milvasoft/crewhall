import { and, asc, count, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import {
  dataTables,
  spaceMembers,
  tableRowComments,
  tableRowHistory,
  tableRows,
  type DbOrTx,
} from '@crewhall/db';
import {
  applyView,
  coerceCell,
  computeRows,
  isComputed,
  TABLE_LIMITS,
  type CellValue,
  type EngineRow,
  type RelatedTable,
  type RowValues,
  type TableField,
  type TableRow,
  type TableRowComment,
  type TableRowHistoryItem,
  type ViewConfig,
} from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import { keyBetween } from '../../util/position';
import { usersById } from '../chat/views';
import type { DriveActor } from '../drive/access';
import {
  announce,
  bump,
  canTables,
  fieldsOf,
  loadTable,
  type RowRow,
  type TableAccess,
  viewsOf,
} from './access';

/** Rows of a table: the view query (engine), writes with history, comments (roadmap Tablolar). */

const toEngine = (r: RowRow): EngineRow => ({
  id: r.id,
  values: r.values as RowValues,
  position: r.position,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

async function liveRows(db: DbOrTx, tableId: string) {
  return db
    .select()
    .from(tableRows)
    .where(and(eq(tableRows.tableId, tableId), isNull(tableRows.deletedAt)))
    .orderBy(asc(tableRows.position));
}

/** Tables reached by relation fields, with their own lookups computed one level deep. */
export async function relatedTables(db: DbOrTx, fields: TableField[]) {
  const out = new Map<string, RelatedTable>();
  for (const f of fields) {
    const id = f.type === 'relation' ? f.options.tableId : undefined;
    if (!id || out.has(id)) continue;
    const tFields = await fieldsOf(db, id);
    const tRows = (await liveRows(db, id)).map(toEngine);
    out.set(id, { fields: tFields, rows: computeRows(tFields, tRows, new Map()) });
  }
  return out;
}

/** Everything the engine needs for a table: fields, computed live rows, related tables, names. */
export async function loadEngine(db: DbOrTx, access: TableAccess) {
  const fields = await fieldsOf(db, access.table.id);
  const related = await relatedTables(db, fields);
  const raw = await liveRows(db, access.table.id);
  const rows = computeRows(fields, raw.map(toEngine), related);
  const personIds = new Set<string>();
  for (const f of fields) {
    if (f.type !== 'person') continue;
    for (const r of rows)
      for (const id of (r.values[f.id] as string[] | null) ?? []) personIds.add(id);
  }
  const people = await usersById(db, [...personIds]);
  const names = new Map([...people].map(([id, u]) => [id, u.name]));
  return { fields, related, rows, raw, names };
}

async function commentCounts(db: DbOrTx, rowIds: string[]) {
  if (rowIds.length === 0) return new Map<string, number>();
  const rows = await db
    .select({ rowId: tableRowComments.rowId, n: count() })
    .from(tableRowComments)
    .where(inArray(tableRowComments.rowId, rowIds))
    .groupBy(tableRowComments.rowId);
  return new Map(rows.map((r) => [r.rowId, Number(r.n)]));
}

async function toRows(
  db: DbOrTx,
  tableId: string,
  rows: EngineRow[],
  raw: RowRow[],
): Promise<TableRow[]> {
  const meta = new Map(raw.map((r) => [r.id, r]));
  const counts = await commentCounts(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({
    id: r.id,
    tableId,
    values: r.values,
    position: r.position,
    commentCount: counts.get(r.id) ?? 0,
    createdBy: meta.get(r.id)?.createdBy ?? null,
    updatedBy: meta.get(r.id)?.updatedBy ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

export async function queryRows(
  db: DbOrTx,
  a: DriveActor,
  tableId: string,
  q: { viewId?: string; q?: string; cursor?: string; limit: number; from?: string; to?: string },
) {
  const access = await loadTable(db, a, tableId);
  const engine = await loadEngine(db, access);
  const view = q.viewId ? (await viewsOf(db, tableId)).find((v) => v.id === q.viewId) : undefined;
  if (q.viewId && !view) throw new AppError('not_found');
  const config: Partial<ViewConfig> = view?.config ?? {};
  // Calendar / timeline without a chosen date field use the first one, as the web does.
  const dateFieldId =
    config.dateFieldId ??
    engine.fields.find((f) => ['date', 'created_at', 'updated_at'].includes(f.type))?.id ??
    null;
  const result = applyView(engine.fields, engine.rows, { ...config, dateFieldId }, {
    q: q.q,
    people: engine.names,
    range: q.from && q.to ? { from: q.from, to: q.to } : undefined,
  });
  const start = q.cursor ? Math.max(0, Number(q.cursor) || 0) : 0;
  const slice = result.rows.slice(start, start + q.limit);
  return {
    items: await toRows(db, tableId, slice, engine.raw),
    nextCursor: start + q.limit < result.rows.length ? String(start + q.limit) : null,
    total: result.rows.length,
    groups: result.groups,
    rev: access.table.rev,
  };
}

async function oneRow(db: DbOrTx, access: TableAccess, rowId: string): Promise<TableRow> {
  const engine = await loadEngine(db, access);
  const row = engine.rows.find((r) => r.id === rowId);
  if (!row) throw new AppError('not_found');
  return (await toRows(db, access.table.id, [row], engine.raw))[0]!;
}

export async function getRow(db: DbOrTx, a: DriveActor, tableId: string, rowId: string) {
  return oneRow(db, await loadTable(db, a, tableId), rowId);
}

/**
 * Checks written values against the fields: unknown and computed fields are refused, values are
 * coerced, people must be in the space and related rows must exist.
 */
export async function checkValues(
  db: DbOrTx,
  access: TableAccess,
  fields: TableField[],
  input: Record<string, CellValue>,
): Promise<RowValues> {
  const out: RowValues = {};
  const errors: Record<string, string> = {};
  for (const [id, raw] of Object.entries(input)) {
    const field = fields.find((f) => f.id === id);
    if (!field) {
      errors[id] = 'unknown_field';
      continue;
    }
    if (isComputed(field.type)) {
      errors[id] = 'computed';
      continue;
    }
    const c = coerceCell(field, raw);
    if (!c.ok) {
      errors[id] = c.error;
      continue;
    }
    if (field.type === 'person' && Array.isArray(c.value) && c.value.length) {
      const ids = c.value as string[];
      const members = await db
        .select({ userId: spaceMembers.userId })
        .from(spaceMembers)
        .where(
          and(eq(spaceMembers.spaceId, access.table.spaceId), inArray(spaceMembers.userId, ids)),
        );
      if (members.length !== ids.length) errors[id] = 'not_member';
    }
    if (
      field.type === 'relation' &&
      Array.isArray(c.value) &&
      c.value.length &&
      field.options.tableId
    ) {
      const ids = c.value as string[];
      const found = await db
        .select({ id: tableRows.id })
        .from(tableRows)
        .where(
          and(
            eq(tableRows.tableId, field.options.tableId),
            inArray(tableRows.id, ids),
            isNull(tableRows.deletedAt),
          ),
        );
      if (found.length !== ids.length) errors[id] = 'unknown_row';
    }
    out[id] = c.value;
  }
  if (Object.keys(errors).length) throw new AppError('table_value_invalid', { fields: errors });
  return out;
}

const same = (a: CellValue | undefined, b: CellValue | undefined) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export interface RowWrite {
  /** The row as the client sees it after the write. */
  row: TableRow;
  /** Before/after of the stored values, for automations. */
  before: RowValues | null;
  after: RowValues;
  changedFieldIds: string[];
  access: TableAccess;
}

export async function createRow(
  deps: Pick<Deps, 'db' | 'bus'>,
  a: DriveActor,
  tableId: string,
  input: { values: Record<string, CellValue>; afterId?: string | null },
): Promise<RowWrite> {
  const { db } = deps;
  let rev = 0;
  const result = await db.transaction(async (tx) => {
    const access = await loadTable(tx, a, tableId, 'tables.edit', { forUpdate: true });
    const fields = await fieldsOf(tx, tableId);
    const [{ n } = { n: 0 }] = await tx
      .select({ n: count() })
      .from(tableRows)
      .where(and(eq(tableRows.tableId, tableId), isNull(tableRows.deletedAt)));
    if (Number(n) >= TABLE_LIMITS.rows)
      throw new AppError('table_limit_reached', { rows: TABLE_LIMITS.rows });
    const values = await checkValues(tx, access, fields, input.values);
    for (const f of fields)
      if (f.type === 'checkbox' && values[f.id] === undefined) values[f.id] = false;
    const all = await liveRows(tx, tableId);
    let position: string;
    if (input.afterId) {
      const i = all.findIndex((r) => r.id === input.afterId);
      if (i < 0) throw new AppError('not_found');
      position = keyBetween(all[i]!.position, all[i + 1]?.position ?? null);
    } else if (input.afterId === null) position = keyBetween(null, all[0]?.position ?? null);
    else position = keyBetween(all.at(-1)?.position ?? null, null);
    const [row] = await tx
      .insert(tableRows)
      .values({
        orgId: a.org.id,
        tableId,
        values,
        position,
        createdBy: a.userId,
        updatedBy: a.userId,
      })
      .returning();
    await tx.insert(tableRowHistory).values({
      orgId: a.org.id,
      tableId,
      rowId: row!.id,
      actorId: a.userId,
      kind: 'created',
      changes: [],
    });
    rev = await bump(tx, tableId);
    return { access, id: row!.id, values };
  });
  await announce(deps, result.access.table, rev, [result.id]);
  const row = await oneRow(db, result.access, result.id);
  return {
    row,
    before: null,
    after: result.values,
    changedFieldIds: Object.keys(result.values),
    access: result.access,
  };
}

export async function updateRow(
  deps: Pick<Deps, 'db' | 'bus'>,
  a: DriveActor,
  tableId: string,
  rowId: string,
  input: Record<string, CellValue>,
): Promise<RowWrite> {
  const { db } = deps;
  let rev = 0;
  const result = await db.transaction(async (tx) => {
    const access = await loadTable(tx, a, tableId, 'tables.edit');
    const fields = await fieldsOf(tx, tableId);
    const [row] = await tx
      .select()
      .from(tableRows)
      .where(
        and(eq(tableRows.id, rowId), eq(tableRows.tableId, tableId), isNull(tableRows.deletedAt)),
      )
      .for('update');
    if (!row) throw new AppError('not_found');
    const patch = await checkValues(tx, access, fields, input);
    const before = row.values as RowValues;
    const changes = Object.entries(patch)
      .filter(([id, v]) => !same(before[id], v))
      .map(([id, v]) => ({
        fieldId: id,
        fieldName: fields.find((f) => f.id === id)?.name ?? id,
        from: before[id] ?? null,
        to: v,
      }));
    const after = { ...before, ...patch };
    if (changes.length) {
      await tx
        .update(tableRows)
        .set({ values: after, updatedBy: a.userId })
        .where(eq(tableRows.id, rowId));
      await tx.insert(tableRowHistory).values({
        orgId: a.org.id,
        tableId,
        rowId,
        actorId: a.userId,
        kind: 'updated',
        changes,
      });
      rev = await bump(tx, tableId);
    }
    return { access, before, after, changed: changes.map((c) => c.fieldId) };
  });
  if (result.changed.length) await announce(deps, result.access.table, rev, [rowId]);
  return {
    row: await oneRow(db, result.access, rowId),
    before: result.before,
    after: result.after,
    changedFieldIds: result.changed,
    access: result.access,
  };
}

export async function moveRow(
  deps: Pick<Deps, 'db' | 'bus'>,
  a: DriveActor,
  tableId: string,
  rowId: string,
  input: { afterId: string | null; beforeId: string | null },
) {
  const { db } = deps;
  const access = await loadTable(db, a, tableId, 'tables.edit');
  const all = (await liveRows(db, tableId)).filter((r) => r.id !== rowId);
  if (!(await liveRows(db, tableId)).some((r) => r.id === rowId)) throw new AppError('not_found');
  let position: string;
  if (input.afterId) {
    const i = all.findIndex((r) => r.id === input.afterId);
    if (i < 0) throw new AppError('not_found');
    position = keyBetween(all[i]!.position, all[i + 1]?.position ?? null);
  } else if (input.beforeId) {
    const i = all.findIndex((r) => r.id === input.beforeId);
    if (i < 0) throw new AppError('not_found');
    position = keyBetween(all[i - 1]?.position ?? null, all[i]!.position);
  } else position = keyBetween(null, all[0]?.position ?? null);
  await db.update(tableRows).set({ position }).where(eq(tableRows.id, rowId));
  await announce(deps, access.table, await bump(db, tableId), [rowId]);
  return oneRow(db, access, rowId);
}

export async function setDeleted(
  deps: Pick<Deps, 'db' | 'bus'>,
  a: DriveActor,
  tableId: string,
  rowIds: string[],
  deleted: boolean,
) {
  const { db } = deps;
  const access = await loadTable(db, a, tableId, 'tables.edit');
  const rows = await db
    .update(tableRows)
    .set({ deletedAt: deleted ? new Date() : null, updatedBy: a.userId })
    .where(
      and(
        eq(tableRows.tableId, tableId),
        inArray(tableRows.id, rowIds),
        deleted ? isNull(tableRows.deletedAt) : isNotNull(tableRows.deletedAt),
      ),
    )
    .returning({ id: tableRows.id });
  if (rows.length) {
    await db.insert(tableRowHistory).values(
      rows.map((r) => ({
        orgId: a.org.id,
        tableId,
        rowId: r.id,
        actorId: a.userId,
        kind: deleted ? ('deleted' as const) : ('restored' as const),
        changes: [],
      })),
    );
    await announce(
      deps,
      access.table,
      await bump(db, tableId),
      rows.map((r) => r.id),
    );
  }
  return {};
}

/* -------------------------------- comments -------------------------------- */

async function requireRow(db: DbOrTx, tableId: string, rowId: string) {
  const [row] = await db
    .select({ id: tableRows.id })
    .from(tableRows)
    .where(and(eq(tableRows.id, rowId), eq(tableRows.tableId, tableId)));
  if (!row) throw new AppError('not_found');
}

export async function listComments(db: DbOrTx, a: DriveActor, tableId: string, rowId: string) {
  await loadTable(db, a, tableId);
  await requireRow(db, tableId, rowId);
  const rows = await db
    .select()
    .from(tableRowComments)
    .where(eq(tableRowComments.rowId, rowId))
    .orderBy(asc(tableRowComments.createdAt));
  const people = await usersById(
    db,
    rows.map((r) => r.authorId).filter((v): v is string => !!v),
  );
  const items: TableRowComment[] = rows.map((r) => ({
    id: r.id,
    rowId: r.rowId,
    author: r.authorId ? (people.get(r.authorId) ?? null) : null,
    text: r.text,
    createdAt: r.createdAt.toISOString(),
  }));
  return { items };
}

export async function addComment(
  deps: Pick<Deps, 'db' | 'bus'>,
  a: DriveActor,
  tableId: string,
  rowId: string,
  text: string,
) {
  const { db } = deps;
  const access = await loadTable(db, a, tableId, 'space.comment');
  await requireRow(db, tableId, rowId);
  const [row] = await db
    .insert(tableRowComments)
    .values({ orgId: a.org.id, tableId, rowId, authorId: a.userId, text })
    .returning();
  await announce(deps, access.table, await bump(db, tableId), [rowId]);
  const people = await usersById(db, [a.userId]);
  return {
    id: row!.id,
    rowId,
    author: people.get(a.userId) ?? null,
    text: row!.text,
    createdAt: row!.createdAt.toISOString(),
  };
}

export async function deleteComment(
  deps: Pick<Deps, 'db' | 'bus'>,
  a: DriveActor,
  tableId: string,
  commentId: string,
) {
  const { db } = deps;
  const access = await loadTable(db, a, tableId);
  const [c] = await db
    .select()
    .from(tableRowComments)
    .where(and(eq(tableRowComments.id, commentId), eq(tableRowComments.tableId, tableId)));
  if (!c) throw new AppError('not_found');
  if (c.authorId !== a.userId && !canTables(a, access.role, 'tables.edit'))
    throw new AppError('forbidden');
  await db.delete(tableRowComments).where(eq(tableRowComments.id, commentId));
  await announce(deps, access.table, await bump(db, tableId), [c.rowId]);
  return {};
}

export async function listHistory(db: DbOrTx, a: DriveActor, tableId: string, rowId: string) {
  await loadTable(db, a, tableId);
  await requireRow(db, tableId, rowId);
  const rows = await db
    .select()
    .from(tableRowHistory)
    .where(eq(tableRowHistory.rowId, rowId))
    .orderBy(desc(tableRowHistory.createdAt))
    .limit(200);
  const people = await usersById(
    db,
    rows.map((r) => r.actorId).filter((v): v is string => !!v),
  );
  const items: TableRowHistoryItem[] = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    actor: r.actorId ? (people.get(r.actorId) ?? null) : null,
    changes: r.changes,
    createdAt: r.createdAt.toISOString(),
  }));
  return { items };
}

/** Name of a table, for automation and assistant texts. */
export async function tableName(db: DbOrTx, tableId: string) {
  const [t] = await db
    .select({ name: dataTables.name })
    .from(dataTables)
    .where(eq(dataTables.id, tableId));
  return t?.name ?? '';
}
