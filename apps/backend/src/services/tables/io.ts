import { and, count, eq, isNull } from 'drizzle-orm';
import { dataTables, newId, tableFields, tableRows, tableViews, type DbOrTx } from '@crewhall/db';
import { resources, type AppLocale } from '@crewhall/i18n';
import {
  applyView,
  cellText,
  coerceCell,
  inferFieldType,
  isComputed,
  parseCsv,
  TABLE_LIMITS,
  toCsv,
  ViewConfig,
  type CellValue,
  type ChoiceColor,
  type TableField,
  type TableFieldOptions,
  type TableFieldType,
} from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { RequestInfo } from '../../http/types';
import { keyBetween } from '../../util/position';
import { audit } from '../audit';
import { loadSpace, type DriveActor } from '../drive/access';
import { announce, bump, fieldsOf, loadTable, requireTables, viewsOf } from './access';
import { loadEngine } from './rows';
import { positions } from './tables';
import { excelSerialToDate, readXlsx, writeXlsx } from './xlsx';

/** CSV and Excel import (new table or append by column name) and export of a view. */

const PRIMARY_OK: readonly TableFieldType[] = ['text', 'number', 'email', 'url', 'phone', 'date'];
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
const DATA_URL = /^data:([^;,]*)(;base64)?,(.*)$/s;

/** Rows of an uploaded file (header first). */
export function readTableFile(fileName: string, dataURL: string): string[][] {
  const m = DATA_URL.exec(dataURL);
  if (!m || !m[2]) throw new AppError('table_import_invalid', { reason: 'data_url' });
  const bytes = Buffer.from(m[3]!, 'base64');
  if (bytes.length > TABLE_LIMITS.importBytes)
    throw new AppError('table_import_invalid', { reason: 'too_large' });
  const isXlsx = /\.xlsx$/i.test(fileName) || bytes.subarray(0, 2).toString() === 'PK';
  let rows: string[][];
  try {
    rows = isXlsx ? readXlsx(new Uint8Array(bytes)) : parseCsv(bytes.toString('utf8'));
  } catch {
    throw new AppError('table_import_invalid', { reason: 'unreadable' });
  }
  if (rows.length === 0 || rows[0]!.every((h) => !h.trim()))
    throw new AppError('table_import_invalid', { reason: 'no_header' });
  return rows;
}

/** Imports write text; Excel dates arrive as serial numbers. */
function importCell(field: TableField, raw: string): CellValue | undefined {
  if (!raw.trim()) return undefined;
  if (field.type === 'date' && /^\d{4,5}(\.\d+)?$/.test(raw.trim())) {
    const iso = excelSerialToDate(Number(raw));
    return field.options.includeTime ? iso : iso.slice(0, 10);
  }
  const c = coerceCell(field, raw);
  return c.ok ? c.value : undefined;
}

export async function importTable(
  deps: Pick<Deps, 'db' | 'bus'>,
  a: DriveActor,
  spaceId: string,
  input: {
    fileName: string;
    dataURL: string;
    mode: 'new' | 'append';
    tableId?: string;
    name?: string;
  },
  locale: AppLocale,
  req: RequestInfo,
) {
  const { db } = deps;
  const [header, ...body] = readTableFile(input.fileName, input.dataURL);
  const headers = header!.map((h, i) => h.trim() || `${i + 1}`).slice(0, TABLE_LIMITS.fields);
  const result = await db.transaction(async (tx) => {
    let tableId: string;
    let fields: TableField[];
    let created = 0;
    const skipped: string[] = [];
    let columns: (TableField | null)[];
    if (input.mode === 'append') {
      if (!input.tableId) throw new AppError('table_import_invalid', { reason: 'table' });
      const access = await loadTable(tx, a, input.tableId, 'tables.edit', { forUpdate: true });
      if (access.table.spaceId !== spaceId) throw new AppError('not_found');
      tableId = access.table.id;
      fields = await fieldsOf(tx, tableId);
      columns = headers.map((h) => {
        const f = fields.find(
          (x) =>
            x.name.toLocaleLowerCase('tr') === h.toLocaleLowerCase('tr') && !isComputed(x.type),
        );
        if (!f) skipped.push(h);
        return f ?? null;
      });
    } else {
      const { space, role } = await loadSpace(tx, a, spaceId);
      requireTables(a, role, 'tables.edit');
      if (space.archivedAt) throw new AppError('forbidden', { reason: 'space_archived' });
      const [{ n } = { n: 0 }] = await tx
        .select({ n: count() })
        .from(dataTables)
        .where(eq(dataTables.spaceId, spaceId));
      if (Number(n) >= TABLE_LIMITS.tablesPerSpace)
        throw new AppError('table_limit_reached', { tables: TABLE_LIMITS.tablesPerSpace });
      const base = input.name ?? input.fileName.replace(/\.(csv|xlsx)$/i, '').trim();
      const [table] = await tx
        .insert(dataTables)
        .values({
          orgId: a.org.id,
          spaceId,
          name: (base || resources[locale].email.tables.importedSheet).slice(
            0,
            TABLE_LIMITS.nameChars,
          ),
          createdBy: a.userId,
        })
        .returning();
      tableId = table!.id;
      const pos = positions(headers.length);
      fields = headers.map((name, i) => {
        const sample = body.slice(0, 500).map((r) => r[i] ?? '');
        let type = inferFieldType(sample);
        if (i === 0 && !PRIMARY_OK.includes(type)) type = 'text';
        const options: TableFieldOptions = {};
        if (type === 'single_select') {
          const labels = [
            ...new Map(
              sample
                .filter((s) => s.trim())
                .map((s) => [s.trim().toLocaleLowerCase('tr'), s.trim()]),
            ).values(),
          ];
          options.choices = labels.slice(0, TABLE_LIMITS.choices).map((label, j) => ({
            id: `c${j + 1}`,
            label,
            color: COLORS[j % COLORS.length]!,
          }));
        }
        if (type === 'number') options.precision = sample.some((s) => /[.,]\d/.test(s)) ? 2 : 0;
        return {
          id: newId(),
          tableId,
          name: name.slice(0, TABLE_LIMITS.nameChars),
          type,
          options,
          description: null,
          primary: i === 0,
          position: pos[i]!,
        };
      });
      await tx.insert(tableFields).values(
        fields.map((f) => ({
          id: f.id,
          orgId: a.org.id,
          tableId,
          name: f.name,
          type: f.type,
          options: f.options,
          primary: f.primary,
          position: f.position,
        })),
      );
      await tx.insert(tableViews).values({
        orgId: a.org.id,
        tableId,
        name: resources[locale].email.tables.defaultView,
        type: 'grid',
        config: ViewConfig.parse({}),
        position: keyBetween(null, null),
        createdBy: a.userId,
      });
      created = fields.length;
      columns = fields;
    }
    const [{ n: existing } = { n: 0 }] = await tx
      .select({ n: count() })
      .from(tableRows)
      .where(and(eq(tableRows.tableId, tableId), isNull(tableRows.deletedAt)));
    const room = TABLE_LIMITS.rows - Number(existing);
    if (body.length > room) throw new AppError('table_limit_reached', { rows: TABLE_LIMITS.rows });
    const last = await tx
      .select({ position: tableRows.position })
      .from(tableRows)
      .where(eq(tableRows.tableId, tableId));
    const start =
      last
        .map((r) => r.position)
        .sort()
        .at(-1) ?? null;
    const pos = positions(body.length, start);
    const values = body.map((r) => {
      const v: Record<string, CellValue> = {};
      columns.forEach((f, i) => {
        if (!f) return;
        const cell = importCell(f, r[i] ?? '');
        if (cell !== undefined) v[f.id] = cell;
      });
      for (const f of fields) if (f.type === 'checkbox' && v[f.id] === undefined) v[f.id] = false;
      return v;
    });
    for (let i = 0; i < values.length; i += 500) {
      await tx.insert(tableRows).values(
        values.slice(i, i + 500).map((v, j) => ({
          orgId: a.org.id,
          tableId,
          values: v,
          position: pos[i + j]!,
          createdBy: a.userId,
          updatedBy: a.userId,
        })),
      );
    }
    const rev = await bump(tx, tableId);
    return {
      tableId,
      rowsAdded: values.length,
      fieldsCreated: created,
      skippedColumns: skipped,
      rev,
    };
  });
  await audit(
    db,
    {
      orgId: a.org.id,
      actorId: a.userId,
      action: 'table.import',
      targetType: 'table',
      targetId: result.tableId,
      meta: { rows: result.rowsAdded, mode: input.mode },
    },
    req,
  );
  await announce(deps, { id: result.tableId, spaceId }, result.rev, null);
  const { rev: _rev, ...out } = result;
  return out;
}

/** The view's rows (its filter, sort and visible fields in order) as CSV or XLSX. */
export async function exportView(
  db: DbOrTx,
  a: DriveActor,
  tableId: string,
  viewId: string | undefined,
  format: 'csv' | 'xlsx',
) {
  const access = await loadTable(db, a, tableId);
  const engine = await loadEngine(db, access);
  const view = viewId ? (await viewsOf(db, tableId)).find((v) => v.id === viewId) : undefined;
  const config = view?.config ?? ViewConfig.parse({});
  const { rows } = applyView(engine.fields, engine.rows, config, { people: engine.names });
  const hidden = new Set(config.hidden);
  const order = [
    ...config.order
      .map((id) => engine.fields.find((f) => f.id === id))
      .filter((f): f is TableField => !!f),
    ...engine.fields.filter((f) => !config.order.includes(f.id)),
  ].filter((f) => !hidden.has(f.id));
  const header = order.map((f) => f.name);
  const name = `${access.table.name}${view ? ` - ${view.name}` : ''}`.replace(/[\\/]/g, '-');
  if (format === 'csv') {
    const lines = rows.map((r) =>
      order.map((f) =>
        cellText(
          f,
          r.values[f.id] ?? null,
          engine.names,
          f.type === 'relation' ? engine.related.get(f.options.tableId ?? '') : undefined,
        ),
      ),
    );
    return {
      name: `${name}.csv`,
      mime: 'text/csv; charset=utf-8',
      body: Buffer.from(toCsv([header, ...lines]), 'utf8'),
    };
  }
  const lines = rows.map((r) =>
    order.map((f) => {
      const v = r.values[f.id] ?? null;
      if (typeof v === 'number' || typeof v === 'boolean') return v;
      return cellText(
        f,
        v,
        engine.names,
        f.type === 'relation' ? engine.related.get(f.options.tableId ?? '') : undefined,
      );
    }),
  );
  return {
    name: `${name}.xlsx`,
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    body: Buffer.from(writeXlsx([header, ...lines], access.table.name)),
  };
}
