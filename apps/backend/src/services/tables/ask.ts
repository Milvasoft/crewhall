import { dataTables, spaceMembers, type Db } from '@crewhall/db';
import { cellText } from '@crewhall/shared';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { DriveActor } from '../drive/access';
import { canTables, fieldsOf, tablesEnabled } from './access';
import { peopleOf, rowPath } from './events';
import { queryRows } from './rows';

/**
 * Table rows for the assistant ("Crewhall'a sor") and MCP: the search words in the tables of
 * the spaces the person belongs to, through the same query as the app, so only what the person
 * may see comes back. A table whose name holds the words lists its first rows.
 */

const MAX_TABLES = 15;

export interface FoundRow {
  tableId: string;
  tableName: string;
  spaceId: string;
  rowId: string;
  title: string;
  url: string;
  /** "Alan: değer" pairs of the filled fields, one line. */
  text: string;
}

const words = (s: string) =>
  s
    .toLocaleLowerCase('tr')
    .split(/[^\p{L}\d]+/u)
    .filter((w) => w.length > 2);

export async function searchTableRows(db: Db, a: DriveActor, query: string, limit = 10) {
  if (!(await tablesEnabled(db, a.org.id))) return [];
  const memberships = await db
    .select({ spaceId: spaceMembers.spaceId, role: spaceMembers.role })
    .from(spaceMembers)
    .where(eq(spaceMembers.userId, a.userId));
  const visible = memberships.filter((m) => canTables(a, m.role, 'space.view')).map((m) => m.spaceId);
  if (visible.length === 0) return [];
  const tables = await db
    .select({ id: dataTables.id, name: dataTables.name, spaceId: dataTables.spaceId })
    .from(dataTables)
    .where(and(eq(dataTables.orgId, a.org.id), inArray(dataTables.spaceId, visible)))
    .orderBy(desc(dataTables.updatedAt))
    .limit(200);
  const ws = words(query);
  // "envanterde" names "Envanter": a word of the table name may start a word of the question.
  const named = (name: string) => {
    const n = name.toLocaleLowerCase('tr');
    return ws.some((w) => n.includes(w) || words(n).some((nw) => w.startsWith(nw)));
  };
  const ordered = [...tables.filter((t) => named(t.name)), ...tables.filter((t) => !named(t.name))].slice(
    0,
    MAX_TABLES,
  );
  const out: FoundRow[] = [];
  for (const t of ordered) {
    if (out.length >= limit) break;
    const byName = named(t.name);
    // The table is the subject ("envanterde ne var"): its first rows; otherwise rows with the words.
    const page = await queryRows(db, a, t.id, {
      q: byName ? undefined : query.trim().slice(0, 200),
      limit: Math.min(5, limit - out.length),
    }).catch(() => null);
    if (!page || page.items.length === 0) continue;
    const fields = await fieldsOf(db, t.id);
    const people = await peopleOf(db, fields, page.items.map((r) => r.values));
    const primary = fields.find((f) => f.primary);
    for (const r of page.items) {
      const pairs = fields
        .map((f) => [f.name, cellText(f, r.values[f.id] ?? null, people)] as const)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}: ${v.replace(/\s+/g, ' ').slice(0, 300)}`);
      out.push({
        tableId: t.id,
        tableName: t.name,
        spaceId: t.spaceId,
        rowId: r.id,
        title: primary ? cellText(primary, r.values[primary.id] ?? null, people) : '',
        url: rowPath(t.id, r.id),
        text: pairs.join('; '),
      });
    }
  }
  return out;
}
