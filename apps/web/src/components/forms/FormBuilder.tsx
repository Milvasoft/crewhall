import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  FORM_LIMITS,
  ratingScale,
  type FormConditionOp,
  type FormField,
  type FormFieldType,
} from '@crewhall/shared';
import {
  Button,
  cn,
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
  Tag,
  Textarea,
} from '@crewhall/ui';
import { useState, type ReactNode } from 'react';
import {
  FIELD_TYPES,
  fieldIcon,
  isChoice,
  newField,
  reorder,
  retype,
  shortId,
  withValidConditions,
} from '@/lib/forms/fields';
import { useI18n } from '@/lib/i18n/I18nContext';

const NEW_PREFIX = 'new:';
const CANVAS = 'canvas';

/**
 * Drag-and-drop form builder (roadmap 16): the field palette, the field list (drag to order,
 * or drop a new field from the palette) and the selected field's editor. Keyboard: the grip
 * starts a drag with Space, arrows move, Space drops; the move buttons do the same.
 */
export function FormBuilder({
  fields,
  onChange,
  selectedId,
  onSelect,
  readOnly,
}: {
  fields: FormField[];
  onChange: (fields: FormField[]) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  readOnly?: boolean;
}) {
  const { t } = useI18n();
  const [dragging, setDragging] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space'] },
    }),
  );
  const typeLabel = (type: FormFieldType) => t(`forms.types.${type}`);
  const choiceLabel = (n: number) => t('forms.builder.choiceN', { n });
  const full = fields.length >= FORM_LIMITS.fields;

  const add = (type: FormFieldType, at?: number) => {
    if (full) return;
    const f = newField(type, typeLabel(type), choiceLabel);
    const index =
      at ?? (selectedId ? fields.findIndex((x) => x.id === selectedId) + 1 : fields.length);
    const next = [...fields];
    next.splice(index < 0 ? fields.length : index, 0, f);
    onChange(next);
    onSelect(f.id);
  };
  const update = (f: FormField) =>
    onChange(withValidConditions(fields.map((x) => (x.id === f.id ? f : x))));
  const remove = (id: string) => {
    onChange(withValidConditions(fields.filter((x) => x.id !== id)));
    if (selectedId === id) onSelect(null);
  };
  const move = (id: string, by: -1 | 1) => {
    const i = fields.findIndex((x) => x.id === id);
    const target = fields[i + by];
    if (target) onChange(reorder(fields, id, target.id));
  };
  const duplicate = (f: FormField) => {
    const copy: FormField = {
      ...f,
      id: shortId('f'),
      label: t('forms.builder.copyOf', { label: f.label }).slice(0, FORM_LIMITS.labelChars),
      choices: f.choices.map((c) => ({ ...c, id: shortId('c') })),
    };
    const i = fields.findIndex((x) => x.id === f.id);
    const next = [...fields];
    next.splice(i + 1, 0, copy);
    onChange(next);
    onSelect(copy.id);
  };

  const onDragStart = (e: DragStartEvent) => setDragging(String(e.active.id));
  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    const active = String(e.active.id);
    const over = e.over ? String(e.over.id) : null;
    if (!over) return;
    if (active.startsWith(NEW_PREFIX)) {
      const type = active.slice(NEW_PREFIX.length) as FormFieldType;
      const at = over === CANVAS ? fields.length : fields.findIndex((f) => f.id === over);
      add(type, at < 0 ? fields.length : at);
      return;
    }
    if (over !== CANVAS && over !== active) onChange(reorder(fields, active, over));
  };
  const labelOf = (id: string | number) => {
    const s = String(id);
    if (s.startsWith(NEW_PREFIX)) return typeLabel(s.slice(NEW_PREFIX.length) as FormFieldType);
    return fields.find((f) => f.id === s)?.label ?? '';
  };
  const announcements: Announcements = {
    onDragStart: ({ active }) => t('forms.dnd.picked', { label: labelOf(active.id) }),
    onDragOver: ({ active, over }) =>
      over
        ? t('forms.dnd.over', { label: labelOf(active.id), target: labelOf(over.id) })
        : undefined,
    onDragEnd: ({ active, over }) =>
      over ? t('forms.dnd.dropped', { label: labelOf(active.id) }) : t('forms.dnd.cancelled'),
    onDragCancel: () => t('forms.dnd.cancelled'),
  };
  const selected = fields.find((f) => f.id === selectedId) ?? null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      accessibility={{
        announcements,
        screenReaderInstructions: { draggable: t('forms.dnd.instructions') },
      }}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragging(null)}
    >
      <div className="grid gap-4 lg:grid-cols-[200px_minmax(0,1fr)] xl:grid-cols-[200px_minmax(0,1fr)_320px]">
        {!readOnly ? (
          <aside
            aria-label={t('forms.builder.palette')}
            className="flex flex-col gap-1.5 lg:sticky lg:top-0 lg:self-start"
          >
            <span className="eyebrow px-1">{t('forms.builder.palette')}</span>
            <div className="grid grid-cols-2 gap-1.5 lg:grid-cols-1">
              {FIELD_TYPES.map((ft) => (
                <PaletteItem
                  key={ft.type}
                  type={ft.type}
                  label={typeLabel(ft.type)}
                  icon={ft.icon}
                  disabled={full}
                  onAdd={() => add(ft.type)}
                />
              ))}
            </div>
            <p className="px-1 text-xs text-fg3">{t('forms.builder.paletteHint')}</p>
          </aside>
        ) : null}
        <Canvas empty={fields.length === 0} readOnly={readOnly}>
          <SortableContext items={fields.map((f) => f.id)} strategy={verticalListSortingStrategy}>
            {fields.map((f, i) => (
              <FieldCard
                key={f.id}
                field={f}
                index={i}
                count={fields.length}
                typeLabel={typeLabel(f.type)}
                selected={f.id === selectedId}
                readOnly={readOnly}
                onSelect={() => onSelect(f.id)}
                onMove={(by) => move(f.id, by)}
                onDuplicate={() => duplicate(f)}
                onRemove={() => remove(f.id)}
              >
                {f.id === selectedId && !readOnly ? (
                  <div className="xl:hidden">
                    <FieldEditor field={f} fields={fields} onChange={update} />
                  </div>
                ) : null}
              </FieldCard>
            ))}
          </SortableContext>
        </Canvas>
        <aside
          aria-label={t('forms.builder.fieldSettings')}
          className="hidden flex-col gap-3 rounded-2xl bg-surface p-4 shadow-[0_0_0_1px_var(--line)] xl:sticky xl:top-0 xl:flex xl:self-start"
        >
          {selected && !readOnly ? (
            <FieldEditor field={selected} fields={fields} onChange={update} />
          ) : (
            <p className="text-sm text-fg3">{t('forms.builder.selectHint')}</p>
          )}
        </aside>
      </div>
      <DragOverlay dropAnimation={{ duration: 160, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }}>
        {dragging ? (
          <div className="flex items-center gap-2 rounded-xl bg-surface px-3 py-2.5 text-sm font-semibold shadow-[0_0_0_1px_var(--line2),var(--shMd)]">
            <Icon
              name={
                dragging.startsWith(NEW_PREFIX)
                  ? fieldIcon(dragging.slice(NEW_PREFIX.length) as FormFieldType)
                  : fieldIcon(fields.find((f) => f.id === dragging)?.type ?? 'short_text')
              }
              size={16}
            />
            {labelOf(dragging)}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function PaletteItem({
  type,
  label,
  icon,
  disabled,
  onAdd,
}: {
  type: FormFieldType;
  label: string;
  icon: Parameters<typeof Icon>[0]['name'];
  disabled?: boolean;
  onAdd: () => void;
}) {
  const { t } = useI18n();
  const { setNodeRef, attributes, listeners, isDragging } = useDraggable({
    id: `${NEW_PREFIX}${type}`,
    disabled,
  });
  return (
    <button
      ref={setNodeRef}
      type="button"
      {...attributes}
      {...listeners}
      onClick={onAdd}
      disabled={disabled}
      aria-label={t('forms.builder.addField', { type: label })}
      className={cn(
        'flex h-10 cursor-grab items-center gap-2.5 rounded-lg bg-surface px-3 text-left text-[13.5px] font-medium text-fg shadow-[0_0_0_1px_var(--line)] hover:shadow-[0_0_0_1px_var(--line2)] disabled:cursor-default disabled:opacity-50',
        isDragging && 'opacity-40',
      )}
    >
      <Icon name={icon} size={16} className="text-fg2" />
      <span className="truncate">{label}</span>
    </button>
  );
}

function Canvas({
  empty,
  readOnly,
  children,
}: {
  empty: boolean;
  readOnly?: boolean;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const { setNodeRef, isOver } = useDroppable({ id: CANVAS });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex min-h-[240px] flex-col gap-2 rounded-2xl p-1 transition-shadow',
        isOver && 'shadow-[0_0_0_2px_var(--accent)]',
      )}
    >
      {children}
      {empty ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-line2 p-8 text-center">
          <Icon name="plus" size={22} className="text-fg3" />
          <p className="text-sm font-semibold text-fg">{t('forms.builder.emptyTitle')}</p>
          {!readOnly ? <p className="text-xs text-fg3">{t('forms.builder.emptyBody')}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function FieldCard({
  field,
  index,
  count,
  typeLabel,
  selected,
  readOnly,
  onSelect,
  onMove,
  onDuplicate,
  onRemove,
  children,
}: {
  field: FormField;
  index: number;
  count: number;
  typeLabel: string;
  selected: boolean;
  readOnly?: boolean;
  onSelect: () => void;
  onMove: (by: -1 | 1) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: field.id,
    disabled: readOnly,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'flex flex-col gap-3 rounded-2xl bg-surface p-3 shadow-[0_0_0_1px_var(--line)]',
        selected && 'shadow-[0_0_0_2px_var(--fg)]',
        isDragging && 'opacity-40',
      )}
    >
      {/* The whole row selects the field (B7); its own buttons keep their action. */}
      <div
        className="flex cursor-pointer items-center gap-2"
        onClick={(e) => {
          const target = e.target as HTMLElement;
          if (target.closest('button') && !target.closest('[data-row-select]')) return;
          onSelect();
        }}
      >
        {!readOnly ? (
          <button
            type="button"
            {...attributes}
            {...listeners}
            aria-label={t('forms.builder.dragField', { label: field.label })}
            className="flex size-8 shrink-0 cursor-grab items-center justify-center rounded-md text-fg3 hover:bg-bg2 hover:text-fg"
          >
            <Icon name="grip" size={16} />
          </button>
        ) : null}
        <button
          type="button"
          data-row-select
          aria-pressed={selected}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-1 py-1 text-left"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-bg2">
            <Icon name={fieldIcon(field.type)} size={16} />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[14.5px] font-semibold text-fg">
              {field.label}
              {field.required ? <span className="ml-1 text-danger">*</span> : null}
            </span>
            <span className="flex flex-wrap items-center gap-1.5 text-xs text-fg3">
              {typeLabel}
              {field.showIf ? (
                <Tag className="h-5 px-1.5 text-[11px]">
                  <Icon name="filter" size={11} />
                  {t('forms.builder.conditional')}
                </Tag>
              ) : null}
            </span>
          </span>
        </button>
        {!readOnly ? (
          <span className="flex shrink-0 items-center">
            <IconButton
              size="sm"
              tone="plain"
              aria-label={t('forms.builder.moveUp')}
              disabled={index === 0}
              onClick={() => onMove(-1)}
            >
              <Icon name="chevU" size={15} />
            </IconButton>
            <IconButton
              size="sm"
              tone="plain"
              aria-label={t('forms.builder.moveDown')}
              disabled={index === count - 1}
              onClick={() => onMove(1)}
            >
              <Icon name="chevD" size={15} />
            </IconButton>
            <IconButton
              size="sm"
              tone="plain"
              aria-label={t('forms.builder.duplicate')}
              onClick={onDuplicate}
            >
              <Icon name="copy" size={15} />
            </IconButton>
            <IconButton
              size="sm"
              tone="plain"
              aria-label={t('forms.builder.remove', { label: field.label })}
              onClick={onRemove}
            >
              <Icon name="trash" size={15} />
            </IconButton>
          </span>
        ) : null}
      </div>
      {children}
    </div>
  );
}

const OPS: FormConditionOp[] = ['equals', 'not_equals', 'includes', 'answered', 'not_answered'];

/** Label, help, required, type, choices, bounds and the show condition of one field. */
export function FieldEditor({
  field,
  fields,
  onChange,
}: {
  field: FormField;
  fields: FormField[];
  onChange: (f: FormField) => void;
}) {
  const { t } = useI18n();
  const set = (patch: Partial<FormField>) => onChange({ ...field, ...patch });
  const choiceLabel = (n: number) => t('forms.builder.choiceN', { n });
  const earlier = fields
    .slice(
      0,
      fields.findIndex((f) => f.id === field.id),
    )
    .filter((f) => f.type !== 'file');
  const cond = field.showIf;
  const source = cond ? fields.find((f) => f.id === cond.fieldId) : undefined;
  const ops = source
    ? OPS.filter((op) =>
        op === 'includes'
          ? source.type === 'multi_choice'
          : source.type !== 'multi_choice' || op !== 'equals',
      )
    : OPS;

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sub font-semibold">{t('forms.builder.fieldSettings')}</h2>
      <Field label={t('forms.builder.label')}>
        <Input
          value={field.label}
          maxLength={FORM_LIMITS.labelChars}
          onChange={(e) => set({ label: e.target.value })}
          invalid={field.label.trim() === ''}
        />
      </Field>
      <Field label={t('forms.builder.help')}>
        <Textarea
          rows={2}
          className="min-h-[64px]"
          value={field.help ?? ''}
          maxLength={FORM_LIMITS.helpChars}
          onChange={(e) => set({ help: e.target.value || null })}
        />
      </Field>
      <Field label={t('forms.builder.type')}>
        <Select
          value={field.type}
          onValueChange={(v) => onChange(retype(field, v as FormFieldType, choiceLabel))}
        >
          <SelectTrigger size="sm" aria-label={t('forms.builder.type')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FIELD_TYPES.map((ft) => (
              <SelectItem key={ft.type} value={ft.type}>
                {t(`forms.types.${ft.type}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <label className="flex items-center justify-between gap-3 text-sm font-medium text-fg">
        {t('forms.builder.required')}
        <Switch checked={field.required} onCheckedChange={(v) => set({ required: v })} />
      </label>

      {isChoice(field.type) ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-cap font-medium text-fg2">{t('forms.builder.choices')}</span>
          {field.choices.map((c, i) => (
            <div key={c.id} className="flex items-center gap-1">
              <Input
                className="h-9"
                aria-label={t('forms.builder.choiceN', { n: i + 1 })}
                value={c.label}
                maxLength={FORM_LIMITS.labelChars}
                invalid={c.label.trim() === ''}
                onChange={(e) =>
                  set({
                    choices: field.choices.map((x) =>
                      x.id === c.id ? { ...x, label: e.target.value } : x,
                    ),
                  })
                }
              />
              <IconButton
                size="sm"
                tone="plain"
                aria-label={t('forms.builder.removeChoice', { label: c.label })}
                disabled={field.choices.length <= 1}
                onClick={() => set({ choices: field.choices.filter((x) => x.id !== c.id) })}
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
            disabled={field.choices.length >= FORM_LIMITS.choices}
            onClick={() =>
              set({
                choices: [
                  ...field.choices,
                  { id: shortId('c'), label: choiceLabel(field.choices.length + 1) },
                ],
              })
            }
          >
            <Icon name="plus" size={14} />
            {t('forms.builder.addChoice')}
          </Button>
        </div>
      ) : null}

      {field.type === 'number' ? (
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('forms.builder.min')}>
            <Input
              type="number"
              value={field.min ?? ''}
              onChange={(e) => set({ min: e.target.value === '' ? null : Number(e.target.value) })}
            />
          </Field>
          <Field label={t('forms.builder.max')}>
            <Input
              type="number"
              value={field.max ?? ''}
              onChange={(e) => set({ max: e.target.value === '' ? null : Number(e.target.value) })}
            />
          </Field>
        </div>
      ) : null}
      {field.type === 'rating' ? (
        <Field label={t('forms.builder.scale')}>
          <Select value={String(ratingScale(field))} onValueChange={(v) => set({ max: Number(v) })}>
            <SelectTrigger size="sm" aria-label={t('forms.builder.scale')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {t('forms.builder.scaleN', { n })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      ) : null}
      {field.type === 'file' ? (
        <Field label={t('forms.builder.maxFiles')}>
          <Select
            value={String(field.maxFiles)}
            onValueChange={(v) => set({ maxFiles: Number(v) })}
          >
            <SelectTrigger size="sm" aria-label={t('forms.builder.maxFiles')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[1, 2, 3, 4, 5].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      ) : null}

      <div className="flex flex-col gap-2 border-t border-line pt-3">
        <label className="flex items-center justify-between gap-3 text-sm font-medium text-fg">
          {t('forms.builder.showIf')}
          <Switch
            checked={Boolean(cond)}
            disabled={earlier.length === 0}
            onCheckedChange={(on) =>
              set({
                showIf:
                  on && earlier[0]
                    ? { fieldId: earlier.at(-1)!.id, op: 'answered', value: null }
                    : null,
              })
            }
          />
        </label>
        {earlier.length === 0 ? (
          <p className="text-xs text-fg3">{t('forms.builder.showIfFirst')}</p>
        ) : null}
        {cond ? (
          <div className="flex flex-col gap-2">
            <Select
              value={cond.fieldId}
              onValueChange={(v) => set({ showIf: { fieldId: v, op: 'answered', value: null } })}
            >
              <SelectTrigger size="sm" aria-label={t('forms.builder.showIfField')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {earlier.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={cond.op}
              onValueChange={(v) => {
                const op = v as FormConditionOp;
                const needsValue = op !== 'answered' && op !== 'not_answered';
                set({
                  showIf: {
                    ...cond,
                    op,
                    value: needsValue ? (cond.value ?? source?.choices[0]?.id ?? '') : null,
                  },
                });
              }}
            >
              <SelectTrigger size="sm" aria-label={t('forms.builder.showIfOp')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ops.map((op) => (
                  <SelectItem key={op} value={op}>
                    {t(`forms.builder.ops.${op}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {cond.op !== 'answered' && cond.op !== 'not_answered' ? (
              source && isChoice(source.type) ? (
                <Select
                  value={cond.value ?? ''}
                  onValueChange={(v) => set({ showIf: { ...cond, value: v } })}
                >
                  <SelectTrigger size="sm" aria-label={t('forms.builder.showIfValue')}>
                    <SelectValue placeholder={t('forms.builder.showIfValue')} />
                  </SelectTrigger>
                  <SelectContent>
                    {source.choices.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  className="h-9"
                  aria-label={t('forms.builder.showIfValue')}
                  value={cond.value ?? ''}
                  onChange={(e) => set({ showIf: { ...cond, value: e.target.value } })}
                />
              )
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
