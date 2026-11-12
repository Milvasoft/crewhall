import {
  AUTOMATION_LIMITS,
  type AutomationAction,
  type AutomationCatalog,
  type AutomationCatalogEntry,
  type AutomationCondition,
  type AutomationTrigger,
  type ConditionOp,
} from '@crewhall/shared';
import {
  Button,
  Field,
  Icon,
  IconButton,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@crewhall/ui';
import { type ReactNode } from 'react';
import { kindDesc, kindName } from '@/lib/automations/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { newId } from '@/lib/ids';
import { useVariables } from '@/lib/automations/variables';
import { ConfigField } from './ConfigField';

export interface RuleDraft {
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  conditions: AutomationCondition[];
  actions: AutomationAction[];
}

const OPS: ConditionOp[] = [
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'gt',
  'lt',
  'exists',
  'not_exists',
];
const valueless = (op: ConditionOp) => op === 'exists' || op === 'not_exists';

/** Every required config field has a value. */
function complete(entry: AutomationCatalogEntry | undefined, config: Record<string, unknown>) {
  if (!entry) return false;
  return entry.fields.every((f) => {
    if (!f.required) return true;
    const v = config[f.key];
    return Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== '';
  });
}

export function draftReady(d: RuleDraft, catalog: AutomationCatalog | undefined) {
  if (!catalog || !d.name.trim() || d.actions.length === 0) return false;
  const trigger = catalog.triggers.find((x) => x.type === d.trigger.type);
  return (
    complete(trigger, d.trigger.config) &&
    d.actions.every((a) =>
      complete(
        catalog.actions.find((x) => x.type === a.type),
        a.config,
      ),
    ) &&
    d.conditions.every((c) => valueless(c.op) || (c.value ?? '') !== '')
  );
}

/**
 * "When → if → then" editor of a rule (design 6.6): the trigger with its settings, conditions
 * on the event and the ordered actions. Everything is described by the server's catalog.
 */
export function RuleEditor({
  draft,
  onChange,
  catalog,
  spaceId,
  readOnly,
}: {
  draft: RuleDraft;
  onChange: (d: RuleDraft) => void;
  catalog: AutomationCatalog;
  spaceId: string;
  readOnly?: boolean;
}) {
  const { t, locale } = useI18n();
  const trigger = catalog.triggers.find((x) => x.type === draft.trigger.type);
  // Every action may use all earlier steps; the last one's list covers them all.
  const variables = useVariables(draft.trigger, trigger?.variables ?? [], draft.actions);
  const forStep = (i: number) =>
    variables.filter(
      (v) =>
        !v.path.startsWith('steps.') ||
        draft.actions.slice(0, i).some((a) => v.path === `steps.${a.id}`),
    );
  const set = (patch: Partial<RuleDraft>) => onChange({ ...draft, ...patch });

  return (
    <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-end gap-4">
        <Field label={t('automations.editor.name')} className="min-w-[240px] flex-1">
          <Input
            value={draft.name}
            maxLength={AUTOMATION_LIMITS.nameChars}
            onChange={(e) => set({ name: e.target.value })}
            invalid={!draft.name.trim()}
          />
        </Field>
        <label className="flex h-11 items-center gap-3 text-sm font-semibold">
          {t('automations.editor.enabled')}
          <Switch checked={draft.enabled} onCheckedChange={(enabled) => set({ enabled })} />
        </label>
      </div>

      <Step n={1} title={t('automations.editor.when')}>
        <Field label={t('automations.editor.trigger')}>
          <Select
            value={draft.trigger.type || undefined}
            onValueChange={(type) => set({ trigger: { type, config: {} }, conditions: [] })}
          >
            <SelectTrigger aria-label={t('automations.editor.trigger')}>
              <SelectValue placeholder={t('automations.editor.choose')} />
            </SelectTrigger>
            <SelectContent>
              {catalog.triggers.map((x) => (
                <SelectItem key={x.type} value={x.type} disabled={!x.available}>
                  {kindName(locale, 'triggers', x.type)}
                  {!x.available
                    ? ` · ${t(x.unavailableReason === 'module_missing' ? 'automations.editor.soon' : 'automations.editor.moduleOff')}`
                    : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {trigger ? <Desc text={kindDesc(locale, 'triggers', trigger.type)} /> : null}
        {trigger?.fields.map((f) => (
          <ConfigField
            key={f.key}
            field={f}
            value={draft.trigger.config[f.key]}
            values={draft.trigger.config}
            spaceId={spaceId}
            variables={[]}
            onChange={(v) =>
              set({
                trigger: { ...draft.trigger, config: { ...draft.trigger.config, [f.key]: v } },
              })
            }
          />
        ))}
      </Step>

      <Step n={2} title={t('automations.editor.if')}>
        {draft.conditions.length === 0 ? (
          <p className="text-sm text-fg3">{t('automations.editor.noConditions')}</p>
        ) : null}
        {draft.conditions.map((c, i) => (
          <div
            key={i}
            className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_180px_1fr_auto]"
          >
            <Field label={t('automations.editor.field')}>
              <Input
                list={`vars-${spaceId}`}
                value={c.field}
                onChange={(e) =>
                  set({
                    conditions: draft.conditions.map((x, j) =>
                      j === i ? { ...x, field: e.target.value } : x,
                    ),
                  })
                }
              />
            </Field>
            <Field label={t('automations.editor.op')}>
              <Select
                value={c.op}
                onValueChange={(op) =>
                  set({
                    conditions: draft.conditions.map((x, j) =>
                      j === i
                        ? {
                            ...x,
                            op: op as ConditionOp,
                            value: valueless(op as ConditionOp) ? null : x.value,
                          }
                        : x,
                    ),
                  })
                }
              >
                <SelectTrigger size="sm" aria-label={t('automations.editor.op')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OPS.map((op) => (
                    <SelectItem key={op} value={op}>
                      {t(`automations.ops.${op}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t('automations.editor.value')}>
              <Input
                value={c.value ?? ''}
                disabled={valueless(c.op)}
                onChange={(e) =>
                  set({
                    conditions: draft.conditions.map((x, j) =>
                      j === i ? { ...x, value: e.target.value } : x,
                    ),
                  })
                }
              />
            </Field>
            <IconButton
              tone="plain"
              aria-label={t('automations.editor.removeCondition')}
              onClick={() => set({ conditions: draft.conditions.filter((_, j) => j !== i) })}
            >
              <Icon name="x" size={16} />
            </IconButton>
          </div>
        ))}
        <datalist id={`vars-${spaceId}`}>
          {variables
            .filter((v) => !v.path.startsWith('steps.'))
            .map((v) => (
              <option key={v.path} value={v.path} label={v.label} />
            ))}
        </datalist>
        {!readOnly ? (
          <Button
            type="button"
            size="xs"
            variant="gh"
            className="self-start"
            disabled={!trigger || draft.conditions.length >= AUTOMATION_LIMITS.conditionsPerRule}
            onClick={() =>
              set({
                conditions: [
                  ...draft.conditions,
                  { field: variables[0]?.path ?? '', op: 'equals', value: '' },
                ],
              })
            }
          >
            <Icon name="plus" size={14} />
            {t('automations.editor.addCondition')}
          </Button>
        ) : null}
      </Step>

      <Step n={3} title={t('automations.editor.then')}>
        {draft.actions.map((a, i) => {
          const entry = catalog.actions.find((x) => x.type === a.type);
          return (
            <section key={a.id} className="flex flex-col gap-3 rounded-xl bg-bg2 p-3">
              <header className="flex items-center gap-2">
                <span className="flex size-6 items-center justify-center rounded-full bg-surface text-xs font-bold">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 text-sm font-semibold">
                  {kindName(locale, 'actions', a.type)}
                </span>
                {entry && !entry.available ? (
                  <span className="text-xs text-danger">{t('automations.editor.moduleOff')}</span>
                ) : null}
                <IconButton
                  size="sm"
                  tone="plain"
                  aria-label={t('automations.editor.moveUp')}
                  disabled={i === 0}
                  onClick={() => {
                    const next = [...draft.actions];
                    [next[i - 1], next[i]] = [next[i]!, next[i - 1]!];
                    set({ actions: next });
                  }}
                >
                  <Icon name="chevU" size={15} />
                </IconButton>
                <IconButton
                  size="sm"
                  tone="plain"
                  aria-label={t('automations.editor.removeAction', {
                    name: kindName(locale, 'actions', a.type),
                  })}
                  onClick={() => set({ actions: draft.actions.filter((x) => x.id !== a.id) })}
                >
                  <Icon name="trash" size={15} />
                </IconButton>
              </header>
              {entry?.fields.map((f) => (
                <ConfigField
                  key={f.key}
                  field={f}
                  value={a.config[f.key]}
                  values={a.config}
                  spaceId={spaceId}
                  variables={forStep(i)}
                  onChange={(v) =>
                    set({
                      actions: draft.actions.map((x) =>
                        x.id === a.id ? { ...x, config: { ...x.config, [f.key]: v } } : x,
                      ),
                    })
                  }
                />
              ))}
            </section>
          );
        })}
        {!readOnly ? (
          <Menu>
            <MenuTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="out"
                className="self-start"
                disabled={draft.actions.length >= AUTOMATION_LIMITS.actionsPerRule}
              >
                <Icon name="plus" size={15} />
                {t('automations.editor.addAction')}
              </Button>
            </MenuTrigger>
            <MenuContent align="start">
              {catalog.actions.map((x) => (
                <MenuItem
                  key={x.type}
                  disabled={!x.available}
                  onSelect={() =>
                    set({
                      actions: [
                        ...draft.actions,
                        {
                          id: `a_${newId().replace(/-/g, '').slice(0, 8)}`,
                          type: x.type,
                          config: {},
                        },
                      ],
                    })
                  }
                >
                  {kindName(locale, 'actions', x.type)}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
        ) : null}
      </Step>
    </fieldset>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-2xl bg-surface p-4 shadow-[0_0_0_1px_var(--line)] md:p-5">
      <h2 className="flex items-center gap-2.5 text-sub font-semibold">
        <span className="flex size-7 items-center justify-center rounded-full bg-accent text-sm font-bold text-accent-fg">
          {n}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Desc({ text }: { text: string | null }) {
  return text ? <p className="text-sm text-fg2">{text}</p> : null;
}
