import {
  type CellValue,
  type TableAttachment,
  type TableField,
} from '@crewhall/shared';
import {
  Avatar,
  Button,
  Checkbox,
  DatePicker,
  Icon,
  IconButton,
  Input,
  Spinner,
  Textarea,
  TimePicker,
  toast,
} from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { useRef, useState, type KeyboardEvent } from 'react';
import { api } from '@/lib/api';
import { uploadToFolder } from '@/lib/boards/upload';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { ChoiceChip } from './CellView';
import { useTableCtx } from './context';

/**
 * Editing one value: text kinds commit on Enter or blur (Esc cancels), choices and people pick
 * from lists, dates use the kit pickers, attachments upload into the table's Drive folder.
 * Used by grid cells (in a popover) and the row detail.
 */
export function CellEditor({
  field,
  value,
  onCommit,
  onDone,
  autoFocus = true,
}: {
  field: TableField;
  value: CellValue | undefined;
  onCommit: (v: CellValue) => void;
  onDone?: () => void;
  autoFocus?: boolean;
}) {
  const done = () => onDone?.();
  switch (field.type) {
    case 'long_text':
      return <TextEditor multiline value={value} onCommit={onCommit} onDone={done} autoFocus={autoFocus} />;
    case 'text':
    case 'url':
    case 'email':
    case 'phone':
      return (
        <TextEditor
          value={value}
          onCommit={onCommit}
          onDone={done}
          autoFocus={autoFocus}
          type={field.type === 'email' ? 'email' : field.type === 'url' ? 'url' : field.type === 'phone' ? 'tel' : 'text'}
        />
      );
    case 'number':
    case 'currency':
      return <TextEditor value={value} onCommit={onCommit} onDone={done} autoFocus={autoFocus} numeric />;
    case 'date':
      return <DateEditor field={field} value={value} onCommit={onCommit} />;
    case 'checkbox':
      return (
        <Checkbox
          checked={value === true}
          onCheckedChange={(v) => {
            onCommit(v === true);
            done();
          }}
        />
      );
    case 'rating':
      return <RatingEditor max={field.options.max ?? 5} value={typeof value === 'number' ? value : 0} onCommit={(v) => { onCommit(v); done(); }} />;
    case 'single_select':
    case 'multi_select':
      return <ChoiceEditor field={field} value={value} onCommit={onCommit} onDone={done} />;
    case 'person':
      return <PersonEditor field={field} value={value} onCommit={onCommit} />;
    case 'relation':
      return <RelationEditor field={field} value={value} onCommit={onCommit} />;
    case 'attachment':
      return <AttachmentEditor value={value} onCommit={onCommit} />;
    default:
      return null;
  }
}

function TextEditor({
  value,
  onCommit,
  onDone,
  multiline,
  numeric,
  type = 'text',
  autoFocus,
}: {
  value: CellValue | undefined;
  onCommit: (v: CellValue) => void;
  onDone: () => void;
  multiline?: boolean;
  numeric?: boolean;
  type?: string;
  autoFocus?: boolean;
}) {
  const initial = value === null || value === undefined ? '' : String(value);
  const [text, setText] = useState(initial);
  const cancelled = useRef(false);
  const commit = () => {
    if (cancelled.current) return;
    if (text !== initial) onCommit(text === '' ? null : numeric ? text.replace(/\s/g, '') : text);
    onDone();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      cancelled.current = true;
      onDone();
    }
    if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      commit();
    }
  };
  return multiline ? (
    <Textarea
      autoFocus={autoFocus}
      rows={4}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={onKey}
    />
  ) : (
    <Input
      autoFocus={autoFocus}
      type={type}
      inputMode={numeric ? 'decimal' : undefined}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={onKey}
      className="h-9"
    />
  );
}

function DateEditor({
  field,
  value,
  onCommit,
}: {
  field: TableField;
  value: CellValue | undefined;
  onCommit: (v: CellValue) => void;
}) {
  const s = typeof value === 'string' ? value : '';
  const day = s ? (s.length > 10 ? new Date(s).toISOString().slice(0, 10) : s) : null;
  const time = s.length > 10 ? new Date(s).toTimeString().slice(0, 5) : '09:00';
  const write = (d: string | null, tm: string) => {
    if (!d) return onCommit(null);
    if (!field.options.includeTime) return onCommit(d);
    onCommit(new Date(`${d}T${tm}:00`).toISOString());
  };
  return (
    <span className="flex flex-wrap items-center gap-2">
      <DatePicker value={day} onChange={(d) => write(d, time)} className="w-[200px]" />
      {field.options.includeTime ? (
        <TimePicker value={time} onChange={(tm) => write(day, tm ?? '09:00')} className="w-[120px]" />
      ) : null}
    </span>
  );
}

function RatingEditor({ max, value, onCommit }: { max: number; value: number; onCommit: (v: CellValue) => void }) {
  const { t } = useI18n();
  return (
    <span className="flex">
      {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
        <button
          key={n}
          type="button"
          aria-label={t('tables.cell.rating', { value: n, total: max })}
          onClick={() => onCommit(n === value ? null : n)}
          className="flex size-7 items-center justify-center text-accent"
        >
          <Icon name="star" size={18} className={n <= value ? 'fill-current' : 'text-fg3'} />
        </button>
      ))}
    </span>
  );
}

function ChoiceEditor({
  field,
  value,
  onCommit,
  onDone,
}: {
  field: TableField;
  value: CellValue | undefined;
  onCommit: (v: CellValue) => void;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const multi = field.type === 'multi_select';
  const picked = Array.isArray(value) ? (value as string[]) : typeof value === 'string' ? [value] : [];
  return (
    <div role="listbox" aria-label={field.name} aria-multiselectable={multi} className="flex max-h-64 min-w-[200px] flex-col gap-0.5 overflow-y-auto">
      {(field.options.choices ?? []).map((c) => {
        const on = picked.includes(c.id);
        return (
          <button
            key={c.id}
            type="button"
            role="option"
            aria-selected={on}
            onClick={() => {
              if (multi) onCommit(on ? picked.filter((x) => x !== c.id) : [...picked, c.id]);
              else {
                onCommit(on ? null : c.id);
                onDone();
              }
            }}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-bg2"
          >
            <span className="flex w-4 justify-center">{on ? <Icon name="check" size={14} /> : null}</span>
            <ChoiceChip label={c.label} color={c.color} />
          </button>
        );
      })}
      {(field.options.choices ?? []).length === 0 ? (
        <p className="px-2 py-1.5 text-xs text-fg3">{t('tables.cell.noChoices')}</p>
      ) : null}
    </div>
  );
}

function PersonEditor({
  field,
  value,
  onCommit,
}: {
  field: TableField;
  value: CellValue | undefined;
  onCommit: (v: CellValue) => void;
}) {
  const { t } = useI18n();
  const { people } = useTableCtx();
  const [q, setQ] = useState('');
  const picked = Array.isArray(value) ? (value as string[]) : [];
  const list = [...people.values()].filter((u) => u.name.toLocaleLowerCase('tr').includes(q.toLocaleLowerCase('tr')));
  return (
    <div className="flex min-w-[220px] flex-col gap-1.5">
      <Input className="h-8" placeholder={t('tables.cell.searchPeople')} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      <div className="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
        {list.map((u) => {
          const on = picked.includes(u.id);
          return (
            <button
              key={u.id}
              type="button"
              aria-pressed={on}
              onClick={() =>
                onCommit(
                  on
                    ? picked.filter((x) => x !== u.id)
                    : field.options.multiple
                      ? [...picked, u.id]
                      : [u.id],
                )
              }
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-bg2"
            >
              <span className="flex w-4 justify-center">{on ? <Icon name="check" size={14} /> : null}</span>
              <Avatar name={u.name} src={u.imageUrl} size="sm" />
              {u.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function RelationEditor({
  field,
  value,
  onCommit,
}: {
  field: TableField;
  value: CellValue | undefined;
  onCommit: (v: CellValue) => void;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const tableId = field.options.tableId ?? '';
  const target = useQuery({
    queryKey: ['tables', 'table', tableId],
    queryFn: () => api.call('getTable', { params: { tableId } }),
    enabled: Boolean(tableId),
  });
  const rows = useQuery({
    queryKey: ['tables', 'rows', tableId, 'pick', q],
    queryFn: () => api.call('queryTableRows', { params: { tableId }, query: { limit: 50, ...(q ? { q } : {}) } }),
    enabled: Boolean(tableId),
  });
  const primary = target.data?.fields.find((f) => f.primary);
  const picked = Array.isArray(value) ? (value as string[]) : [];
  return (
    <div className="flex min-w-[240px] flex-col gap-1.5">
      <Input className="h-8" placeholder={t('tables.cell.searchRows')} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      <div className="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
        {rows.isLoading ? <Spinner className="m-2" size={16} /> : null}
        {(rows.data?.items ?? []).map((r) => {
          const on = picked.includes(r.id);
          return (
            <button
              key={r.id}
              type="button"
              aria-pressed={on}
              onClick={() =>
                onCommit(on ? picked.filter((x) => x !== r.id) : field.options.multiple === false ? [r.id] : [...picked, r.id])
              }
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-bg2"
            >
              <span className="flex w-4 justify-center">{on ? <Icon name="check" size={14} /> : null}</span>
              <span className="truncate">{primary ? String(r.values[primary.id] ?? '') || t('tables.cell.untitled') : r.id}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function AttachmentEditor({ value, onCommit }: { value: CellValue | undefined; onCommit: (v: CellValue) => void }) {
  const { t } = useI18n();
  const { table } = useTableCtx();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const files = Array.isArray(value) ? (value as TableAttachment[]) : [];
  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy(true);
    try {
      const target = await api.call('getTableAttachmentFolder', { params: { tableId: table.id } });
      const added: TableAttachment[] = [];
      for (const f of Array.from(list)) {
        const node = await uploadToFolder(f, { spaceId: target.spaceId, folderId: target.folderId, name: f.name });
        added.push({ nodeId: node.id, name: node.name, mime: node.mime, sizeBytes: node.sizeBytes });
      }
      onCommit([...files, ...added]);
    } catch (e) {
      toast(t(errorKey(e)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex min-w-[240px] flex-col gap-1.5">
      {files.map((f) => (
        <div key={f.nodeId} className="flex items-center gap-2 rounded-md bg-bg2 px-2 py-1.5 text-sm">
          <Icon name="file" size={14} />
          <span className="min-w-0 flex-1 truncate">{f.name}</span>
          <IconButton
            size="xs"
            tone="plain"
            aria-label={t('tables.cell.removeFile', { name: f.name })}
            onClick={() => onCommit(files.filter((x) => x.nodeId !== f.nodeId))}
          >
            <Icon name="x" size={12} />
          </IconButton>
        </div>
      ))}
      <input ref={input} type="file" multiple className="hidden" onChange={(e) => void upload(e.target.files)} />
      <Button type="button" size="xs" variant="out" className="self-start" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? <Spinner size={12} /> : <Icon name="upload" size={13} />}
        {t('tables.cell.upload')}
      </Button>
    </div>
  );
}
