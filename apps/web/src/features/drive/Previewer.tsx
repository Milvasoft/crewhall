import { queryKeys } from '@crewhall/api-client';
import { type DriveNode, type NodeVersion } from '@crewhall/shared';
import {
  Avatar,
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Icon,
  IconButton,
  Skeleton,
  Spinner,
  toast,
  ZoomableImage,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api } from '@/lib/api';
import { useChatEnabled } from '@/lib/chat/enabled';
import { errorKey } from '@/lib/errors';
import { formatBytes, formatDate } from '@/lib/i18n/format';
import { OfficeOpenCard } from '@/components/office/OfficeOpenCard';
import { useOfficeMode } from '@/lib/office/queries';
import { THIN_TITLE_ROW, useLendTitleBarColors } from '@/lib/desktop-titlebar';
import { useI18n } from '@/lib/i18n/I18nContext';
import { invalidateDrive, nodeQuery, versionsQuery } from './api';
import { saveFromUrl, useNodeActions } from './actions';
import { kindOf, languageOf } from './fileKinds';
import { NodeIconBox, typeLabel, when } from './NodeViews';
import { OpenInTool } from '@/features/tools/crewhall/OpenInTool';
import { textMode } from './textEdit';
import { TextFile } from './TextFile';
import { rawPreviewUrl } from './urls';
import { ResizablePane } from '@/components/shell/ResizablePane';

const MAX_LINES = 5000;

/**
 * Full screen viewer (3.8, 3.9): ← → walk the folder's files, Esc closes. Older versions open
 * with a strip; restoring copies them on top as a new version.
 */
export function Previewer({
  nodeId,
  siblings,
  onNavigate,
  onClose,
}: {
  nodeId: string;
  siblings: DriveNode[];
  onNavigate: (id: string) => void;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  // Desktop app: a thin row for the window buttons above the header while the preview is open.
  const header = useRef<HTMLElement>(null);
  useLendTitleBarColors(header, true, THIN_TITLE_ROW);
  const node = useQuery(nodeQuery(nodeId));
  const actions = useNodeActions();
  const chatOn = useChatEnabled();
  const [versionId, setVersionId] = useState<string | null>(null);
  const [tab, setTab] = useState<'info' | 'versions'>('info');
  const files = siblings.filter((n) => n.type === 'file');
  const idx = files.findIndex((n) => n.id === nodeId);
  // Unsaved text edits (TextFile): leaving asks first.
  const [dirty, setDirty] = useState(false);
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  const guard = (go: () => void) => (dirty ? setLeaving(() => go) : go());
  const close = () => guard(onClose);
  const navigate = (id: string) => guard(() => onNavigate(id));

  useEffect(() => {
    void api.call('markNodeOpened', { params: { nodeId } }).catch(() => undefined);
  }, [nodeId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      // Typing in the text editor (CodeMirror is contenteditable) keeps its keys.
      if (['INPUT', 'TEXTAREA'].includes(el.tagName) || el.isContentEditable) return;
      if (e.defaultPrevented || leaving) return;
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowRight' && idx >= 0 && idx < files.length - 1) {
        navigate(files[idx + 1]!.id);
      }
      if (e.key === 'ArrowLeft' && idx > 0) navigate(files[idx - 1]!.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Closing the tab with unsaved text asks the browser's own question.
  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [dirty]);

  const n = node.data;
  // Portalled to the body: a transformed ancestor (page transitions) would otherwise turn
  // `fixed inset-0` into the main area only, under the phone's bottom bar.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={n ? t('drive.preview.label', { name: n.name }) : t('drive.preview.loading')}
      // Desktop app: the header comes under the window buttons (index.css).
      data-desktop-overlay=""
      className="fixed inset-0 z-50 flex flex-col bg-bg text-fg"
    >
      <div data-desktop-band="" data-titlebar-drag="" />
      <header
        ref={header}
        data-titlebar-drag=""
        className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-4"
      >
        {n ? <NodeIconBox node={n} /> : <Skeleton className="size-8" />}
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold">{n?.name}</span>
          <span className="truncate text-xs text-fg2">
            {n
              ? [
                  [n.space.name, ...n.path.map((p) => p.name)].join(' › '),
                  formatBytes(n.sizeBytes, locale),
                  n.version ? t('drive.preview.version', { n: n.version }) : null,
                ]
                  .filter(Boolean)
                  .join(' · ')
              : ''}
          </span>
        </div>
        {files.length > 1 ? (
          <span className="flex items-center gap-1 text-xs text-fg2 tn">
            <IconButton
              size="sm"
              tone="plain"
              aria-label={t('drive.preview.prev')}
              disabled={idx <= 0}
              onClick={() => navigate(files[idx - 1]!.id)}
            >
              <Icon name="chevL" size={16} />
            </IconButton>
            {idx + 1} / {files.length}
            <IconButton
              size="sm"
              tone="plain"
              aria-label={t('drive.preview.next')}
              disabled={idx < 0 || idx >= files.length - 1}
              onClick={() => navigate(files[idx + 1]!.id)}
            >
              <Icon name="chevR" size={16} />
            </IconButton>
          </span>
        ) : null}
        {n ? (
          <>
            <OpenInTool node={n} />
            {/* Phones keep the icons only; the name needs the width. */}
            <Button
              size="sm"
              variant="out"
              aria-label={t('drive.menu.share')}
              onClick={() => actions.share(n)}
            >
              <Icon name="share" size={16} />
              <span className="max-md:hidden">{t('drive.menu.share')}</span>
            </Button>
            {chatOn ? (
              <Button
                size="sm"
                variant="out"
                aria-label={t('chat.refs.sendToChat')}
                onClick={() => actions.sendToChat(n)}
              >
                <Icon name="send" size={16} />
                <span className="max-md:hidden">{t('chat.refs.sendToChat')}</span>
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="inv"
              aria-label={t('drive.menu.download')}
              onClick={() => void actions.download([n])}
            >
              <Icon name="download" size={16} />
              <span className="max-md:hidden">{t('drive.menu.download')}</span>
            </Button>
          </>
        ) : null}
        <IconButton size="sm" tone="plain" aria-label={t('common.actions.close')} onClick={close}>
          <Icon name="x" size={18} />
        </IconButton>
      </header>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col bg-bg2">
          {versionId && n ? (
            <VersionStrip nodeId={n.id} versionId={versionId} onBack={() => setVersionId(null)} />
          ) : null}
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6 max-md:p-2">
            {n ? (
              <Content
                node={n}
                versionId={versionId}
                canEdit={actions.can(n, 'space.edit_content')}
                onDirty={setDirty}
              />
            ) : (
              <Spinner />
            )}
          </div>
        </div>
        <ResizablePane id="drive-preview" side="right" defaultWidth={320} className="max-md:hidden">
          <aside className="flex w-full min-w-0 flex-col border-l border-line bg-bg">
            <div role="tablist" className="flex gap-5 border-b border-line px-4">
              {(['info', 'versions'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={tab === k}
                  onClick={() => setTab(k)}
                  className={cn(
                    'relative h-[42px] text-nav font-medium text-fg2',
                    tab === k &&
                      'font-semibold text-fg after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-[2px] after:bg-accent',
                  )}
                >
                  {t(`drive.preview.tabs.${k}`)}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {n && tab === 'info' ? (
                <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 text-cap">
                  <dt className="text-fg2">{t('drive.details.type')}</dt>
                  <dd className="m-0">{typeLabel(n, t)}</dd>
                  <dt className="text-fg2">{t('drive.details.location')}</dt>
                  <dd className="m-0">
                    {[n.space.name, ...n.path.map((p) => p.name)].join(' › ')}
                  </dd>
                  <dt className="text-fg2">{t('drive.details.owner')}</dt>
                  <dd className="m-0">{n.createdBy?.name ?? '—'}</dd>
                  <dt className="text-fg2">{t('drive.details.updated')}</dt>
                  <dd className="m-0">{when(n.updatedAt, locale)}</dd>
                  <dt className="text-fg2">{t('drive.details.size')}</dt>
                  <dd className="m-0">{formatBytes(n.sizeBytes, locale)}</dd>
                </dl>
              ) : n ? (
                <VersionList node={n} viewing={versionId} onView={setVersionId} />
              ) : null}
            </div>
          </aside>
        </ResizablePane>
      </div>
      <Dialog open={leaving !== null} onOpenChange={(o) => (o ? null : setLeaving(null))}>
        <DialogContent width={420}>
          <DialogHeader
            icon="alert"
            title={t('drive.text.leaveTitle')}
            description={t('drive.text.leaveBody', { name: n?.name ?? '' })}
          />
          <DialogFooter>
            <Button variant="gh" onClick={() => setLeaving(null)}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="dngf"
              onClick={() => {
                const go = leaving;
                setLeaving(null);
                setDirty(false);
                go?.();
              }}
            >
              {t('drive.text.leave')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>,
    document.body,
  );
}

function useDownloadUrl(nodeId: string, versionId: string | null) {
  return useQuery({
    queryKey: [...queryKeys.node(nodeId), 'download', versionId],
    queryFn: ({ signal }) =>
      api.call('getDownloadUrl', {
        params: { nodeId },
        query: { versionId: versionId ?? undefined },
        signal,
      }),
    staleTime: 4 * 60_000,
  });
}

function Content({
  node,
  versionId,
  canEdit,
  onDirty,
}: {
  node: DriveNode;
  versionId: string | null;
  canEdit: boolean;
  onDirty: (dirty: boolean) => void;
}) {
  const { t } = useI18n();
  const url = useDownloadUrl(node.id, versionId);
  const officeMode = useOfficeMode();
  if (url.isLoading) return <Spinner />;
  if (url.isError || !url.data) return <NoPreview node={node} reason={t(errorKey(url.error))} />;
  // Word, Excel and PowerPoint files open in the office editor when the org has one.
  const office = officeMode(node, canEdit);
  if (!versionId && office) return <OfficeOpenCard node={node} mode={office} />;
  // The current version of a text file opens in the editor; older versions stay read-only.
  if (!versionId && textMode(node, canEdit) !== 'none') {
    return (
      <TextFile key={node.id} node={node} url={url.data.url} canEdit={canEdit} onDirty={onDirty} />
    );
  }
  return (
    <MediaView
      name={node.name}
      mime={node.mime}
      url={url.data.url}
      posterUrl={node.preview === 'ready' ? rawPreviewUrl(node.id, 'poster') : undefined}
      fallback={<NoPreview node={node} reason={t('drive.preview.unsupported')} />}
    />
  );
}

/** Shows a file from a (signed) URL by kind; shared by the Drive viewer and public links. */
export function MediaView({
  name,
  mime,
  url,
  posterUrl,
  fallback,
}: {
  name: string;
  mime: string | null;
  url: string;
  posterUrl?: string;
  fallback: ReactNode;
}) {
  switch (kindOf(name, mime)) {
    case 'image':
      // The shared viewer's image: wheel zoom, drag to pan, double click.
      return <ZoomableImage src={url} name={name} />;
    case 'pdf':
      return <PdfFrame name={name} url={url} fallback={fallback} />;
    case 'video':
      return (
        <video
          src={url}
          controls
          poster={posterUrl}
          className="max-h-full max-w-full rounded-lg bg-black shadow-overlay"
        />
      );
    case 'audio':
      return <audio src={url} controls className="w-full max-w-[480px]" />;
    case 'code':
    case 'text':
      return <TextView name={name} url={url} />;
    default:
      return <>{fallback}</>;
  }
}

function NoPreview({ node, reason }: { node: DriveNode; reason: string }) {
  const { t } = useI18n();
  const actions = useNodeActions();
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <NodeIconBox node={node} size="lg" />
      <span className="text-sub font-semibold">{node.name}</span>
      <span className="max-w-[360px] text-sm text-fg2">{reason}</span>
      <Button variant="inv" onClick={() => void actions.download([node])}>
        <Icon name="download" size={16} />
        {t('drive.menu.download')}
      </Button>
    </div>
  );
}

/**
 * Signed download URLs carry `Content-Disposition: attachment`, which makes an iframe
 * download instead of show the PDF. Fetch it (the store allows CORS) and frame a blob URL.
 */
function PdfFrame({ name, url, fallback }: { name: string; url: string; fallback: ReactNode }) {
  const blob = useQuery({
    queryKey: ['blob-pdf', url],
    queryFn: async ({ signal }) => {
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`pdf ${res.status}`);
      const data = new Blob([await res.arrayBuffer()], { type: 'application/pdf' });
      return URL.createObjectURL(data);
    },
    staleTime: Infinity,
    gcTime: 0,
  });
  const src = blob.data;
  useEffect(() => (src ? () => URL.revokeObjectURL(src) : undefined), [src]);
  if (blob.isError) return <>{fallback}</>;
  if (!src) return <Spinner />;
  return <iframe src={src} title={name} className="size-full rounded-lg bg-white shadow-overlay" />;
}

/** Line-numbered text with an outline of YAML / JSON top-level keys (3.9). */
function TextView({ name, url }: { name: string; url: string }) {
  const { t } = useI18n();
  const [wrap, setWrap] = useState(false);
  const text = useQuery({
    queryKey: ['blob-text', url],
    queryFn: async ({ signal }) => (await fetch(url, { signal })).text(),
    staleTime: Infinity,
  });
  if (text.isLoading) return <Spinner />;
  const all = (text.data ?? '').replace(/\r\n/g, '\n').split('\n');
  const lines = all.slice(0, MAX_LINES);
  const language = languageOf(name);
  const outline = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => /^\s{0,2}[A-Za-z0-9_.-]+\s*:/.test(l) && !l.trim().startsWith('#'))
    .slice(0, 40)
    .map(({ l, i }) => ({
      key: l.trim().replace(/:.*$/, ''),
      line: i + 1,
      depth: l.search(/\S/) > 0 ? 1 : 0,
    }));

  return (
    <div className="flex size-full min-h-0 gap-4">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-surface shadow-line">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3 text-xs text-fg2">
          {language ? (
            <span className="rounded-xs bg-bg2 px-1.5 py-0.5 font-semibold">{language}</span>
          ) : null}
          <span className="flex-1" />
          <Button
            size="xs"
            variant={wrap ? 'inv' : 'gh'}
            aria-pressed={wrap}
            onClick={() => setWrap(!wrap)}
          >
            {t('drive.preview.wrap')}
          </Button>
          <Button
            size="xs"
            variant="gh"
            onClick={() => {
              void navigator.clipboard?.writeText(text.data ?? '');
              toast(t('drive.preview.copied'));
            }}
          >
            <Icon name="copy" size={14} />
            {t('drive.preview.copy')}
          </Button>
        </div>
        <pre
          className={cn(
            'm-0 min-h-0 flex-1 overflow-auto py-2 font-mono text-[12.5px] leading-[20px]',
            wrap ? 'whitespace-pre-wrap' : 'whitespace-pre',
          )}
        >
          {lines.map((l, i) => (
            <div key={i} id={`L${i + 1}`} className="flex">
              <span className="w-12 shrink-0 pr-3 text-right text-fg3 select-none">{i + 1}</span>
              <span className={cn('min-w-0 flex-1 pr-4', l.trim().startsWith('#') && 'text-fg3')}>
                {l || ' '}
              </span>
            </div>
          ))}
        </pre>
        {all.length > MAX_LINES ? (
          <div className="border-t border-line px-3 py-2 text-xs text-fg2">
            {t('drive.preview.truncated', { count: MAX_LINES })}
          </div>
        ) : null}
      </div>
      {outline.length ? (
        <nav
          aria-label={t('drive.preview.outline')}
          className="hidden w-[180px] shrink-0 flex-col gap-0.5 xl:flex"
        >
          <span className="eyebrow mb-1">{t('drive.preview.outline')}</span>
          {outline.map((o) => (
            <a
              key={o.line}
              href={`#L${o.line}`}
              className={cn(
                'flex justify-between rounded-xs px-2 py-1 text-xs hover:bg-bg2',
                o.depth ? 'pl-4 text-fg2' : 'font-semibold',
              )}
            >
              <span className="truncate">{o.key}</span>
              <span className="text-fg3 tn">{o.line}</span>
            </a>
          ))}
        </nav>
      ) : null}
    </div>
  );
}

export function VersionList({
  node,
  viewing,
  onView,
}: {
  node: DriveNode;
  viewing?: string | null;
  onView?: (versionId: string | null) => void;
}) {
  const { t, locale } = useI18n();
  const versions = useQuery(versionsQuery(node.id));
  const restore = useRestore(node.id);
  const canEdit = useNodeActions().can(node, 'space.edit_content');
  if (versions.isLoading) return <Skeleton className="h-24 w-full" />;
  return (
    <div className="flex flex-col gap-2">
      {(versions.data?.items ?? []).map((v: NodeVersion) => (
        <div
          key={v.id}
          className={cn(
            'flex flex-col gap-1.5 rounded-lg p-3',
            viewing === v.id ? 'shadow-[inset_0_0_0_1.5px_var(--fg)]' : 'shadow-line',
          )}
        >
          <div className="flex items-center gap-2">
            <span className="text-cap font-semibold">
              {t('drive.preview.version', { n: v.version })}
            </span>
            {v.current ? (
              <span className="rounded-full bg-bg2 px-2 py-0.5 text-[10.5px] font-semibold text-fg2">
                {t('drive.versions.current')}
              </span>
            ) : null}
            <span className="flex-1" />
            {!v.current && onView ? (
              <Button size="xs" variant="gh" onClick={() => onView(viewing === v.id ? null : v.id)}>
                {t('drive.versions.view')}
              </Button>
            ) : null}
            {!v.current && canEdit ? (
              <Button
                size="xs"
                loading={restore.isPending && restore.variables === v.id}
                onClick={() => restore.mutate(v.id)}
              >
                {t('drive.versions.restore')}
              </Button>
            ) : null}
          </div>
          <span className="flex items-center gap-2 text-xs text-fg2">
            {v.createdBy ? <Avatar name={v.createdBy.name} size="sm" /> : null}
            {v.createdBy?.name.split(' ')[0]} ·{' '}
            {formatDate(v.createdAt, locale, {
              day: 'numeric',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit',
            })}{' '}
            · {formatBytes(v.sizeBytes, locale)}
          </span>
          {v.label ? <span className="text-xs text-fg">"{v.label}"</span> : null}
        </div>
      ))}
      <p className="m-0 text-xs text-fg3">{t('drive.versions.policy')}</p>
    </div>
  );
}

function useRestore(nodeId: string) {
  const { t } = useI18n();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (versionId: string) =>
      api.call('restoreVersion', { params: { nodeId, versionId } }),
    onSuccess: (v) => {
      invalidateDrive(qc);
      void qc.invalidateQueries({ queryKey: queryKeys.versions(nodeId) });
      toast(t('drive.versions.restored', { n: v.version }));
    },
    onError: (e) => toast(t(errorKey(e))),
  });
}

function VersionStrip({
  nodeId,
  versionId,
  onBack,
}: {
  nodeId: string;
  versionId: string;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const versions = useQuery(versionsQuery(nodeId));
  const restore = useRestore(nodeId);
  const v = versions.data?.items.find((x) => x.id === versionId);
  const url = useDownloadUrl(nodeId, versionId);
  return (
    <div className="flex shrink-0 items-center gap-3 bg-[color-mix(in_srgb,var(--warning)_14%,var(--bg))] px-4 py-2 text-cap">
      <Icon name="history" size={16} />
      <span className="flex-1 font-semibold">
        {t('drive.versions.viewing', { n: v?.version ?? '' })}
      </span>
      {url.data ? (
        <Button size="xs" variant="gh" onClick={() => saveFromUrl(url.data.url, url.data.fileName)}>
          {t('drive.menu.download')}
        </Button>
      ) : null}
      <Button
        size="xs"
        loading={restore.isPending}
        onClick={() => restore.mutate(versionId, { onSuccess: onBack })}
      >
        {t('drive.versions.restore')}
      </Button>
      <Button size="xs" variant="inv" onClick={onBack}>
        {t('drive.versions.backToCurrent')}
      </Button>
    </div>
  );
}
