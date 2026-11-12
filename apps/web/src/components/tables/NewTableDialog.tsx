import { TABLE_LIMITS, type Space, type TableTemplate } from '@crewhall/shared';
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  Icon,
  Input,
  toast,
  type IconName,
} from '@crewhall/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { tableKeys } from '@/lib/tables/api';

const TEMPLATES: { id: TableTemplate; icon: IconName }[] = [
  { id: 'empty', icon: 'table' },
  { id: 'crm', icon: 'users' },
  { id: 'inventory', icon: 'archive' },
  { id: 'hiring', icon: 'userPlus' },
  { id: 'assets', icon: 'laptop' },
];

const ACCEPT = '.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export function readAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('read failed'));
    r.readAsDataURL(file);
  });
}

/** New table: a name and a template, or a CSV / Excel file whose columns become fields. */
export function NewTableDialog({ space, open, onClose }: { space: Space; open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [template, setTemplate] = useState<TableTemplate>('empty');
  const [file, setFile] = useState<File | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const done = (tableId: string) => {
    void qc.invalidateQueries({ queryKey: tableKeys.list(space.id) });
    onClose();
    setName('');
    setFile(null);
    setTemplate('empty');
    void navigate({ to: '/tables/t/$tableId', params: { tableId } });
  };
  const create = useMutation({
    mutationFn: async () => {
      if (file) {
        const r = await api.call('importTable', {
          params: { spaceId: space.id },
          body: { fileName: file.name, dataURL: await readAsDataUrl(file), mode: 'new', ...(name.trim() ? { name: name.trim() } : {}) },
        });
        return r.tableId;
      }
      const tbl = await api.call('createTable', { params: { spaceId: space.id }, body: { name: name.trim() || t(`tables.templates.${template}`), template } });
      return tbl.id;
    },
    onSuccess: done,
    onError: (e) => toast(t(errorKey(e))),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent width={560}>
        <DialogHeader icon="table" title={t('tables.new.title')} description={t('tables.new.body')} />
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Field label={t('tables.new.name')}>
            <Input
              autoFocus
              value={name}
              maxLength={TABLE_LIMITS.nameChars}
              placeholder={file ? file.name.replace(/\.[^.]+$/, '') : t(`tables.templates.${template}`)}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold text-fg2">{t('tables.new.start')}</span>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="radiogroup" aria-label={t('tables.new.start')}>
              {TEMPLATES.map((tp) => (
                <button
                  key={tp.id}
                  type="button"
                  role="radio"
                  aria-checked={!file && template === tp.id}
                  onClick={() => {
                    setFile(null);
                    setTemplate(tp.id);
                  }}
                  className={cn(
                    'flex flex-col items-start gap-1.5 rounded-xl p-3 text-left shadow-[0_0_0_1px_var(--line)] hover:bg-bg2',
                    !file && template === tp.id && 'shadow-[0_0_0_2px_var(--fg)]',
                  )}
                >
                  <Icon name={tp.icon} size={18} />
                  <span className="text-sm font-semibold">{t(`tables.templates.${tp.id}`)}</span>
                  <span className="text-xs text-fg3">{t(`tables.templateHints.${tp.id}`)}</span>
                </button>
              ))}
              <button
                type="button"
                role="radio"
                aria-checked={Boolean(file)}
                onClick={() => input.current?.click()}
                className={cn(
                  'flex flex-col items-start gap-1.5 rounded-xl p-3 text-left shadow-[0_0_0_1px_var(--line)] hover:bg-bg2',
                  file && 'shadow-[0_0_0_2px_var(--fg)]',
                )}
              >
                <Icon name="upload" size={18} />
                <span className="text-sm font-semibold">{t('tables.new.import')}</span>
                <span className="truncate text-xs text-fg3">{file ? file.name : t('tables.new.importHint')}</span>
              </button>
            </div>
            <input
              ref={input}
              type="file"
              accept={ACCEPT}
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                if (f.size > TABLE_LIMITS.importBytes) return void toast(t('tables.import.tooLarge'));
                setFile(f);
              }}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="gh" onClick={onClose}>
              {t('tables.new.cancel')}
            </Button>
            <Button type="submit" variant="inv" disabled={create.isPending}>
              {t('tables.new.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Adds the rows of a CSV / Excel file to this table; columns are matched by field name. */
export function ImportDialog({ tableId, spaceId, open, onClose }: { tableId: string; spaceId: string; open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const run = useMutation({
    mutationFn: async (f: File) =>
      api.call('importTable', {
        params: { spaceId },
        body: { fileName: f.name, dataURL: await readAsDataUrl(f), mode: 'append', tableId },
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: tableKeys.rows(tableId) });
      void qc.invalidateQueries({ queryKey: tableKeys.table(tableId) });
      toast(
        r.skippedColumns.length
          ? t('tables.import.doneSkipped', { count: r.rowsAdded, names: r.skippedColumns.join(', ') })
          : t('tables.import.done', { count: r.rowsAdded }),
      );
      setFile(null);
      onClose();
    },
    onError: (e) => toast(t(errorKey(e))),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent>
        <DialogHeader icon="upload" title={t('tables.import.title')} description={t('tables.import.body')} />
        <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl p-6 text-center shadow-[inset_0_0_0_1.5px_var(--line2)] hover:bg-bg2">
          <Icon name="sheet" size={22} />
          <span className="text-sm font-semibold">{file ? file.name : t('tables.import.pick')}</span>
          <span className="text-xs text-fg3">{t('tables.new.importHint')}</span>
          <input
            type="file"
            accept={ACCEPT}
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              if (f.size > TABLE_LIMITS.importBytes) return void toast(t('tables.import.tooLarge'));
              setFile(f);
            }}
          />
        </label>
        <DialogFooter>
          <Button variant="gh" onClick={onClose}>
            {t('tables.new.cancel')}
          </Button>
          <Button variant="inv" disabled={!file || run.isPending} onClick={() => file && run.mutate(file)}>
            {t('tables.import.run')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
