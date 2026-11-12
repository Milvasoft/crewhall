import { z } from 'zod';
import { Id, Timestamp } from './common';
import { UserSummary } from './org';

/**
 * Forms and surveys (roadmap 16). A form belongs to a space: its editors build it and read the
 * results; it is answered inside the org (every member) or through a public link. Only the forms
 * session edits this file; see docs/contracts/moduller.md.
 */

export const FORM_LIMITS = {
  fields: 100,
  choices: 50,
  titleChars: 200,
  labelChars: 300,
  helpChars: 1000,
  shortTextChars: 500,
  longTextChars: 5000,
  /** One uploaded file (file field). */
  fileBytes: 10 * 1024 * 1024,
  filesPerField: 5,
  formsPerSpace: 500,
  ratingMax: 10,
  /** Public link: answers from one address per form in ten minutes. */
  publicSubmitsPerIp: 10,
  /** Public link: answers per form per minute, all addresses together. */
  publicSubmitsPerMinute: 120,
  /** Public link: uploads from one address in ten minutes. */
  publicUploadsPerIp: 30,
} as const;

export const FormFieldType = z.enum([
  'short_text',
  'long_text',
  'single_choice',
  'multi_choice',
  'date',
  'number',
  'file',
  'rating',
]);
export type FormFieldType = z.infer<typeof FormFieldType>;

const FieldId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);

export const FormChoice = z.object({
  id: FieldId,
  label: z.string().trim().min(1).max(FORM_LIMITS.labelChars),
});
export type FormChoice = z.infer<typeof FormChoice>;

/**
 * Simple conditional display: the field shows only when an earlier field's answer matches.
 * `equals` / `not_equals` compare a choice id or text; `includes` is for multiple choice;
 * `answered` / `not_answered` need no value.
 */
export const FormConditionOp = z.enum([
  'equals',
  'not_equals',
  'includes',
  'answered',
  'not_answered',
]);
export type FormConditionOp = z.infer<typeof FormConditionOp>;

export const FormCondition = z.object({
  fieldId: FieldId,
  op: FormConditionOp,
  value: z.string().max(FORM_LIMITS.shortTextChars).nullable().default(null),
});
export type FormCondition = z.infer<typeof FormCondition>;

export const FormField = z.object({
  id: FieldId,
  type: FormFieldType,
  label: z.string().trim().min(1).max(FORM_LIMITS.labelChars),
  help: z.string().max(FORM_LIMITS.helpChars).nullable().default(null),
  required: z.boolean().default(false),
  /** single_choice and multi_choice. */
  choices: z.array(FormChoice).max(FORM_LIMITS.choices).default([]),
  /** number: bounds; rating: `max` is the scale (3-10, default 5). */
  min: z.number().nullable().default(null),
  max: z.number().nullable().default(null),
  /** file: how many files one answer may carry (1-5). */
  maxFiles: z.number().int().min(1).max(FORM_LIMITS.filesPerField).default(1),
  showIf: FormCondition.nullable().default(null),
});
export type FormField = z.infer<typeof FormField>;
export type FormFieldInput = z.input<typeof FormField>;

export const FormAccess = z.enum(['org', 'public']);
export type FormAccess = z.infer<typeof FormAccess>;

export const FormStatus = z.enum(['draft', 'open', 'closed']);
export type FormStatus = z.infer<typeof FormStatus>;

/** Where each answer also lands besides the results page. */
export const FormDestinations = z.object({
  /** Keep a CSV table of all answers in the form's space ("<form> · Yanıtlar.csv"). */
  drive: z
    .object({ parentId: Id.nullable().default(null) })
    .nullable()
    .default(null),
  /** Open a card per answer on a board column; the title comes from a field or the form name. */
  board: z
    .object({ boardId: Id, columnId: Id, titleFieldId: FieldId.nullable().default(null) })
    .nullable()
    .default(null),
  /** Add a row per answer to a table; questions go to the fields of the same name. */
  table: z.object({ tableId: Id }).nullable().default(null),
});
export type FormDestinations = z.infer<typeof FormDestinations>;

export const FormSettings = z.object({
  access: FormAccess.default('org'),
  /** Respondents are not recorded (the one-answer limit still works through a keyed hash). */
  anonymous: z.boolean().default(false),
  /** One answer per person (org) or per browser (public link). */
  oneResponse: z.boolean().default(false),
  /** Shown after sending; null = the default thank-you text. */
  confirmation: z.string().max(FORM_LIMITS.helpChars).nullable().default(null),
  /** Bell notification to the form's owner on each answer. */
  notifyOnResponse: z.boolean().default(false),
  /** Stops taking answers at this time. */
  closesAt: Timestamp.nullable().default(null),
  destinations: FormDestinations.default({ drive: null, board: null, table: null }),
});
export type FormSettings = z.infer<typeof FormSettings>;
export type FormSettingsInput = z.input<typeof FormSettings>;

export const Form = z.object({
  id: Id,
  spaceId: Id,
  title: z.string(),
  description: z.string().nullable(),
  fields: z.array(FormField),
  settings: FormSettings,
  status: FormStatus,
  /** Public answer link; set while access is public. */
  publicUrl: z.url().nullable(),
  /** In-app answer path for org members: /form/<id>. */
  fillPath: z.string(),
  responseCount: z.number().int(),
  lastResponseAt: Timestamp.nullable(),
  /** The CSV table in Drive, once written. */
  driveNodeId: Id.nullable(),
  owner: UserSummary.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Form = z.infer<typeof Form>;

export const FormSummary = Form.pick({
  id: true,
  spaceId: true,
  title: true,
  status: true,
  responseCount: true,
  lastResponseAt: true,
  updatedAt: true,
}).extend({ access: FormAccess, fieldCount: z.number().int() });
export type FormSummary = z.infer<typeof FormSummary>;

export const CreateForm = z.object({
  title: z.string().trim().min(1).max(FORM_LIMITS.titleChars),
  description: z.string().max(FORM_LIMITS.helpChars).nullable().optional(),
  fields: z.array(FormField).max(FORM_LIMITS.fields).default([]),
});
export type CreateForm = z.input<typeof CreateForm>;

export const UpdateForm = z.object({
  title: z.string().trim().min(1).max(FORM_LIMITS.titleChars).optional(),
  description: z.string().max(FORM_LIMITS.helpChars).nullable().optional(),
  fields: z.array(FormField).max(FORM_LIMITS.fields).optional(),
  settings: FormSettings.optional(),
  status: FormStatus.optional(),
});
export type UpdateForm = z.input<typeof UpdateForm>;

/** An uploaded file waiting in an answer (file field). */
export const FormFile = z.object({
  fileId: Id,
  name: z.string().max(255),
  mime: z.string().max(200),
  sizeBytes: z.number().int().min(0),
});
export type FormFile = z.infer<typeof FormFile>;

export const UploadFormFile = z.object({
  fieldId: FieldId,
  name: z.string().trim().min(1).max(255),
  /** `data:<mime>;base64,…` */
  dataURL: z.string().max(Math.ceil((FORM_LIMITS.fileBytes * 4) / 3) + 300),
  /** Public link only: the browser's answer token (see SubmitFormResponse). */
  clientToken: z.string().max(100).optional(),
});

/**
 * One answer per field: text and date (`yyyy-MM-dd`) as strings, single choice as the choice
 * id, multiple choice as ids, number and rating as numbers, files as uploaded FormFiles.
 */
export const FormAnswer = z.union([
  z.string().max(FORM_LIMITS.longTextChars),
  z.number(),
  z.array(z.string().max(FORM_LIMITS.labelChars)).max(FORM_LIMITS.choices),
  z.array(FormFile).max(FORM_LIMITS.filesPerField),
  z.null(),
]);
export type FormAnswer = z.infer<typeof FormAnswer>;
export type FormAnswers = Record<string, FormAnswer>;

export const SubmitFormResponse = z.object({
  answers: z.record(FieldId, FormAnswer),
  /** Public link: a random id the browser keeps, for the one-answer limit. */
  clientToken: z.string().min(8).max(100).optional(),
  /** Honeypot: hidden in the UI, so a filled value means a bot. */
  website: z.string().max(500).optional(),
});
export type SubmitFormResponse = z.input<typeof SubmitFormResponse>;

export const SubmitFormResult = z.object({
  id: Id,
  confirmation: z.string().nullable(),
});

/** What a respondent sees. */
export const FormToFill = z.object({
  id: Id,
  title: z.string(),
  description: z.string().nullable(),
  fields: z.array(FormField),
  anonymous: z.boolean(),
  oneResponse: z.boolean(),
  /** The signed-in person already answered a one-answer form. */
  alreadyResponded: z.boolean(),
  /** Closed, past closesAt or still a draft: answers are refused. */
  accepting: z.boolean(),
  /** Org name for the public page header. */
  orgName: z.string(),
});
export type FormToFill = z.infer<typeof FormToFill>;

export const FormResponse = z.object({
  id: Id,
  /** null when the form is anonymous or answered through the public link. */
  respondent: UserSummary.nullable(),
  answers: z.record(z.string(), FormAnswer),
  submittedAt: Timestamp,
});
export type FormResponse = z.infer<typeof FormResponse>;

export const FormResponsesQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const FormFieldStats = z.object({
  fieldId: z.string(),
  type: FormFieldType,
  answered: z.number().int(),
  /** Choice fields: answers per choice id; rating: answers per value ("1".."10"). */
  counts: z.record(z.string(), z.number().int()),
  /** number and rating. */
  average: z.number().nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
});
export type FormFieldStats = z.infer<typeof FormFieldStats>;

export const FormStats = z.object({
  total: z.number().int(),
  /** Answers per day (UTC), last 30 days with at least one answer. */
  daily: z.array(z.object({ date: z.string(), count: z.number().int() })),
  fields: z.array(FormFieldStats),
});
export type FormStats = z.infer<typeof FormStats>;

export const FormFileUrl = z.object({ url: z.url(), expiresAt: Timestamp });

export const FormExportResult = z.object({ nodeId: Id, name: z.string() });

/** Non-JSON routes outside the endpoint table. */
export const FORMS_RAW_PATHS = {
  /** GET, session: all answers as CSV (UTF-8 with BOM, Excel friendly). */
  csv: '/api/v1/forms/:formId/responses.csv',
} as const;

/* ---------------------------------- helpers ---------------------------------- */

const isEmpty = (v: FormAnswer | undefined) =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/** Does a field show for these answers? Hidden fields are not asked and not stored. */
export function isFieldVisible(
  field: FormField,
  answers: FormAnswers,
  fields: readonly FormField[],
) {
  const cond = field.showIf;
  if (!cond) return true;
  const source = fields.find((f) => f.id === cond.fieldId);
  if (!source) return true;
  // A condition on a hidden field is false: the chain hides together.
  if (!isFieldVisible(source, answers, fields)) return false;
  const v = answers[cond.fieldId];
  switch (cond.op) {
    case 'answered':
      return !isEmpty(v);
    case 'not_answered':
      return isEmpty(v);
    case 'includes':
      return Array.isArray(v) && (v as unknown[]).includes(cond.value);
    case 'equals':
      return !isEmpty(v) && String(v) === cond.value;
    case 'not_equals':
      return isEmpty(v) || String(v) !== cond.value;
  }
}

export type FormAnswerError =
  | 'required'
  | 'invalid'
  | 'too_long'
  | 'too_small'
  | 'too_large'
  | 'unknown_choice'
  | 'too_many_files';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Checks one answer against its field; null when it is fine. */
export function answerError(field: FormField, v: FormAnswer | undefined): FormAnswerError | null {
  if (isEmpty(v)) return field.required ? 'required' : null;
  switch (field.type) {
    case 'short_text':
    case 'long_text': {
      if (typeof v !== 'string') return 'invalid';
      const limit =
        field.type === 'short_text' ? FORM_LIMITS.shortTextChars : FORM_LIMITS.longTextChars;
      if (field.required && v.trim() === '') return 'required';
      return v.length > limit ? 'too_long' : null;
    }
    case 'single_choice':
      if (typeof v !== 'string') return 'invalid';
      return field.choices.some((c) => c.id === v) ? null : 'unknown_choice';
    case 'multi_choice':
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return 'invalid';
      return (v as string[]).every((id) => field.choices.some((c) => c.id === id))
        ? null
        : 'unknown_choice';
    case 'date': {
      if (typeof v !== 'string' || !DATE_RE.test(v)) return 'invalid';
      const d = new Date(`${v}T00:00:00Z`);
      return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? 'invalid' : null;
    }
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) return 'invalid';
      if (field.min !== null && v < field.min) return 'too_small';
      if (field.max !== null && v > field.max) return 'too_large';
      return null;
    case 'rating': {
      if (typeof v !== 'number' || !Number.isInteger(v)) return 'invalid';
      if (v < 1) return 'too_small';
      return v > ratingScale(field) ? 'too_large' : null;
    }
    case 'file':
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'object' || x === null)) return 'invalid';
      return v.length > field.maxFiles ? 'too_many_files' : null;
  }
}

/** Rating scale of a field: `max` clamped to 3-10, default 5. */
export function ratingScale(field: Pick<FormField, 'max'>) {
  const n = field.max ?? 5;
  return Math.min(FORM_LIMITS.ratingMax, Math.max(3, Math.round(n)));
}

/**
 * Validates a whole answer set: unknown and hidden fields are dropped, visible ones checked.
 * Returns the cleaned answers and the errors per field id.
 */
export function checkAnswers(fields: readonly FormField[], answers: FormAnswers) {
  const clean: FormAnswers = {};
  const errors: Record<string, FormAnswerError> = {};
  for (const field of fields) {
    if (!isFieldVisible(field, answers, fields)) continue;
    const v = answers[field.id];
    const err = answerError(field, v);
    if (err) errors[field.id] = err;
    else if (!isEmpty(v))
      clean[field.id] = typeof v === 'string' && field.type !== 'long_text' ? v.trim() : v!;
  }
  return { clean, errors };
}

/** Problems in a form definition that the schema alone cannot see. */
export function formDefinitionIssues(fields: readonly FormField[]): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  fields.forEach((f, i) => {
    if (seen.has(f.id)) issues.push(`fields.${i}.id: duplicate`);
    seen.add(f.id);
    if ((f.type === 'single_choice' || f.type === 'multi_choice') && f.choices.length === 0) {
      issues.push(`fields.${i}.choices: empty`);
    }
    const ids = new Set<string>();
    f.choices.forEach((c, j) => {
      if (ids.has(c.id)) issues.push(`fields.${i}.choices.${j}.id: duplicate`);
      ids.add(c.id);
    });
    if (f.type === 'number' && f.min !== null && f.max !== null && f.min > f.max) {
      issues.push(`fields.${i}.min: above max`);
    }
    if (f.showIf) {
      const source = fields.findIndex((x) => x.id === f.showIf!.fieldId);
      if (source < 0 || source >= i)
        issues.push(`fields.${i}.showIf: must point to an earlier field`);
    }
  });
  return issues;
}

/** Answer as plain text for tables, CSV and cards; choice ids become labels. */
export function answerText(field: FormField, v: FormAnswer | undefined): string {
  if (isEmpty(v)) return '';
  const label = (id: string) => field.choices.find((c) => c.id === id)?.label ?? id;
  switch (field.type) {
    case 'single_choice':
      return label(String(v));
    case 'multi_choice':
      return (v as string[]).map(label).join(', ');
    case 'file':
      return (v as FormFile[]).map((f) => f.name).join(', ');
    default:
      return String(v);
  }
}
