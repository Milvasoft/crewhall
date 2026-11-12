import {
  canContacts,
  type DirectoryImportResult,
  type DirectoryImportRow,
  type UpdateDirectoryProfile,
} from '@crewhall/shared';
import type { Db, DbOrTx } from '@crewhall/db';
import { AppError } from '../../http/errors';
import type { ContactsActor } from './access';
import { allPeople, updateProfile } from './directory';

/**
 * Bulk directory update from CSV (sonraki-isler, org chart): an admin fills a table (often an
 * export of the HR sheet) and the org chart follows. Rows apply in order inside one
 * transaction, so a manager set on line 5 counts for the loop check of line 6; a dry run rolls
 * the whole thing back and only reports.
 */

const MAX_ROWS = 5000;

/** The text fields a CSV sets (birthdays and start dates have their own screens). */
type TextField = 'title' | 'department' | 'team' | 'phone' | 'mobile' | 'location';
type Column = TextField | 'email' | 'manager';

/** Header → column; Turkish and English, without spaces, dots or dashes. */
const HEADERS: Record<string, Column> = {
  eposta: 'email',
  email: 'email',
  mail: 'email',
  epostaadresi: 'email',
  unvan: 'title',
  görev: 'title',
  title: 'title',
  jobtitle: 'title',
  departman: 'department',
  bölüm: 'department',
  department: 'department',
  ekip: 'team',
  takım: 'team',
  team: 'team',
  telefon: 'phone',
  phone: 'phone',
  istelefonu: 'phone',
  cep: 'mobile',
  ceptelefonu: 'mobile',
  mobil: 'mobile',
  mobile: 'mobile',
  konum: 'location',
  ofis: 'location',
  location: 'location',
  office: 'location',
  yönetici: 'manager',
  yöneticieposta: 'manager',
  manager: 'manager',
  manageremail: 'manager',
};

const headerKey = (h: string) =>
  h
    .trim()
    .toLocaleLowerCase('tr')
    .replace(/[\s._\-()]/g, '');

/** RFC 4180 fields; the delimiter is the one the header line uses most (Excel in Turkish: ;). */
export function parseCsv(text: string): string[][] {
  const BOM = String.fromCharCode(0xfeff);
  const src = text.startsWith(BOM) ? text.slice(1) : text;
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = [';', ',', '\t'].reduce((best, d) =>
    firstLine.split(d).length > firstLine.split(best).length ? d : best,
  );
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

class DryRun extends Error {}

export async function importDirectory(
  db: Db,
  a: ContactsActor,
  input: { csv: string; dryRun: boolean },
): Promise<DirectoryImportResult> {
  if (!canContacts('directory.manage', { orgRole: a.actor.orgRole })) {
    throw new AppError('forbidden');
  }
  const [header, ...lines] = parseCsv(input.csv);
  const columns = (header ?? []).map((h) => HEADERS[headerKey(h)] ?? null);
  const emailAt = columns.indexOf('email');
  const body = lines
    .map((cells, i) => ({ cells, line: i + 2 }))
    .filter(({ cells }) => cells.some((c) => c.trim()));
  if (emailAt < 0 || !body.length) throw new AppError('directory_csv_invalid');
  if (body.length > MAX_ROWS) {
    throw new AppError('validation_failed', { field: 'csv', reason: 'too_many_rows' });
  }

  const rows: DirectoryImportRow[] = [];
  const run = async (tx: DbOrTx) => {
    const people = await allPeople(tx, a);
    const byEmail = new Map(people.map((p) => [p.u.email.toLowerCase(), p]));
    for (const { cells, line } of body) {
      const email = (cells[emailAt] ?? '').trim();
      const person = byEmail.get(email.toLowerCase());
      const fail = (code: string): DirectoryImportRow => ({
        line,
        email,
        name: person?.u.name ?? null,
        status: 'failed',
        fields: [],
        code,
      });
      if (!person) {
        rows.push(fail('directory_person_unknown'));
        continue;
      }
      const patch: UpdateDirectoryProfile = {};
      const changed: string[] = [];
      let bad: string | null = null;
      columns.forEach((col, i) => {
        if (!col || col === 'email') return;
        const v = (cells[i] ?? '').trim();
        if (col === 'manager') {
          const manager = v ? byEmail.get(v.toLowerCase()) : null;
          if (v && !manager) bad = 'directory_person_unknown';
          const id = manager ? manager.u.id : null;
          if (id !== (person.p?.managerId ?? null)) {
            patch.managerId = id;
            changed.push('managerId');
          }
          return;
        }
        const value = v ? v.slice(0, col === 'phone' || col === 'mobile' ? 40 : 120) : null;
        if (value !== (person.p?.[col] ?? null)) {
          patch[col] = value;
          changed.push(col);
        }
      });
      if (bad) {
        rows.push(fail(bad));
        continue;
      }
      if (!changed.length) {
        rows.push({
          line,
          email,
          name: person.u.name,
          status: 'unchanged',
          fields: [],
          code: null,
        });
        continue;
      }
      try {
        await updateProfile(tx, a, person.u.id, patch);
        // Later rows see this one (managers, loop checks).
        person.p = { ...(person.p ?? ({} as NonNullable<typeof person.p>)), ...patch };
        rows.push({
          line,
          email,
          name: person.u.name,
          status: 'updated',
          fields: changed,
          code: null,
        });
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        rows.push(fail(err.code));
      }
    }
    if (input.dryRun) throw new DryRun();
  };
  try {
    await db.transaction(run);
  } catch (err) {
    if (!(err instanceof DryRun)) throw err;
  }
  return {
    dryRun: input.dryRun,
    rows,
    updated: rows.filter((r) => r.status === 'updated').length,
    unchanged: rows.filter((r) => r.status === 'unchanged').length,
    failed: rows.filter((r) => r.status === 'failed').length,
  };
}
