import { users, type Db } from '@crewhall/db';
import { cellText, type PersonNames, type RowValues, type TableField } from '@crewhall/shared';
import { eq, inArray } from 'drizzle-orm';
import type { Jobs } from '../../jobs/queue';
import type { Logger } from '../../logger';
import { emitAutomationEvent } from '../automations/emit';
import type { DriveActor } from '../drive/access';
import { fieldsOf } from './access';
import type { RowWrite } from './rows';

/**
 * Row writes as automation events (`tables.row_created`, `tables.row_updated`), after commit.
 * Values are text by field id (`{{values.<id>}}`), with `_text`: "Alan: değer" lines of the filled
 * ones (`{{values}}`), like form answers.
 */

type EventDeps = { db: Db; jobs: Jobs; logger: Logger };

export const rowPath = (tableId: string, rowId: string) => `/tables/t/${tableId}?row=${rowId}`;

function valuesData(fields: TableField[], values: RowValues, people: PersonNames) {
  const byId = Object.fromEntries(fields.map((f) => [f.id, cellText(f, values[f.id] ?? null, people)]));
  const lines = fields
    .filter((f) => byId[f.id])
    .map((f) => `${f.name}: ${byId[f.id]!.replace(/\s*\n\s*/g, ' ')}`);
  return { ...byId, _text: lines.join('\n') };
}

/** Names of the people in person cells. */
export async function peopleOf(db: Db, fields: TableField[], rows: RowValues[]) {
  const ids = new Set<string>();
  for (const f of fields.filter((x) => x.type === 'person')) {
    for (const v of rows) for (const id of Array.isArray(v[f.id]) ? (v[f.id] as string[]) : []) ids.add(id);
  }
  if (ids.size === 0) return new Map<string, string>();
  const list = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, [...ids]));
  return new Map(list.map((u) => [u.id, u.name]));
}

export async function rowWritten(deps: EventDeps, a: DriveActor, w: RowWrite) {
  if (w.before && w.changedFieldIds.length === 0) return;
  try {
    const fields = await fieldsOf(deps.db, w.access.table.id);
    const [actor] = await deps.db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(eq(users.id, a.userId));
    const primary = fields.find((f) => f.primary);
    const people = await peopleOf(deps.db, fields, [w.row.values, ...(w.before ? [w.before] : [])]);
    await emitAutomationEvent(deps, {
      orgId: w.access.table.orgId,
      spaceId: w.access.table.spaceId,
      type: w.before ? 'tables.row_updated' : 'tables.row_created',
      data: {
        table: { id: w.access.table.id, name: w.access.table.name },
        row: {
          id: w.row.id,
          title: primary ? cellText(primary, w.row.values[primary.id] ?? null, people) : '',
          url: rowPath(w.access.table.id, w.row.id),
        },
        values: valuesData(fields, w.row.values, people),
        before: w.before ? valuesData(fields, w.before, people) : null,
        changed: w.changedFieldIds.map((id) => fields.find((f) => f.id === id)?.name ?? id),
        actor: actor ?? null,
      },
      match: { tableId: w.access.table.id, changedFieldIds: w.changedFieldIds },
    });
  } catch (err) {
    deps.logger.warn({ err, tableId: w.access.table.id }, 'table row event not built');
  }
}
