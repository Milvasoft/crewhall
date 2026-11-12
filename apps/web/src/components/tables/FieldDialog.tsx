import {
  FORMULA_FUNCTIONS,
  parseFormula,
  RollupFn,
  type TableField,
  type TableFieldOptions,
  type TableFieldType,
} from '@crewhall/shared';
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  Icon,
  IconButton,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
  toast,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { tableKeys, tablesQuery } from '@/lib/tables/api';
import { CHOICE_CLASS, CHOICE_COLORS, FIELD_TYPES, newChoiceId } from '@/lib/tables/fields';
import { useTableCtx } from './context';

/** Create or edit a field: name, type and the type's settings; delete for non-primary fields. */
export function FieldDialog({
  field,
  open,
  onClose,
}: {
  field: TableField | null;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { table } = useTableCtx();
  const [name, setName] = useState(field?.name ?? '');
  const [type, setType] = useState<TableFieldType>(field?.type ?? 'text');
  const [options, setOptions] = useState<TableFieldOptions>(field?.options ?? {});
  const [description, setDescription] = useState(field?.description ?? '');
  const set = (patch: Partial<TableFieldOptions>) => setOptions((o) => ({ ...o, ...patch }));
  const tables = useQuery({ ...tablesQuery(table.spaceId), enabled: type === 'relation' });
  const relationFields = table.fields.filter((f) => f.type === 'relation' && f.id !== field?.id);
  const relField = relationFields.find((f) => f.id === options.relationFieldId);
  const target = useQuery({
    queryKey: tableKeys.table(relField?.options.tableId ?? ''),
    queryFn: () => api.call('getTable', { params: { tableId: relField!.options.tableId! } }),
    enabled: Boolean(relField?.options.tableId) && (type === 'lookup' || type === 'rollup'),
  });
  let formulaError = false;
  if (type === 'formula' && options.formula) {
    try {
      parseFormula(options.formula);
    } catch {
      formulaError = true;
    }
  }

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: tableKeys.table(table.id) });
    void qc.invalidateQueries({ queryKey: tableKeys.rows(table.id) });
  };
  const save = useMutation({
    mutationFn: () =>
      field
        ? api.call('updateTableField', {
            params: { tableId: table.id, fieldId: field.id },
            body: { name: name.trim(), type, options, description: description || null },
          })
        : api.call('createTableField', {
            params: { tableId: table.id },
            body: { name: name.trim(), type, options, description: description || null },
          }),
    onSuccess: () => {
      refresh();
      onClose();
    },
    onError: (e) => toast(t(errorKey(e))),
  });
  const remove = useMutation({
    mutationFn: () => api.call('deleteTableField', { params: { tableId: table.id, fieldId: field!.id } }),
    onSuccess: () => {
      refresh();
      onClose();
    },
    onError: (e) => toast(t(errorKey(e))),
  });

  const choices = options.choices ?? [];
  const ready =
    name.trim() !== '' &&
    !formulaError &&
    (type !== 'relation' || Boolean(options.tableId)) &&
    ((type !== 'lookup' && type !== 'rollup') || Boolean(options.relationFieldId && options.targetFieldId));

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent width={520}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) save.mutate();
          }}
        >
          <DialogHeader icon="sliders" title={field ? t('tables.field.editTitle') : t('tables.field.newTitle')} />
          <Field label={t('tables.field.name')}>
            <Input autoFocus value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t('tables.field.type')}>
            <Select
              value={type}
              onValueChange={(v) => {
                setType(v as TableFieldType);
                setOptions(v === field?.type ? field.options : {});
              }}
            >
              <SelectTrigger size="sm" aria-label={t('tables.field.type')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FIELD_TYPES.map((ft) => (
                  <SelectItem key={ft.type} value={ft.type}>
                    {t(`tables.types.${ft.type}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {field && type !== field.type ? <p className="text-xs text-fg2">{t('tables.field.convertHint')}</p> : null}

          {type === 'single_select' || type === 'multi_select' ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-cap font-medium text-fg2">{t('tables.field.choices')}</span>
              {choices.map((c, i) => (
                <div key={c.id} className="flex items-center gap-1.5">
                  <button
                    type="button"
                    aria-label={t('tables.field.color')}
                    onClick={() =>
                      set({
                        choices: choices.map((x) =>
                          x.id === c.id ? { ...x, color: CHOICE_COLORS[(CHOICE_COLORS.indexOf(x.color) + 1) % CHOICE_COLORS.length]! } : x,
                        ),
                      })
                    }
                    className={cn('size-6 shrink-0 rounded-full', CHOICE_CLASS[c.color])}
                  />
                  <Input
                    className="h-9"
                    aria-label={t('tables.field.choiceN', { n: i + 1 })}
                    value={c.label}
                    onChange={(e) => set({ choices: choices.map((x) => (x.id === c.id ? { ...x, label: e.target.value } : x)) })}
                  />
                  <IconButton
                    size="sm"
                    tone="plain"
                    aria-label={t('tables.field.removeChoice', { name: c.label })}
                    onClick={() => set({ choices: choices.filter((x) => x.id !== c.id) })}
                  >
                    <Icon name="x" size={14} />
                  </IconButton>
                </div>
              ))}
              <Button
                type="button"
                size="xs"
                variant="gh"
                className="self-start"
                onClick={() =>
                  set({
                    choices: [
                      ...choices,
                      { id: newChoiceId(), label: t('tables.field.choiceN', { n: choices.length + 1 }), color: CHOICE_COLORS[choices.length % CHOICE_COLORS.length]! },
                    ],
                  })
                }
              >
                <Icon name="plus" size={14} />
                {t('tables.field.addChoice')}
              </Button>
            </div>
          ) : null}

          {type === 'number' || type === 'currency' || type === 'rollup' || type === 'formula' ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('tables.field.precision')}>
                <Select value={String(options.precision ?? (type === 'currency' ? 2 : 0))} onValueChange={(v) => set({ precision: Number(v) })}>
                  <SelectTrigger size="sm" aria-label={t('tables.field.precision')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[0, 1, 2, 3, 4].map((n) => (
                      <SelectItem key={n} value={String(n)}>
                        {n === 0 ? '1' : `1.${'0'.repeat(n)}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {type === 'currency' ? (
                <Field label={t('tables.field.currency')}>
                  <Select value={options.currency ?? 'TRY'} onValueChange={(v) => set({ currency: v })}>
                    <SelectTrigger size="sm" aria-label={t('tables.field.currency')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {['TRY', 'USD', 'EUR', 'GBP'].map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              ) : null}
            </div>
          ) : null}

          {type === 'date' ? (
            <label className="flex items-center justify-between gap-3 text-sm font-medium">
              {t('tables.field.includeTime')}
              <Switch checked={options.includeTime === true} onCheckedChange={(v) => set({ includeTime: v })} />
            </label>
          ) : null}
          {type === 'person' || type === 'relation' ? (
            <label className="flex items-center justify-between gap-3 text-sm font-medium">
              {t('tables.field.multiple')}
              <Switch
                checked={type === 'relation' ? options.multiple !== false : options.multiple === true}
                onCheckedChange={(v) => set({ multiple: v })}
              />
            </label>
          ) : null}
          {type === 'rating' ? (
            <Field label={t('tables.field.scale')}>
              <Select value={String(options.max ?? 5)} onValueChange={(v) => set({ max: Number(v) })}>
                <SelectTrigger size="sm" aria-label={t('tables.field.scale')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {`1-${n}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          {type === 'relation' ? (
            <Field label={t('tables.field.linkTo')}>
              <Select value={options.tableId ?? undefined} onValueChange={(v) => set({ tableId: v })}>
                <SelectTrigger size="sm" aria-label={t('tables.field.linkTo')}>
                  <SelectValue placeholder={t('tables.field.choose')} />
                </SelectTrigger>
                <SelectContent>
                  {(tables.data?.items ?? []).map((x) => (
                    <SelectItem key={x.id} value={x.id}>
                      {x.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          {type === 'lookup' || type === 'rollup' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('tables.field.through')}>
                <Select value={options.relationFieldId ?? undefined} onValueChange={(v) => set({ relationFieldId: v, targetFieldId: undefined })}>
                  <SelectTrigger size="sm" aria-label={t('tables.field.through')}>
                    <SelectValue placeholder={t('tables.field.choose')} />
                  </SelectTrigger>
                  <SelectContent>
                    {relationFields.map((f) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label={t('tables.field.target')}>
                <Select value={options.targetFieldId ?? undefined} disabled={!target.data} onValueChange={(v) => set({ targetFieldId: v })}>
                  <SelectTrigger size="sm" aria-label={t('tables.field.target')}>
                    <SelectValue placeholder={t('tables.field.choose')} />
                  </SelectTrigger>
                  <SelectContent>
                    {(target.data?.fields ?? []).map((f) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {relationFields.length === 0 ? <p className="text-xs text-fg3 sm:col-span-2">{t('tables.field.needRelation')}</p> : null}
              {type === 'rollup' ? (
                <Field label={t('tables.field.fn')}>
                  <Select value={options.fn ?? 'count'} onValueChange={(v) => set({ fn: v as RollupFn })}>
                    <SelectTrigger size="sm" aria-label={t('tables.field.fn')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {RollupFn.options.map((fn) => (
                        <SelectItem key={fn} value={fn}>
                          {t(`tables.rollup.${fn}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              ) : null}
            </div>
          ) : null}
          {type === 'formula' ? (
            <Field
              label={t('tables.field.formula')}
              error={formulaError ? t('errors.table_formula_invalid') : undefined}
              hint={`${t('tables.field.formulaHint')} ${FORMULA_FUNCTIONS.join(', ')}`}
            >
              <Textarea
                rows={3}
                className="font-mono text-[13px]"
                value={options.formula ?? ''}
                placeholder={t('tables.field.formulaPlaceholder')}
                onChange={(e) => set({ formula: e.target.value })}
              />
              <span className="flex flex-wrap gap-1">
                {table.fields
                  .filter((f) => f.id !== field?.id)
                  .map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => set({ formula: `${options.formula ?? ''}{${f.name}}` })}
                      className="rounded-md bg-bg2 px-1.5 py-0.5 font-mono text-[11.5px] text-fg2 hover:bg-capsule hover:text-fg"
                    >
                      {`{${f.name}}`}
                    </button>
                  ))}
              </span>
            </Field>
          ) : null}
          <Field label={t('tables.field.description')}>
            <Input value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <DialogFooter>
            {field && !field.primary ? (
              <Button type="button" variant="dng" className="mr-auto" loading={remove.isPending} onClick={() => remove.mutate()}>
                {t('tables.field.delete')}
              </Button>
            ) : null}
            <Button type="button" variant="gh" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button type="submit" variant="pri" disabled={!ready} loading={save.isPending}>
              {field ? t('tables.field.save') : t('tables.field.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
