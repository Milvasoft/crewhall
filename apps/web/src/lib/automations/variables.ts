import { type AutomationAction, type AutomationTrigger } from '@crewhall/shared';
import { useQuery } from '@tanstack/react-query';
import { formQuery } from '@/lib/forms/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { tableQuery } from '@/lib/tables/api';
import { kindName, variableName } from './api';

export interface VariableOption {
  /** `{{path}}` inserted into templates; condition field. */
  path: string;
  /** What people read in the menu: "Kart başlığı", "Yanıt · Hangi ekiptesin?". */
  label: string;
}

/**
 * Variables a rule's templates and conditions can use, with readable names: the trigger's
 * paths, each question of the chosen form ("Yanıt · <soru>"), each field of the chosen table
 * ("Değer · <alan>") and the earlier steps' output.
 */
export function useVariables(
  trigger: AutomationTrigger,
  paths: string[],
  earlier: AutomationAction[] = [],
): VariableOption[] {
  const { t, locale } = useI18n();
  const formId =
    trigger.type === 'forms.response_submitted' && typeof trigger.config.formId === 'string'
      ? trigger.config.formId
      : '';
  const form = useQuery({ ...formQuery(formId), enabled: Boolean(formId) });
  const tableId =
    trigger.type.startsWith('tables.') && typeof trigger.config.tableId === 'string'
      ? trigger.config.tableId
      : '';
  const table = useQuery({ ...tableQuery(tableId), enabled: Boolean(tableId) });
  const base = paths.map((path) => ({ path, label: variableName(locale, path) }));
  const answers = (form.data?.fields ?? []).map((f) => ({
    path: `answers.${f.id}`,
    label: t('automations.editor.answerVariable', { name: f.label }),
  }));
  const values = (table.data?.fields ?? []).map((f) => ({
    path: `values.${f.id}`,
    label: t('automations.editor.valueVariable', { name: f.name }),
  }));
  const steps = earlier.map((a, i) => ({
    path: `steps.${a.id}`,
    label: t('automations.editor.stepVariable', {
      count: i + 1,
      name: kindName(locale, 'actions', a.type),
    }),
  }));
  return [...base, ...answers, ...values, ...steps];
}
