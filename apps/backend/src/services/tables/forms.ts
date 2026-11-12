import { resources, type AppLocale } from '@crewhall/i18n';
import {
  TABLE_LIMITS,
  answerText,
  ratingScale,
  type ChoiceColor,
  type FormAnswers,
  type FormField,
  type TableFieldOptions,
  type TableFieldType,
} from '@crewhall/shared';
import type { Deps } from '../../deps';
import type { RequestInfo } from '../../http/types';
import { usersById } from '../chat/views';
import type { DriveActor } from '../drive/access';
import { loadForm, requireForm, type FormRow } from '../forms/access';
import { fieldsOf, loadTable } from './access';
import { fieldFor, valuesFromText } from './automation';
import { rowWritten } from './events';
import { createRow } from './rows';
import { createTable } from './tables';
import type { BuiltTemplate } from './templates';

/**
 * Forms and tables (roadmap › Tablolar): a table made from a form's questions, and a row per
 * answer when the form's `destinations.table` is set. Questions go to fields of the same name,
 * so a table made by hand works too; the primary field gets the respondent unless a question
 * has its name.
 */

const COLORS: ChoiceColor[] = ['blue', 'green', 'yellow', 'orange', 'red', 'pink', 'purple', 'teal', 'gray'];

function fieldOf(q: FormField): { type: TableFieldType; options: TableFieldOptions } {
  const choices = () => q.choices.map((c, i) => ({ id: `c_${c.id}`.slice(0, 40), label: c.label, color: COLORS[i % COLORS.length]! }));
  switch (q.type) {
    case 'short_text':
      return { type: 'text', options: {} };
    case 'single_choice':
      return { type: 'single_select', options: { choices: choices() } };
    case 'multi_choice':
      return { type: 'multi_select', options: { choices: choices() } };
    case 'date':
      return { type: 'date', options: {} };
    case 'number':
      return { type: 'number', options: {} };
    case 'rating':
      return { type: 'rating', options: { max: ratingScale(q) } };
    default:
      // Long text, and file names of uploads (the files stay with the form).
      return { type: 'long_text', options: {} };
  }
}

export async function createFormTable(
  deps: Pick<Deps, 'db' | 'bus'>,
  a: DriveActor,
  formId: string,
  locale: AppLocale,
  req: RequestInfo,
) {
  const { form, role } = await loadForm(deps.db, a, formId);
  requireForm(a, role, 'forms.manage');
  const t = resources[locale].email.tables;
  const cut = (s: string) => s.trim().slice(0, TABLE_LIMITS.nameChars);
  const taken = new Set<string>();
  const unique = (name: string) => {
    let n = cut(name);
    for (let i = 2; taken.has(n.toLocaleLowerCase('tr')); i++) n = cut(`${cut(name).slice(0, TABLE_LIMITS.nameChars - 4)} ${i}`);
    taken.add(n.toLocaleLowerCase('tr'));
    return n;
  };
  const fields: BuiltTemplate['fields'] = [
    { key: 'respondent', name: unique(t.formRespondent), type: 'text', options: {}, primary: true },
    ...form.fields
      .slice(0, TABLE_LIMITS.fields - 2)
      .map((q) => ({ key: q.id, name: unique(q.label), ...fieldOf(q) })),
    { key: 'submitted', name: unique(t.formSubmitted), type: 'created_at', options: {} },
  ];
  return createTable(
    deps,
    a,
    form.spaceId,
    { name: cut(t.formTable.replace('{form}', form.title)), template: 'empty' },
    locale,
    req,
    { fields, views: [{ key: 'grid', type: 'grid', name: t.defaultView }], rows: [] },
  );
}

/** One answer as a row of the form's table, written as the form's owner. */
export async function answerToTable(
  deps: Pick<Deps, 'db' | 'bus' | 'jobs' | 'logger'>,
  owner: DriveActor,
  form: FormRow,
  tableId: string,
  answer: { answers: FormAnswers; respondentId: string | null },
) {
  const { db } = deps;
  const access = await loadTable(db, owner, tableId, 'tables.edit');
  const fields = await fieldsOf(db, tableId);
  const input: Record<string, string> = {};
  for (const q of form.fields) input[q.label] = answerText(q, answer.answers[q.id]);
  const primary = fields.find((f) => f.primary);
  if (primary && !form.fields.some((q) => fieldFor([primary], q.label))) {
    const who =
      answer.respondentId && !form.settings.anonymous
        ? (await usersById(db, [answer.respondentId])).get(answer.respondentId)?.name
        : null;
    input[primary.id] = who ?? '';
  }
  const { values } = await valuesFromText(db, access, fields, input);
  const out = await createRow(deps, owner, tableId, { values });
  await rowWritten(deps, owner, out);
  return out.row.id;
}
