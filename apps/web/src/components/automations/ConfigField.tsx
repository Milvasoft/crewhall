import { type AutomationField, type Conversation } from '@crewhall/shared';
import {
  Button,
  Checkbox,
  Field,
  Icon,
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
  Textarea,
  type IconName,
} from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { useId, useRef } from 'react';
import { nodesQuery } from '@/features/drive/api';
import { fieldName } from '@/lib/automations/api';
import { type VariableOption } from '@/lib/automations/variables';
import { boardQuery, boardsQuery } from '@/lib/boards/api';
import { conversationsQuery } from '@/lib/chat/queries';
import { formsQuery } from '@/lib/forms/api';
import { formatDate } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useModuleEnabled } from '@/lib/identity/modules';
import { spaceMembersQuery } from '@/lib/queries';
import { tableQuery, tablesQuery } from '@/lib/tables/api';

const NONE = '__none__';

/**
 * One config field of a trigger or action, rendered from the catalog's description (roadmap
 * 17): plain inputs, `{{…}}` templates with the trigger's variables, and pickers for boards,
 * columns, conversations, people, forms, folders and tables of the space.
 */
export function ConfigField({
  field,
  value,
  values,
  onChange,
  spaceId,
  variables,
}: {
  field: AutomationField;
  value: unknown;
  /** The whole config, for fields that depend on another (column of a board). */
  values: Record<string, unknown>;
  onChange: (v: unknown) => void;
  spaceId: string;
  variables: VariableOption[];
}) {
  const { locale } = useI18n();
  const label = `${fieldName(locale, field.key)}${field.required ? ' *' : ''}`;
  const text = typeof value === 'string' ? value : '';

  switch (field.kind) {
    case 'text':
    case 'url':
      return (
        <Field label={label}>
          <Input
            type={field.kind === 'url' ? 'url' : 'text'}
            value={text}
            placeholder={field.kind === 'url' ? 'https://' : undefined}
            onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
          />
        </Field>
      );
    case 'number':
      return (
        <Field label={label}>
          <Input
            type="number"
            className="max-w-[200px]"
            value={typeof value === 'number' ? String(value) : ''}
            onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
          />
        </Field>
      );
    case 'boolean':
      return (
        <label className="flex items-center justify-between gap-3 text-sm font-medium">
          {label}
          <Switch checked={value === true} onCheckedChange={onChange} />
        </label>
      );
    case 'template':
      return <TemplateField label={label} text={text} onChange={onChange} variables={variables} />;
    case 'select':
      return (
        <Picker
          label={label}
          value={text}
          required={field.required}
          onChange={onChange}
          options={field.options.map((o) => ({ value: o, label: o }))}
        />
      );
    case 'board':
      return (
        <BoardPicker
          label={label}
          spaceId={spaceId}
          value={text}
          required={field.required}
          onChange={onChange}
        />
      );
    case 'column':
      return (
        <ColumnPicker
          label={label}
          boardId={
            typeof values[field.dependsOn ?? ''] === 'string'
              ? (values[field.dependsOn ?? ''] as string)
              : ''
          }
          value={text}
          required={field.required}
          onChange={onChange}
        />
      );
    case 'conversation':
      return (
        <ConversationPicker
          label={label}
          value={text}
          required={field.required}
          onChange={onChange}
        />
      );
    case 'form':
      return (
        <FormPicker
          label={label}
          spaceId={spaceId}
          value={text}
          required={field.required}
          onChange={onChange}
        />
      );
    case 'folder':
      return (
        <FolderPicker
          label={label}
          spaceId={spaceId}
          value={text}
          required={field.required}
          onChange={onChange}
        />
      );
    case 'table':
      return (
        <TablePicker
          label={label}
          spaceId={spaceId}
          value={text}
          required={field.required}
          onChange={onChange}
        />
      );
    case 'table_field':
      return (
        <TableFieldPicker
          label={label}
          tableId={dependency(values, field)}
          value={text}
          required={field.required}
          onChange={onChange}
        />
      );
    case 'table_values':
      return (
        <TableValuesField
          label={label}
          tableId={dependency(values, field)}
          value={value && typeof value === 'object' ? (value as Record<string, string>) : {}}
          onChange={onChange}
          variables={variables}
        />
      );
    case 'users':
      return (
        <UsersPicker
          label={label}
          spaceId={spaceId}
          value={Array.isArray(value) ? (value as string[]) : []}
          onChange={onChange}
        />
      );
  }
}

const dependency = (values: Record<string, unknown>, field: AutomationField) => {
  const v = values[field.dependsOn ?? ''];
  return typeof v === 'string' ? v : '';
};

interface PickerProps {
  label: string;
  value: string;
  required: boolean;
  onChange: (v: string | null) => void;
}

interface PickerOption {
  value: string;
  label: string;
  icon?: IconName;
  /** Second, quieter text: what tells same-named entries apart. */
  hint?: string;
}

function Picker({
  label,
  value,
  required,
  onChange,
  options,
  disabled,
  emptyLabel,
}: PickerProps & {
  options: PickerOption[];
  disabled?: boolean;
  emptyLabel?: string;
}) {
  const { t } = useI18n();
  return (
    <Field label={label}>
      <Select
        value={value || (required ? undefined : NONE)}
        disabled={disabled}
        onValueChange={(v) => onChange(v === NONE ? null : v)}
      >
        <SelectTrigger size="sm" aria-label={label}>
          <SelectValue placeholder={t('automations.editor.choose')} />
        </SelectTrigger>
        <SelectContent>
          {!required ? (
            <SelectItem value={NONE}>{emptyLabel ?? t('automations.editor.any')}</SelectItem>
          ) : null}
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.icon || o.hint ? (
                <span className="flex min-w-0 items-center gap-2">
                  {o.icon ? <Icon name={o.icon} size={15} className="shrink-0 text-fg2" /> : null}
                  <span className="truncate">{o.label}</span>
                  {o.hint ? (
                    <span className="truncate text-xs font-normal text-fg3">{o.hint}</span>
                  ) : null}
                </span>
              ) : (
                o.label
              )}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

function BoardPicker({ spaceId, ...p }: PickerProps & { spaceId: string }) {
  const on = useModuleEnabled('boards');
  const boards = useQuery({ ...boardsQuery(spaceId), enabled: on });
  return (
    <Picker
      {...p}
      options={(boards.data?.items ?? []).map((b) => ({ value: b.id, label: b.name }))}
    />
  );
}

function ColumnPicker({ boardId, ...p }: PickerProps & { boardId: string }) {
  const board = useQuery({ ...boardQuery(boardId), enabled: Boolean(boardId) });
  return (
    <Picker
      {...p}
      disabled={!boardId}
      options={(board.data?.columns ?? []).map((c) => ({ value: c.id, label: c.name }))}
    />
  );
}

const CONVERSATION_ICON: Record<Conversation['type'], IconName> = {
  direct: 'user',
  group: 'users',
  space: 'space',
  meeting: 'video',
  alert: 'alert',
  card: 'card',
};

/**
 * Chats the rule may post to, told apart by type icon and who is in them (space, member
 * count, meeting date): several can share a title ("Hızlı görüşme").
 */
function ConversationPicker(p: PickerProps) {
  const { t, locale } = useI18n();
  const on = useModuleEnabled('chat');
  const convs = useQuery({ ...conversationsQuery, enabled: on });
  const hint = (c: Conversation) => {
    const kind = t(`automations.conversationTypes.${c.type}`);
    if (c.type === 'space' && c.spaceName) return `${kind} · ${c.spaceName}`;
    const people = t('automations.editor.members', { count: c.memberCount });
    return c.type === 'meeting'
      ? `${kind} · ${people} · ${formatDate(c.createdAt, locale)}`
      : `${kind} · ${people}`;
  };
  return (
    <Picker
      {...p}
      options={(convs.data ?? [])
        .filter((c) => c.type !== 'direct' && !c.archivedAt)
        .map((c) => ({
          value: c.id,
          label: c.title,
          icon: CONVERSATION_ICON[c.type],
          hint: hint(c),
        }))}
    />
  );
}

function FormPicker({ spaceId, ...p }: PickerProps & { spaceId: string }) {
  const on = useModuleEnabled('forms');
  const forms = useQuery({ ...formsQuery(spaceId), enabled: on });
  return (
    <Picker
      {...p}
      options={(forms.data?.items ?? []).map((f) => ({ value: f.id, label: f.title }))}
    />
  );
}

function TablePicker({ spaceId, ...p }: PickerProps & { spaceId: string }) {
  const on = useModuleEnabled('tables');
  const tables = useQuery({ ...tablesQuery(spaceId), enabled: on });
  return (
    <Picker
      {...p}
      options={(tables.data?.items ?? []).map((tb) => ({ value: tb.id, label: tb.name, icon: 'table' }))}
    />
  );
}

function TableFieldPicker({ tableId, ...p }: PickerProps & { tableId: string }) {
  const { t } = useI18n();
  const table = useQuery({ ...tableQuery(tableId), enabled: Boolean(tableId) });
  return (
    <Picker
      {...p}
      disabled={!tableId}
      emptyLabel={t('automations.editor.anyField')}
      options={(table.data?.fields ?? []).map((f) => ({ value: f.id, label: f.name }))}
    />
  );
}

/** Computed fields and attachments cannot be written by a rule. */
const READ_ONLY = new Set(['formula', 'lookup', 'rollup', 'created_at', 'updated_at', 'attachment']);

/** A template per writable field of the table; empty ones are left out of the config. */
function TableValuesField({
  label,
  tableId,
  value,
  onChange,
  variables,
}: {
  label: string;
  tableId: string;
  value: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
  variables: VariableOption[];
}) {
  const { t } = useI18n();
  const table = useQuery({ ...tableQuery(tableId), enabled: Boolean(tableId) });
  const fields = (table.data?.fields ?? []).filter((f) => !READ_ONLY.has(f.type));
  if (!tableId) return null;
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-1 text-cap font-medium text-fg2">{label}</legend>
      <p className="text-xs text-fg3">{t('automations.editor.tableValuesHint')}</p>
      {fields.map((f) => (
        <TemplateField
          key={f.id}
          label={f.name}
          text={value[f.id] ?? ''}
          rows={1}
          variables={variables}
          onChange={(v) => {
            const next = { ...value };
            if (v) next[f.id] = v;
            else delete next[f.id];
            onChange(next);
          }}
        />
      ))}
    </fieldset>
  );
}

function FolderPicker({ spaceId, ...p }: PickerProps & { spaceId: string }) {
  const { t } = useI18n();
  const folders = useQuery(nodesQuery(spaceId, null, { type: 'folder' }));
  return (
    <Picker
      {...p}
      emptyLabel={t('automations.editor.anyFolder')}
      options={(folders.data ?? []).map((f) => ({ value: f.id, label: f.name }))}
    />
  );
}

function UsersPicker({
  label,
  spaceId,
  value,
  onChange,
}: {
  label: string;
  spaceId: string;
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const id = useId();
  const members = useQuery(spaceMembersQuery(spaceId));
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-cap font-medium text-fg2">{label}</legend>
      <div className="flex max-h-48 flex-col gap-0.5 overflow-y-auto rounded-lg bg-bg2 p-1.5">
        {(members.data?.items ?? []).map((m) => (
          <label
            key={m.user.id}
            htmlFor={`${id}-${m.user.id}`}
            className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-surface"
          >
            <Checkbox
              id={`${id}-${m.user.id}`}
              checked={value.includes(m.user.id)}
              onCheckedChange={(on) =>
                onChange(on === true ? [...value, m.user.id] : value.filter((x) => x !== m.user.id))
              }
            />
            {m.user.name}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * A `{{…}}` template with a "Değişken ekle" menu: variables by their readable names, inserted at
 * the cursor.
 */
function TemplateField({
  label,
  text,
  onChange,
  variables,
  rows = 3,
}: {
  label: string;
  text: string;
  onChange: (v: string | null) => void;
  variables: VariableOption[];
  rows?: number;
}) {
  const { t } = useI18n();
  const area = useRef<HTMLTextAreaElement>(null);
  const insert = (path: string) => {
    const el = area.current;
    const token = `{{${path}}}`;
    const at = el && document.activeElement === el ? el.selectionStart : text.length;
    const end = el && document.activeElement === el ? el.selectionEnd : text.length;
    onChange(text.slice(0, at) + token + text.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + token.length, at + token.length);
    });
  };
  return (
    <Field label={label} hint={variables.length ? t('automations.editor.templateHint') : undefined}>
      <Textarea
        ref={area}
        rows={rows}
        value={text}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
      />
      {variables.length ? (
        <Menu>
          <MenuTrigger asChild>
            <Button type="button" size="xs" variant="gh" className="self-start">
              <Icon name="plus" size={14} />
              {t('automations.editor.addVariable')}
            </Button>
          </MenuTrigger>
          <MenuContent align="start">
            {variables.map((v) => (
              <MenuItem
                key={v.path}
                onSelect={() => insert(v.path)}
                aria-label={t('automations.editor.insertVariable', { name: v.label })}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{v.label}</span>
                  <span className="truncate font-mono text-[11px] text-fg3">{`{{${v.path}}}`}</span>
                </span>
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
      ) : null}
    </Field>
  );
}
