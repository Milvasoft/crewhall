import { PAGE_EXPORT_RAW_PATHS, type PageExportFormat, type PageExportJob } from '@crewhall/shared';
import {
  Button,
  Checkbox,
  cn,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Icon,
  Spinner,
  toast,
  type IconName,
} from '@crewhall/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { config } from '@/config';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';

/** Starts the browser download of a finished export (session cookie, creator only). */
export function downloadPageExport(exportId: string) {
  const a = document.createElement('a');
  a.href = `${config.apiUrl}${PAGE_EXPORT_RAW_PATHS.download.replace(':exportId', exportId)}`;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const FORMATS: { id: PageExportFormat; icon: IconName }[] = [
  { id: 'pdf', icon: 'pdf' },
  { id: 'docx', icon: 'file' },
  { id: 'html', icon: 'code' },
  { id: 'md', icon: 'file' },
];

const working = (job: PageExportJob | undefined) =>
  job?.status === 'queued' || job?.status === 'running';

/**
 * "Dışa aktar" (roadmap 6): format and sub-pages, then the worker builds the file. The dialog
 * waits for it and starts the download; when it is closed first, a notification brings the
 * file once it is ready.
 */
export function ExportBody({
  nodeId,
  name,
  onClose,
}: {
  nodeId: string;
  name: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [format, setFormat] = useState<PageExportFormat>('pdf');
  const [children, setChildren] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const started = useRef<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.call('createPageExport', { params: { nodeId }, body: { format, children } }),
    onSuccess: (job) => setJobId(job.id),
    onError: (e) => toast(t(errorKey(e))),
  });
  const job = useQuery({
    queryKey: ['wiki', 'export', jobId],
    queryFn: ({ signal }) => api.call('getPageExport', { params: { exportId: jobId! }, signal }),
    enabled: Boolean(jobId),
    refetchInterval: (q) => (working(q.state.data) || !q.state.data ? 1000 : false),
  });
  const done = job.data;

  useEffect(() => {
    if (done?.status !== 'ready' || started.current === done.id) return;
    started.current = done.id;
    downloadPageExport(done.id);
    if (!done.skipped.length) {
      toast(t('wiki.export.downloading', { fileName: done.fileName ?? '' }));
      onClose();
    }
  }, [done, onClose, t]);

  const busy = create.isPending || Boolean(jobId && (!done || working(done)));

  return (
    <DialogContent width={500}>
      <DialogHeader
        icon="download"
        title={t('wiki.export.title')}
        description={t('wiki.export.hint', { name })}
      />
      {done?.status === 'failed' ? (
        <p className="flex items-center gap-2 text-sm text-fg">
          <Icon name="alert" size={16} className="text-danger" />
          {t('wiki.export.failed')}
        </p>
      ) : done?.status === 'ready' ? (
        <div className="flex flex-col gap-2 text-sm">
          <p className="flex items-center gap-2 text-fg">
            <Icon name="checkC" size={16} className="text-success" />
            {t('wiki.export.downloading', { fileName: done.fileName ?? '' })}
          </p>
          {done.skipped.length ? (
            <p className="flex items-start gap-2 text-fg2">
              <Icon name="alert" size={16} className="mt-0.5 shrink-0 text-warning" />
              {t('wiki.export.skipped', { names: done.skipped.join(', ') })}
            </p>
          ) : null}
        </div>
      ) : busy ? (
        <div className="flex items-center gap-3 text-sm text-fg2" role="status">
          <Spinner />
          <span>
            {t('wiki.export.running')}
            <br />
            <span className="text-cap text-fg3">{t('wiki.export.runningHint')}</span>
          </span>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div
            role="radiogroup"
            aria-label={t('wiki.export.format')}
            className="grid grid-cols-2 gap-2"
          >
            {FORMATS.map((f) => (
              <button
                key={f.id}
                type="button"
                role="radio"
                aria-checked={format === f.id}
                onClick={() => setFormat(f.id)}
                className={cn(
                  'flex items-start gap-2.5 rounded-lg border p-3 text-left hover:bg-bg2',
                  format === f.id
                    ? 'border-accent shadow-[inset_0_0_0_1px_var(--accent)]'
                    : 'border-line',
                )}
              >
                <Icon name={f.icon} size={18} className="mt-0.5 shrink-0" />
                <span className="flex min-w-0 flex-col">
                  <span className="text-sm font-semibold">{t(`wiki.export.formats.${f.id}`)}</span>
                  <span className="text-cap text-fg3">{t(`wiki.export.formatHints.${f.id}`)}</span>
                </span>
              </button>
            ))}
          </div>
          <label className="flex cursor-pointer items-start gap-2.5 text-sm">
            <Checkbox
              className="mt-0.5"
              checked={children}
              onCheckedChange={(v) => setChildren(v === true)}
            />
            <span className="flex flex-col">
              <span className="font-semibold">{t('wiki.export.children')}</span>
              <span className="text-cap text-fg3">{t('wiki.export.childrenHint')}</span>
            </span>
          </label>
        </div>
      )}
      <DialogFooter>
        <Button variant="gh" onClick={onClose}>
          {done || busy ? t('common.actions.close') : t('common.actions.cancel')}
        </Button>
        {!jobId ? (
          <Button variant="pri" loading={create.isPending} onClick={() => create.mutate()}>
            {t('wiki.export.start')}
          </Button>
        ) : null}
      </DialogFooter>
    </DialogContent>
  );
}
