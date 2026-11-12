import { type DirectoryImportResult, type OrgChartNode } from '@crewhall/shared';
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Icon,
  toast,
} from '@crewhall/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useI18n, type MessageKey } from '@/lib/i18n/I18nContext';
import { contactsKeys } from '@/lib/contacts/queries';

const STATUS_CLASS: Record<DirectoryImportResult['rows'][number]['status'], string> = {
  updated: 'text-success',
  unchanged: 'text-fg3',
  failed: 'text-danger',
};

/** A CSV of today's chart: the template people fill in (e-mail, title, …, manager's e-mail). */
export function directoryCsv(items: OrgChartNode[], header: string[]) {
  const email = new Map(items.map((n) => [n.user.id, n.user.email]));
  const cell = (v: string | null | undefined) => {
    const s = v ?? '';
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    header.join(';'),
    ...[...items]
      .sort((a, b) => a.user.name.localeCompare(b.user.name, 'tr'))
      .map((n) =>
        [n.user.email, n.title, n.department, n.team, n.managerId ? email.get(n.managerId) : '']
          .map(cell)
          .join(';'),
      ),
  ];
  // Excel opens a UTF-8 CSV right only with a byte order mark.
  return `${String.fromCharCode(0xfeff)}${lines.join('\r\n')}\r\n`;
}

/**
 * CSV import (sonraki-isler, org chart): pick a file, check it (a dry run lists every row with
 * what would change or why it cannot), then apply.
 */
export function ImportDirectoryDialog({
  items,
  onClose,
}: {
  items: OrgChartNode[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; csv: string } | null>(null);
  const [check, setCheck] = useState<DirectoryImportResult | null>(null);
  const run = useMutation({
    mutationFn: (dryRun: boolean) =>
      api.call('importDirectory', { body: { csv: file!.csv, dryRun } }),
    onSuccess: async (r) => {
      if (r.dryRun) {
        setCheck(r);
        return;
      }
      toast(t('contacts.chart.csv.done', { count: r.updated }));
      await qc.invalidateQueries({ queryKey: contactsKeys.all });
      onClose();
    },
    onError: (e) => toast(t(errorKey(e))),
  });

  const template = () => {
    const header = ['E-posta', 'Unvan', 'Departman', 'Ekip', 'Yönetici'];
    const blob = new Blob([directoryCsv(items, header)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${t('contacts.chart.fileName')}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent width={640}>
        <DialogHeader
          title={t('contacts.chart.csv.title')}
          description={t('contacts.chart.csv.description')}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="out" onClick={() => input.current?.click()}>
            <Icon name="upload" size={15} />
            {t('contacts.chart.csv.pick')}
          </Button>
          {file ? <span className="truncate text-sm font-semibold">{file.name}</span> : null}
          <Button size="sm" variant="gh" className="ml-auto" onClick={template}>
            <Icon name="download" size={15} />
            {t('contacts.chart.template')}
          </Button>
          <input
            ref={input}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            aria-label={t('contacts.chart.csv.file')}
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              setCheck(null);
              setFile({ name: f.name, csv: await f.text() });
            }}
          />
        </div>
        {check ? (
          <div className="flex min-h-0 flex-col gap-2">
            <span className="text-sm font-semibold" data-testid="directory-import-summary">
              {t('contacts.chart.csv.summary', {
                done: check.updated,
                total: check.unchanged,
                failed: check.failed,
              })}
            </span>
            <ul className="m-0 flex max-h-64 list-none flex-col divide-y divide-line overflow-auto rounded-lg border border-line p-0">
              {check.rows.map((r) => (
                <li key={r.line} className="flex items-center gap-3 px-3 py-1.5 text-sm">
                  <span className="w-10 shrink-0 text-xs text-fg3 tabular-nums">
                    {t('contacts.chart.csv.line')} {r.line}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{r.name ?? r.email}</span>
                  <span className={cn('shrink-0 text-xs font-semibold', STATUS_CLASS[r.status])}>
                    {r.status === 'failed' && r.code
                      ? t(`errors.${r.code}` as MessageKey)
                      : r.status === 'updated'
                        ? `${t('contacts.chart.csv.status.updated')}: ${r.fields
                            .map((f) =>
                              t(
                                `contacts.fields.${f === 'managerId' ? 'manager' : f}` as MessageKey,
                              ),
                            )
                            .join(', ')}`
                        : t(`contacts.chart.csv.status.${r.status}`)}
                  </span>
                </li>
              ))}
            </ul>
            {!check.updated ? (
              <span className="text-xs text-fg3">{t('contacts.chart.csv.nothing')}</span>
            ) : null}
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="gh" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
          {check && check.updated ? (
            <Button variant="pri" disabled={run.isPending} onClick={() => run.mutate(false)}>
              {t('contacts.chart.csv.apply', { count: check.updated })}
            </Button>
          ) : (
            <Button
              variant="pri"
              disabled={!file || run.isPending}
              onClick={() => run.mutate(true)}
            >
              {t('contacts.chart.csv.check')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
