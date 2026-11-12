import {
  Button,
  Checkbox,
  cn,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Icon,
  IconButton,
  Progress,
} from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { formatBytes, formatNumber, formatRelative } from '@/lib/i18n/format';
import { useI18n, type MessageKey } from '@/lib/i18n/I18nContext';
import { nodeQuery } from './api';
import { badgeOf } from './fileKinds';
import {
  bindUploads,
  cancelAllConflicts,
  cancelUpload,
  clearFinished,
  resolveConflict,
  resumeWithFile,
  retryUpload,
  setUploadPanelOpen,
  useUploads,
  type ConflictChoice,
  type UploadItem,
} from './uploads';

/**
 * Bottom-right upload list (3.7). Closing it does not stop uploads. Name clashes open the
 * conflict dialog (3.14) one file at a time.
 */
export function UploadPanel() {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const { items, panelOpen } = useUploads();
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => bindUploads(qc), [qc]);

  const active = items.filter((x) => ['queued', 'uploading', 'paused'].includes(x.status));
  const done = items.filter((x) => x.status === 'done').length;
  const failed = items.filter((x) => x.status === 'error').length;
  const remaining = active.reduce((a, x) => a + (x.sizeBytes - x.loaded), 0);
  const speed = active.reduce((a, x) => a + x.speed, 0);
  const conflict = items.find((x) => x.status === 'conflict');

  return (
    <>
      {panelOpen && items.length ? (
        <section
          aria-label={t('drive.upload.panel')}
          className="fixed right-5 bottom-5 z-40 flex w-[380px] flex-col overflow-hidden rounded-2xl bg-surface shadow-overlay"
        >
          <header className="flex items-center gap-2 border-b border-line px-4 py-3">
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm font-semibold">
                {active.length
                  ? t('drive.upload.uploading', { count: active.length })
                  : t('drive.upload.finished', { count: items.length })}
              </span>
              <span className="text-xs text-fg2">
                {t('drive.upload.summary', { done, failed })}
                {active.length && speed > 0
                  ? ` · ${t('drive.upload.eta', { seconds: formatNumber(Math.ceil(remaining / speed), locale) })}`
                  : ''}
              </span>
            </div>
            <IconButton
              size="xs"
              tone="plain"
              aria-label={collapsed ? t('drive.upload.expand') : t('drive.upload.collapse')}
              onClick={() => setCollapsed(!collapsed)}
            >
              <Icon name={collapsed ? 'chevU' : 'chevD'} size={15} />
            </IconButton>
            <IconButton
              size="xs"
              tone="plain"
              aria-label={t('common.actions.close')}
              onClick={() => {
                clearFinished();
                setUploadPanelOpen(false);
              }}
            >
              <Icon name="x" size={15} />
            </IconButton>
          </header>
          {!collapsed ? (
            <ul className="m-0 flex max-h-[320px] list-none flex-col overflow-y-auto p-1.5">
              {items.map((it) => (
                <UploadRow key={it.id} item={it} />
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
      {conflict ? (
        <ConflictDialog
          item={conflict}
          total={items.filter((x) => x.status === 'conflict').length}
          folderName={conflict.folderName}
        />
      ) : null}
    </>
  );
}

function UploadRow({ item }: { item: UploadItem }) {
  const { t, locale } = useI18n();
  const pick = useRef<HTMLInputElement>(null);
  const pct = item.sizeBytes ? Math.round((item.loaded / item.sizeBytes) * 100) : 100;
  return (
    <li className="flex items-center gap-3 rounded-lg px-2.5 py-2">
      <span className="flex h-9 min-w-9 shrink-0 items-center justify-center rounded-[8px] bg-bg2 px-1 text-[10px] font-bold text-fg2">
        {badgeOf(item.name) || <Icon name="file" size={16} />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-cap font-semibold">{item.name}</span>
        {item.status === 'uploading' || item.status === 'queued' ? (
          <>
            <Progress value={pct} neutral label={item.name} />
            <span className="text-[11px] text-fg2 tn">
              {formatBytes(item.loaded, locale)} / {formatBytes(item.sizeBytes, locale)}
              {item.speed > 0 ? ` · ${formatBytes(item.speed, locale)}/sn` : ''}
            </span>
          </>
        ) : (
          <span
            className={cn(
              'truncate text-[11px]',
              item.status === 'error'
                ? 'text-danger'
                : item.status === 'paused'
                  ? 'text-warning'
                  : 'text-fg2',
            )}
          >
            {item.status === 'done'
              ? t('drive.upload.done', {
                  size: formatBytes(item.sizeBytes, locale),
                  folder: item.folderName,
                })
              : item.status === 'error'
                ? t(`errors.${item.error ?? 'internal'}` as MessageKey)
                : item.status === 'paused'
                  ? t('drive.upload.paused', { pct })
                  : item.status === 'interrupted'
                    ? t('drive.upload.interrupted')
                    : item.status === 'conflict'
                      ? t('drive.upload.conflict')
                      : t('drive.upload.canceled')}
          </span>
        )}
      </div>
      {item.status === 'done' ? (
        <Icon name="checkC" size={18} className="shrink-0 text-success" />
      ) : item.status === 'paused' || item.status === 'error' ? (
        <Button size="xs" onClick={() => retryUpload(item.id)} disabled={!item.file}>
          {t('drive.upload.resume')}
        </Button>
      ) : item.status === 'interrupted' ? (
        <>
          <input
            ref={pick}
            type="file"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f && !resumeWithFile(item.id, f)) window.alert(t('drive.upload.otherFile'));
              e.target.value = '';
            }}
          />
          <Button size="xs" onClick={() => pick.current?.click()}>
            {t('drive.upload.pickAgain')}
          </Button>
        </>
      ) : null}
      {['queued', 'uploading', 'paused', 'interrupted'].includes(item.status) ? (
        <IconButton
          size="xs"
          tone="plain"
          aria-label={t('drive.upload.cancel', { name: item.name })}
          onClick={() => cancelUpload(item.id)}
        >
          <Icon name="x" size={14} />
        </IconButton>
      ) : null}
    </li>
  );
}

/** "Bu adla bir dosya zaten var" (3.14): default is a new version, links and cards stay. */
function ConflictDialog({
  item,
  total,
  folderName,
}: {
  item: UploadItem;
  total: number;
  folderName: string;
}) {
  const { t, locale } = useI18n();
  const [choice, setChoice] = useState<ConflictChoice>('version');
  const [all, setAll] = useState(false);
  const existing = useQuery({
    ...nodeQuery(item.conflictNodeId ?? ''),
    enabled: Boolean(item.conflictNodeId),
  });
  const options: { value: ConflictChoice; key: 'version' | 'replace' | 'rename' }[] = [
    { value: 'version', key: 'version' },
    { value: 'replace', key: 'replace' },
    { value: 'rename', key: 'rename' },
  ];
  const renamed = (() => {
    const dot = item.name.lastIndexOf('.');
    return dot > 0 ? `${item.name.slice(0, dot)} (1)${item.name.slice(dot)}` : `${item.name} (1)`;
  })();
  return (
    <Dialog open onOpenChange={(v) => (v ? null : resolveConflict(item.id, 'skip'))}>
      <DialogContent width={520}>
        <DialogHeader
          icon="alert"
          title={t('drive.conflict.title')}
          description={t('drive.conflict.subtitle', { folder: folderName, count: total })}
        />
        <div className="flex flex-col gap-2">
          {[
            {
              label: t('drive.conflict.existing'),
              meta: existing.data
                ? `${formatBytes(existing.data.sizeBytes, locale)} · ${existing.data.updatedBy?.name.split(' ')[0] ?? ''} · ${formatRelative(existing.data.updatedAt, locale)}${existing.data.version ? ` · s${existing.data.version}` : ''}`
                : '…',
            },
            {
              label: t('drive.conflict.incoming'),
              meta: `${formatBytes(item.sizeBytes, locale)} · ${t('drive.conflict.fromComputer')}`,
            },
          ].map((row) => (
            <div
              key={row.label}
              className="flex items-center gap-3 rounded-lg bg-bg2 px-3.5 py-2.5"
            >
              <span className="flex h-9 min-w-9 items-center justify-center rounded-[8px] bg-surface px-1 text-[10px] font-bold text-fg2">
                {badgeOf(item.name)}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="text-xs text-fg2">{row.label}</span>
                <span className="truncate text-cap font-semibold">{item.name}</span>
                <span className="text-[11px] text-fg3">{row.meta}</span>
              </span>
            </div>
          ))}
        </div>
        <div
          role="radiogroup"
          aria-label={t('drive.conflict.title')}
          className="flex flex-col gap-2"
        >
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={choice === o.value}
              onClick={() => setChoice(o.value)}
              className={cn(
                'flex flex-col items-start gap-0.5 rounded-lg px-3.5 py-2.5 text-left',
                choice === o.value ? 'bg-bg2 shadow-[inset_0_0_0_1.5px_var(--fg)]' : 'shadow-line',
              )}
            >
              <span className="flex items-center gap-2 text-cap font-semibold">
                {t(`drive.conflict.${o.key}`)}
                {o.value === 'version' ? (
                  <span className="rounded-full bg-bg2 px-2 py-0.5 text-[10.5px] text-fg2">
                    {t('drive.conflict.recommended')}
                  </span>
                ) : null}
              </span>
              <span className="text-xs text-fg2">
                {t(`drive.conflict.${o.key}Hint`, {
                  version: (existing.data?.version ?? 0) + 1,
                  name: renamed,
                })}
              </span>
            </button>
          ))}
        </div>
        {total > 1 ? (
          <label className="flex items-center gap-2.5 text-cap">
            <Checkbox checked={all} onCheckedChange={(v) => setAll(v === true)} />
            {t('drive.conflict.applyRest', { count: total - 1 })}
          </label>
        ) : null}
        <DialogFooter className="justify-between">
          <Button variant="gh" onClick={() => resolveConflict(item.id, 'skip')}>
            {t('drive.conflict.skip')}
          </Button>
          <span className="flex gap-2">
            <Button variant="gh" onClick={cancelAllConflicts}>
              {t('drive.conflict.cancelAll')}
            </Button>
            <Button variant="pri" onClick={() => resolveConflict(item.id, choice, all)}>
              {t('common.actions.continue')}
            </Button>
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
