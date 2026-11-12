import { randomBytes } from 'node:crypto';
import {
  TableFieldOptions,
  TableFieldType,
  TableViewType,
  ViewConfigPatch,
  type TableField,
} from '@crewhall/shared';
import { z } from 'zod';
import { operate } from './api';
import { defineTool, ToolError, type ToolContext } from './types';

/**
 * Table structure (scope tables:write): add or change a field, add a saved view. Removing a
 * field or a view goes through call_write_operation and waits for approval (data is lost).
 */

const choiceId = () => `c${randomBytes(4).toString('hex')}`;

async function fieldsOf(ctx: ToolContext, tableId: string) {
  const table = (await operate(ctx, 'getTable', { params: { tableId } })) as {
    id: string;
    name: string;
    fields: TableField[];
  };
  return table;
}

function fieldByName(fields: TableField[], idOrName: string) {
  const f =
    fields.find((x) => x.id === idOrName) ??
    fields.find((x) => x.name.toLocaleLowerCase('tr') === idOrName.toLocaleLowerCase('tr'));
  if (!f) {
    throw new ToolError(
      'not_found',
      `"${idOrName}" alanı yok. Alanlar: ${fields.map((x) => x.name).join(', ')}`,
    );
  }
  return f;
}

const Choices = z
  .array(z.string().trim().min(1).max(200))
  .max(100)
  .optional()
  .describe('single_select / multi_select: the choice labels, in order');
const Options = TableFieldOptions.omit({ choices: true })
  .partial()
  .optional()
  .describe('Type options: precision, currency, includeTime, max, multiple, tableId, formula…');

export const createTableField = defineTool({
  name: 'create_table_field',
  title: 'Create table field',
  description:
    'Adds a field (column) to a table: text, number, currency, date, single/multi select (with choices), person, checkbox, url, email, phone, rating, relation, lookup, rollup, formula…',
  scope: 'tables:write',
  module: 'tables',
  write: true,
  approval: null,
  annotations: { readOnly: false, destructive: false, idempotent: false },
  input: z.object({
    table_id: z.uuid(),
    name: z.string().trim().min(1).max(120),
    type: TableFieldType,
    choices: Choices,
    options: Options,
    description: z.string().max(500).optional(),
    after: z.string().max(120).optional().describe('Put it after this field (id or name)'),
  }),
  example: {
    table_id: '0192f1c4-0000-7000-8000-000000000000',
    name: 'Aşama',
    type: 'single_select',
    choices: ['Aday', 'Teklif', 'Kazanıldı'],
  },
  async run(ctx, input) {
    const table = await fieldsOf(ctx, input.table_id);
    const after = input.after ? fieldByName(table.fields, input.after).id : undefined;
    const field = (await operate(ctx, 'createTableField', {
      params: { tableId: input.table_id },
      body: {
        name: input.name,
        type: input.type,
        options: {
          ...input.options,
          ...(input.choices
            ? { choices: input.choices.map((label) => ({ id: choiceId(), label })) }
            : {}),
        },
        ...(input.description ? { description: input.description } : {}),
        ...(after ? { afterId: after } : {}),
      },
    })) as TableField;
    return {
      data: { field_id: field.id, name: field.name, type: field.type },
      target: { type: 'table', id: table.id, label: `${table.name} · ${field.name}` },
      summary: `${table.name} · ${field.name}`,
      undo: {
        kind: 'api_call',
        operation: 'deleteTableField',
        params: { tableId: table.id, fieldId: field.id },
      },
    };
  },
});

export const updateTableField = defineTool({
  name: 'update_table_field',
  title: 'Update table field',
  description:
    'Renames a field, changes its type or description, or sets its choices (existing choices keep their values by label; new labels are added, missing ones removed).',
  scope: 'tables:write',
  module: 'tables',
  write: true,
  approval: null,
  annotations: { readOnly: false, destructive: false, idempotent: true },
  input: z.object({
    table_id: z.uuid(),
    field: z.string().min(1).max(120).describe('Field id or name'),
    name: z.string().trim().min(1).max(120).optional(),
    type: TableFieldType.optional(),
    choices: Choices,
    options: Options,
    description: z.string().max(500).nullable().optional(),
  }),
  example: {
    table_id: '0192f1c4-0000-7000-8000-000000000000',
    field: 'Aşama',
    choices: ['Aday', 'Teklif', 'Kazanıldı', 'Kaybedildi'],
  },
  async run(ctx, input) {
    const table = await fieldsOf(ctx, input.table_id);
    const field = fieldByName(table.fields, input.field);
    const existing = new Map((field.options.choices ?? []).map((c) => [c.label, c]));
    const options =
      input.choices || input.options
        ? {
            ...field.options,
            ...input.options,
            ...(input.choices
              ? {
                  choices: input.choices.map(
                    (label) => existing.get(label) ?? { id: choiceId(), label },
                  ),
                }
              : {}),
          }
        : undefined;
    const updated = (await operate(ctx, 'updateTableField', {
      params: { tableId: table.id, fieldId: field.id },
      body: {
        ...(input.name ? { name: input.name } : {}),
        ...(input.type ? { type: input.type } : {}),
        ...(options ? { options } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      },
    })) as TableField;
    return {
      data: {
        field_id: updated.id,
        name: updated.name,
        type: updated.type,
        choices: updated.options.choices?.map((c) => c.label) ?? null,
      },
      target: { type: 'table', id: table.id, label: `${table.name} · ${updated.name}` },
      summary: `${table.name} · ${updated.name}`,
    };
  },
});

export const createTableView = defineTool({
  name: 'create_table_view',
  title: 'Create table view',
  description:
    'Adds a saved view to a table: grid, kanban (grouped by a single-select field), calendar or timeline (by a date field), gallery. Filters and sorts go in config with field ids from list_tables.',
  scope: 'tables:write',
  module: 'tables',
  write: true,
  approval: null,
  annotations: { readOnly: false, destructive: false, idempotent: false },
  input: z.object({
    table_id: z.uuid(),
    name: z.string().trim().min(1).max(120),
    type: TableViewType,
    kanban_field: z.string().max(120).optional().describe('kanban: single-select field id or name'),
    date_field: z.string().max(120).optional().describe('calendar/timeline: date field id or name'),
    hidden_fields: z.array(z.string().max(120)).max(100).optional(),
    config: ViewConfigPatch.optional().describe('Filters, sorts, grouping (field ids)'),
  }),
  example: {
    table_id: '0192f1c4-0000-7000-8000-000000000000',
    name: 'Satış hunisi',
    type: 'kanban',
    kanban_field: 'Aşama',
  },
  async run(ctx, input) {
    const table = await fieldsOf(ctx, input.table_id);
    const id = (name: string) => fieldByName(table.fields, name).id;
    const view = (await operate(ctx, 'createTableView', {
      params: { tableId: table.id },
      body: {
        name: input.name,
        type: input.type,
        config: {
          ...input.config,
          ...(input.kanban_field ? { kanbanFieldId: id(input.kanban_field) } : {}),
          ...(input.date_field ? { dateFieldId: id(input.date_field) } : {}),
          ...(input.hidden_fields ? { hidden: input.hidden_fields.map(id) } : {}),
        },
      },
    })) as { id: string; name: string; type: string };
    return {
      data: { view_id: view.id, name: view.name, type: view.type },
      target: { type: 'table', id: table.id, label: `${table.name} · ${view.name}` },
      summary: `${table.name} · ${view.name}`,
      undo: {
        kind: 'api_call',
        operation: 'deleteTableView',
        params: { tableId: table.id, viewId: view.id },
      },
    };
  },
});
