import {
  type FilterOp,
  type TableField,
  type TableView,
  type ViewConfigInput,
  type ViewFilter,
} from '@crewhall/shared';
import {
  Button,
  Checkbox,
  Icon,
  IconButton,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Segmented,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@crewhall/ui';
import { type ReactNode } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import { exportUrl } from '@/lib/tables/api';
import { opNeedsValue, opsFor, viewFields } from '@/lib/tables/fields';
import { useTableCtx } from './context';

/**
 * Above a view: search, filter (and/or), sort, group, hidden fields; export and import. Changes
 * are saved on the view, so everyone sees the same view.
 */
export function ViewToolbar({
  view,
  q,
  onQ,
  onUpdateView,
  onImport,
  total,
}: {
  view: TableView;
  q: string;
  onQ: (q: string) => void;
  onUpdateView: (config: ViewConfigInput) => void;
  onImport: () => void;
  total: number;
}) {
  const { t } = useI18n();
  const { table, canEdit, addRow } = useTableCtx();
  const c = view.config;
  const fields = viewFields(table.fields, view, true);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <div className="relative">
        <Icon name="search" size={15} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg3" />
        <Input
          aria-label={t('tables.toolbar.search')}
          placeholder={t('tables.toolbar.search')}
          value={q}
          onChange={(e) => onQ(e.target.value)}
          className="h-8 w-[200px] pl-8 text-[13px]"
        />
      </div>
      <Panel
        icon="filter"
        label={t('tables.toolbar.filter')}
        count={c.filters.length}
        disabled={!canEdit}
      >
        <FilterEditor fields={fields} view={view} onUpdateView={onUpdateView} />
      </Panel>
      <Panel icon="sort" label={t('tables.toolbar.sort')} count={c.sorts.length} disabled={!canEdit}>
        <SortEditor fields={fields} view={view} onUpdateView={onUpdateView} />
      </Panel>
      {view.type === 'grid' ? (
        <Panel icon="layers" label={t('tables.toolbar.group')} count={c.groupBy ? 1 : 0} disabled={!canEdit}>
          <FieldPick
            label={t('tables.toolbar.groupBy')}
            fields={fields.filter((f) => !['attachment', 'long_text'].includes(f.type))}
            value={c.groupBy}
            onChange={(id) => onUpdateView({ groupBy: id })}
          />
        </Panel>
      ) : null}
      <Panel icon="eyeOff" label={t('tables.toolbar.fields')} count={c.hidden.length} disabled={!canEdit}>
        <div className="flex max-h-72 min-w-[220px] flex-col gap-1 overflow-y-auto">
          {fields
            .filter((f) => !f.primary)
            .map((f) => (
              <label key={f.id} className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-bg2">
                <Checkbox
                  checked={!c.hidden.includes(f.id)}
                  onCheckedChange={(on) =>
                    onUpdateView({ hidden: on === true ? c.hidden.filter((x) => x !== f.id) : [...c.hidden, f.id] })
                  }
                />
                {f.name}
              </label>
            ))}
        </div>
      </Panel>
      <span className="ml-auto text-xs text-fg3">{t('tables.toolbar.count', { count: total })}</span>
      <Menu>
        <MenuTrigger asChild>
          <IconButton size="sm" tone="plain" aria-label={t('tables.toolbar.more')}>
            <Icon name="dots" size={16} />
          </IconButton>
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem asChild>
            <a href={exportUrl(table.id, view.id, 'csv')} download>
              <Icon name="download" size={14} />
              {t('tables.toolbar.exportCsv')}
            </a>
          </MenuItem>
          <MenuItem asChild>
            <a href={exportUrl(table.id, view.id, 'xlsx')} download>
              <Icon name="sheet" size={14} />
              {t('tables.toolbar.exportXlsx')}
            </a>
          </MenuItem>
          {canEdit ? (
            <MenuItem onSelect={onImport}>
              <Icon name="upload" size={14} />
              {t('tables.toolbar.import')}
            </MenuItem>
          ) : null}
        </MenuContent>
      </Menu>
      {canEdit ? (
        <Button size="sm" variant="inv" onClick={() => void addRow()}>
          <Icon name="plus" size={15} />
          {t('tables.toolbar.addRow')}
        </Button>
      ) : null}
    </div>
  );
}

function Panel({
  icon,
  label,
  count,
  disabled,
  children,
}: {
  icon: Parameters<typeof Icon>[0]['name'];
  label: string;
  count: number;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="xs" variant={count ? 'default' : 'gh'} disabled={disabled && count === 0}>
          <Icon name={icon} size={14} />
          {label}
          {count ? <span className="rounded-full bg-accent px-1.5 text-[11px] text-accent-fg">{count}</span> : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto min-w-[280px] p-3">
        {children}
      </PopoverContent>
    </Popover>
  );
}

function FieldPick({
  label,
  fields,
  value,
  onChange,
}: {
  label: string;
  fields: TableField[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const { t } = useI18n();
  return (
    <Select value={value ?? '__none__'} onValueChange={(v) => onChange(v === '__none__' ? null : v)}>
      <SelectTrigger size="sm" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__none__">{t('tables.toolbar.none')}</SelectItem>
        {fields.map((f) => (
          <SelectItem key={f.id} value={f.id}>
            {f.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function FilterEditor({
  fields,
  view,
  onUpdateView,
}: {
  fields: TableField[];
  view: TableView;
  onUpdateView: (config: ViewConfigInput) => void;
}) {
  const { t } = useI18n();
  const filters = view.config.filters;
  const save = (next: ViewFilter[]) => onUpdateView({ filters: next });
  return (
    <div className="flex flex-col gap-2">
      {filters.length > 1 ? (
        <Segmented
          size="sm"
          aria-label={t('tables.filter.mode')}
          value={view.config.filterMode}
          onValueChange={(v) => onUpdateView({ filterMode: v })}
          options={[
            { value: 'and', label: t('tables.filter.and') },
            { value: 'or', label: t('tables.filter.or') },
          ]}
        />
      ) : null}
      {filters.map((f, i) => {
        const field = fields.find((x) => x.id === f.fieldId);
        const ops = field ? opsFor(field.type) : [];
        return (
          <div key={i} className="flex flex-wrap items-center gap-1.5">
            <Select
              value={f.fieldId}
              onValueChange={(id) => {
                const nf = fields.find((x) => x.id === id)!;
                save(filters.map((x, j) => (j === i ? { fieldId: id, op: opsFor(nf.type)[0]!, value: null } : x)));
              }}
            >
              <SelectTrigger size="sm" className="w-[150px]" aria-label={t('tables.filter.field')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {fields.map((x) => (
                  <SelectItem key={x.id} value={x.id}>
                    {x.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={f.op} onValueChange={(op) => save(filters.map((x, j) => (j === i ? { ...x, op: op as FilterOp } : x)))}>
              <SelectTrigger size="sm" className="w-[140px]" aria-label={t('tables.filter.op')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ops.map((op) => (
                  <SelectItem key={op} value={op}>
                    {t(`tables.ops.${op}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {opNeedsValue(f.op) && field ? (
              field.type === 'single_select' || field.type === 'multi_select' ? (
                <Select
                  value={(Array.isArray(f.value) ? f.value[0] : f.value) ?? undefined}
                  onValueChange={(v) =>
                    save(filters.map((x, j) => (j === i ? { ...x, value: x.op.startsWith('has_') ? [v] : v } : x)))
                  }
                >
                  <SelectTrigger size="sm" className="w-[140px]" aria-label={t('tables.filter.value')}>
                    <SelectValue placeholder={t('tables.filter.value')} />
                  </SelectTrigger>
                  <SelectContent>
                    {(field.options.choices ?? []).map((ch) => (
                      <SelectItem key={ch.id} value={ch.id}>
                        {ch.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  className="h-9 w-[140px]"
                  aria-label={t('tables.filter.value')}
                  type={field.type === 'date' ? 'date' : 'text'}
                  defaultValue={typeof f.value === 'string' ? f.value : ''}
                  onBlur={(e) => save(filters.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                  }}
                />
              )
            ) : null}
            <IconButton size="sm" tone="plain" aria-label={t('tables.filter.remove')} onClick={() => save(filters.filter((_, j) => j !== i))}>
              <Icon name="x" size={14} />
            </IconButton>
          </div>
        );
      })}
      {filters.length === 0 ? <p className="text-xs text-fg3">{t('tables.filter.none')}</p> : null}
      <Button
        size="xs"
        variant="gh"
        className="self-start"
        disabled={fields.length === 0}
        onClick={() => save([...filters, { fieldId: fields[0]!.id, op: opsFor(fields[0]!.type)[0]!, value: null }])}
      >
        <Icon name="plus" size={14} />
        {t('tables.filter.add')}
      </Button>
    </div>
  );
}

function SortEditor({
  fields,
  view,
  onUpdateView,
}: {
  fields: TableField[];
  view: TableView;
  onUpdateView: (config: ViewConfigInput) => void;
}) {
  const { t } = useI18n();
  const sorts = view.config.sorts;
  const save = (next: typeof sorts) => onUpdateView({ sorts: next });
  return (
    <div className="flex flex-col gap-2">
      {sorts.map((s, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Select value={s.fieldId} onValueChange={(id) => save(sorts.map((x, j) => (j === i ? { ...x, fieldId: id } : x)))}>
            <SelectTrigger size="sm" className="w-[160px]" aria-label={t('tables.sort.field')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {fields.map((x) => (
                <SelectItem key={x.id} value={x.id}>
                  {x.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Segmented
            size="sm"
            aria-label={t('tables.sort.dir')}
            value={s.dir}
            onValueChange={(dir) => save(sorts.map((x, j) => (j === i ? { ...x, dir } : x)))}
            options={[
              { value: 'asc', label: t('tables.sort.asc') },
              { value: 'desc', label: t('tables.sort.desc') },
            ]}
          />
          <IconButton size="sm" tone="plain" aria-label={t('tables.sort.remove')} onClick={() => save(sorts.filter((_, j) => j !== i))}>
            <Icon name="x" size={14} />
          </IconButton>
        </div>
      ))}
      {sorts.length === 0 ? <p className="text-xs text-fg3">{t('tables.sort.none')}</p> : null}
      <Button
        size="xs"
        variant="gh"
        className="self-start"
        disabled={fields.length === 0}
        onClick={() => save([...sorts, { fieldId: fields[0]!.id, dir: 'asc' }])}
      >
        <Icon name="plus" size={14} />
        {t('tables.sort.add')}
      </Button>
    </div>
  );
}
