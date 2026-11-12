import { FormField, type FormFieldType, type FormStatus } from '@crewhall/shared';
import { type IconName } from '@crewhall/ui';
import { type MessageKey } from '@/lib/i18n/I18nContext';
import { newId } from '@/lib/ids';
import { readStorage, StorageKey, writeStorage } from '@/lib/storage';

/** Field types in palette order with their icons (builder and results). */
export const FIELD_TYPES: { type: FormFieldType; icon: IconName }[] = [
  { type: 'short_text', icon: 'text' },
  { type: 'long_text', icon: 'note' },
  { type: 'single_choice', icon: 'checkC' },
  { type: 'multi_choice', icon: 'todo' },
  { type: 'date', icon: 'calendar' },
  { type: 'number', icon: 'numbers' },
  { type: 'file', icon: 'upload' },
  { type: 'rating', icon: 'star' },
];

export const fieldIcon = (type: FormFieldType): IconName =>
  FIELD_TYPES.find((f) => f.type === type)?.icon ?? 'text';

/** Short id for fields and choices; unique within a form. */
export const shortId = (prefix: string) => `${prefix}_${newId().replace(/-/g, '').slice(0, 8)}`;

export const isChoice = (type: FormFieldType) =>
  type === 'single_choice' || type === 'multi_choice';

/** A new field of a type with a default label; choice fields start with two options. */
export function newField(
  type: FormFieldType,
  label: string,
  choiceLabel: (n: number) => string,
): FormField {
  return FormField.parse({
    id: shortId('f'),
    type,
    label,
    choices: isChoice(type) ? [1, 2].map((n) => ({ id: shortId('c'), label: choiceLabel(n) })) : [],
    max: type === 'rating' ? 5 : null,
  });
}

/** Changing the type keeps the label and drops what no longer applies. */
export function retype(field: FormField, type: FormFieldType, choiceLabel: (n: number) => string) {
  return FormField.parse({
    ...field,
    type,
    choices: isChoice(type)
      ? field.choices.length
        ? field.choices
        : [1, 2].map((n) => ({ id: shortId('c'), label: choiceLabel(n) }))
      : [],
    min: type === 'number' ? field.min : null,
    max: type === 'rating' ? (field.max ?? 5) : type === 'number' ? field.max : null,
  });
}

/** Moves `id` before or after another field; conditions pointing forward are dropped. */
export function reorder(fields: FormField[], fromId: string, toId: string): FormField[] {
  const from = fields.findIndex((f) => f.id === fromId);
  const to = fields.findIndex((f) => f.id === toId);
  if (from < 0 || to < 0 || from === to) return fields;
  const next = [...fields];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return withValidConditions(next);
}

/** A condition may only look at an earlier field. */
export function withValidConditions(fields: FormField[]): FormField[] {
  return fields.map((f, i) =>
    f.showIf && !fields.slice(0, i).some((x) => x.id === f.showIf!.fieldId)
      ? { ...f, showIf: null }
      : f,
  );
}

/** Random id this browser sends with public answers (one-answer limit, its uploads). */
export function browserToken(): string {
  const saved = readStorage(StorageKey.formClient);
  if (saved) return saved;
  const token = newId();
  writeStorage(StorageKey.formClient, token);
  return token;
}

/** Reads a File as `data:` URL for the upload endpoints. */
export function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

export const STATUS_KEY: Record<FormStatus, MessageKey> = {
  draft: 'forms.status.draft',
  open: 'forms.status.open',
  closed: 'forms.status.closed',
};

export interface PublishIssue {
  fieldId: string;
  kind: 'default_label' | 'default_choice' | 'no_choices';
}

/**
 * What still looks unfinished before publishing: a question left as its type's name
 * ("Kısa metin"), a choice left as "Seçenek 2", a choice field without choices.
 */
export function publishIssues(
  fields: FormField[],
  typeLabel: (type: FormFieldType) => string,
  choiceLabel: (n: number) => string,
): PublishIssue[] {
  const issues: PublishIssue[] = [];
  for (const f of fields) {
    if (f.label.trim() === typeLabel(f.type)) issues.push({ fieldId: f.id, kind: 'default_label' });
    if (isChoice(f.type)) {
      if (f.choices.length === 0) issues.push({ fieldId: f.id, kind: 'no_choices' });
      else if (f.choices.some((c, i) => c.label.trim() === choiceLabel(i + 1))) {
        issues.push({ fieldId: f.id, kind: 'default_choice' });
      }
    }
  }
  return issues;
}
