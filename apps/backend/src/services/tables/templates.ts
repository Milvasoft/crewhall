import { resources, type AppLocale } from '@crewhall/i18n';
import type {
  ChoiceColor,
  TableFieldOptions,
  TableFieldType,
  TableTemplate,
  TableViewType,
  ViewConfigInput,
} from '@crewhall/shared';

/**
 * Built-in table templates (CRM, inventory, hiring, assets): fields, views and a few sample rows.
 * Labels come from `email.tables.templates` in the org's language; keys tie fields, choices and
 * views together until ids exist.
 */

export interface TemplateField {
  key: string;
  type: TableFieldType;
  options?: TableFieldOptions;
  primary?: boolean;
  /** Choice keys with colors (labels from the dictionary). */
  choices?: [string, ChoiceColor][];
  /** Formula text with `{key}` placeholders resolved to field names. */
  formula?: string;
}

export interface TemplateView {
  key: string;
  type: TableViewType;
  /** Field keys stand where field ids go; the builder swaps them. */
  config?: ViewConfigInput;
}

export interface BuiltTemplate {
  fields: (Omit<TemplateField, 'choices' | 'formula'> & {
    name: string;
    options: TableFieldOptions;
  })[];
  views: (TemplateView & { name: string })[];
  rows: Record<string, unknown>[];
}

const DEFS: Record<TableTemplate, { fields: TemplateField[]; views: TemplateView[] }> = {
  empty: {
    fields: [
      { key: 'name', type: 'text', primary: true },
      { key: 'notes', type: 'long_text' },
      {
        key: 'status',
        type: 'single_select',
        choices: [
          ['todo', 'gray'],
          ['doing', 'yellow'],
          ['done', 'green'],
        ],
      },
    ],
    views: [{ key: 'grid', type: 'grid' }],
  },
  crm: {
    fields: [
      { key: 'name', type: 'text', primary: true },
      { key: 'contact', type: 'text' },
      { key: 'email', type: 'email' },
      { key: 'phone', type: 'phone' },
      {
        key: 'stage',
        type: 'single_select',
        choices: [
          ['lead', 'gray'],
          ['contacted', 'blue'],
          ['proposal', 'yellow'],
          ['won', 'green'],
          ['lost', 'red'],
        ],
      },
      { key: 'value', type: 'currency', options: { currency: 'TRY', precision: 0 } },
      { key: 'owner', type: 'person', options: { multiple: false } },
      { key: 'next', type: 'date' },
      { key: 'notes', type: 'long_text' },
    ],
    views: [
      { key: 'grid', type: 'grid' },
      { key: 'kanban', type: 'kanban', config: { kanbanFieldId: 'stage' } },
      { key: 'calendar', type: 'calendar', config: { dateFieldId: 'next' } },
    ],
  },
  inventory: {
    fields: [
      { key: 'name', type: 'text', primary: true },
      { key: 'sku', type: 'text' },
      {
        key: 'category',
        type: 'single_select',
        choices: [
          ['hardware', 'blue'],
          ['supplies', 'teal'],
          ['office', 'purple'],
        ],
      },
      { key: 'quantity', type: 'number', options: { precision: 0 } },
      { key: 'min', type: 'number', options: { precision: 0 } },
      { key: 'unitPrice', type: 'currency', options: { currency: 'TRY', precision: 2 } },
      {
        key: 'total',
        type: 'formula',
        formula: '{quantity} * {unitPrice}',
        options: { precision: 2 },
      },
      { key: 'status', type: 'formula', formula: 'IF({quantity} < {min}, "@reorder", "@enough")' },
      { key: 'location', type: 'text' },
      { key: 'photo', type: 'attachment' },
    ],
    views: [
      { key: 'grid', type: 'grid' },
      { key: 'gallery', type: 'gallery', config: { coverFieldId: 'photo' } },
      {
        key: 'low',
        type: 'grid',
        config: { filters: [{ fieldId: 'status', op: 'is', value: '@reorder' }] },
      },
    ],
  },
  hiring: {
    fields: [
      { key: 'name', type: 'text', primary: true },
      {
        key: 'role',
        type: 'single_select',
        choices: [
          ['engineering', 'blue'],
          ['design', 'pink'],
          ['sales', 'orange'],
        ],
      },
      {
        key: 'stage',
        type: 'single_select',
        choices: [
          ['applied', 'gray'],
          ['screen', 'blue'],
          ['technical', 'purple'],
          ['offer', 'yellow'],
          ['hired', 'green'],
          ['rejected', 'red'],
        ],
      },
      { key: 'email', type: 'email' },
      { key: 'phone', type: 'phone' },
      { key: 'cv', type: 'attachment' },
      { key: 'rating', type: 'rating', options: { max: 5 } },
      { key: 'interviewer', type: 'person', options: { multiple: true } },
      { key: 'interview', type: 'date', options: { includeTime: true } },
      {
        key: 'source',
        type: 'single_select',
        choices: [
          ['linkedin', 'blue'],
          ['referral', 'green'],
          ['careers', 'teal'],
        ],
      },
    ],
    views: [
      { key: 'kanban', type: 'kanban', config: { kanbanFieldId: 'stage' } },
      { key: 'grid', type: 'grid' },
      { key: 'calendar', type: 'calendar', config: { dateFieldId: 'interview' } },
    ],
  },
  assets: {
    fields: [
      { key: 'name', type: 'text', primary: true },
      { key: 'tag', type: 'text' },
      {
        key: 'type',
        type: 'single_select',
        choices: [
          ['laptop', 'blue'],
          ['monitor', 'teal'],
          ['phone', 'purple'],
          ['furniture', 'orange'],
        ],
      },
      { key: 'assignee', type: 'person', options: { multiple: false } },
      { key: 'purchased', type: 'date' },
      { key: 'price', type: 'currency', options: { currency: 'TRY', precision: 0 } },
      { key: 'warranty', type: 'date' },
      {
        key: 'status',
        type: 'single_select',
        choices: [
          ['inUse', 'green'],
          ['stored', 'gray'],
          ['broken', 'red'],
          ['retired', 'pink'],
        ],
      },
      { key: 'serial', type: 'text' },
      { key: 'age', type: 'formula', formula: 'DATEDIFF(TODAY(), {purchased}, "months")' },
    ],
    views: [
      { key: 'grid', type: 'grid' },
      { key: 'byStatus', type: 'grid', config: { groupBy: 'status' } },
      {
        key: 'timeline',
        type: 'timeline',
        config: { dateFieldId: 'purchased', endDateFieldId: 'warranty' },
      },
    ],
  },
};

/** A template with labels in the given language (formulas refer to the localized field names). */
export function buildTemplate(template: TableTemplate, locale: AppLocale): BuiltTemplate {
  const def = DEFS[template];
  const t = resources[locale].email.tables.templates[template] as {
    fields: Record<string, string>;
    choices: Record<string, string>;
    views: Record<string, string>;
    rows: Record<string, unknown>[];
    formulaReorder?: string;
    formulaEnough?: string;
  };
  const words: Record<string, string> = {
    reorder: t.formulaReorder ?? '',
    enough: t.formulaEnough ?? '',
  };
  const fields = def.fields.map((f) => {
    const options: TableFieldOptions = { ...(f.options ?? {}) };
    if (f.choices) {
      options.choices = f.choices.map(([id, color]) => ({ id, label: t.choices[id] ?? id, color }));
    }
    if (f.formula) {
      options.formula = f.formula
        .replace(/\{(\w+)\}/g, (_, key: string) => `{${t.fields[key] ?? key}}`)
        .replace(/@(\w+)/g, (_, w: string) => words[w] ?? w);
    }
    return {
      key: f.key,
      type: f.type,
      primary: f.primary,
      name: t.fields[f.key] ?? f.key,
      options,
    };
  });
  const views = def.views.map((v) => {
    const config = v.config
      ? JSON.parse(
          JSON.stringify(v.config).replace(/"@(\w+)"/g, (_, w: string) =>
            JSON.stringify(words[w] ?? w),
          ),
        )
      : undefined;
    return { ...v, config, name: t.views[v.key] ?? v.key };
  });
  return { fields, views, rows: t.rows };
}
