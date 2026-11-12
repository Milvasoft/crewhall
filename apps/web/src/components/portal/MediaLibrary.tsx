import { type PortalMedia } from '@crewhall/shared';
import {
  Button,
  Chip,
  cn,
  EmptyState,
  Icon,
  IconButton,
  Skeleton,
  toast,
  Tooltip,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { formatBytes } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { invalidatePortal, mediaQuery, type MediaFilter } from '@/lib/portal/api';
import { usePortalSite } from '@/lib/portal/context';
import { localeName, localeTag } from '@/lib/portal/format';
import { replacePortalFile, uploadPortalFile } from '@/lib/portal/media';
import { ConfirmDialog, FieldRow, LocaleTag, PageHeader, smallInput, useWhen } from './common';
import { MediaThumb } from './MediaPicker';
import { PortalPage } from './PortalPage';
import { ResizablePane } from '@/components/shell/ResizablePane';

const FILTERS: MediaFilter[] = ['all', 'image', 'document', 'unused'];

/** 10.14 Media library: permanent /media paths, per-language alt text, usage, replace. */
export function MediaLibrary() {
  const { t } = useI18n();
  const { site } = usePortalSite();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const search = useSearch({ from: '/_app/portal/$siteSlug/media' });
  const filter = search.filter ?? 'all';
  const all = useQuery(mediaQuery(site.id, 'all'));
  const list = useQuery(mediaQuery(site.id, filter));
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const items = list.data?.items ?? [];
  const selected = all.data?.items.find((m) => m.id === search.sel);
  const counts: Record<MediaFilter, number | undefined> = {
    all: all.data?.items.length,
    image: all.data?.items.filter((m) => m.mime?.startsWith('image/')).length,
    document: all.data?.items.filter((m) => !m.mime?.startsWith('image/')).length,
    unused: all.data?.items.filter((m) => m.usage.length === 0).length,
  };
  const go = (patch: { sel?: string; filter?: MediaFilter }) =>
    void navigate({
      to: '/portal/$siteSlug/media',
      params: { siteSlug: site.slug },
      search: { sel: search.sel, filter: search.filter, ...patch },
      replace: true,
    });

  const upload = async (files: File[]) => {
    setUploading((n) => n + files.length);
    for (const file of files) {
      try {
        const m = await uploadPortalFile(
          site.id,
          file,
          file.type.startsWith('image/') ? 'img' : 'files',
        );
        go({ sel: m.id });
      } catch (e) {
        toast(t(errorKey(e)));
      } finally {
        setUploading((n) => n - 1);
      }
    }
    invalidatePortal(qc);
  };

  return (
    <PortalPage
      crumbs={[{ label: t('portal.nav.media') }]}
      panel={
        selected ? (
          <MediaPanel key={selected.id} media={selected} onClose={() => go({ sel: undefined })} />
        ) : null
      }
    >
      <PageHeader
        title={t('portal.nav.media')}
        subtitle={t('portal.media.subtitle')}
        actions={
          site.capabilities.edit ? (
            <>
              <input
                ref={input}
                type="file"
                multiple
                hidden
                data-testid="portal-media-input"
                onChange={(e) => {
                  const files = [...(e.target.files ?? [])];
                  e.target.value = '';
                  if (files.length) void upload(files);
                }}
              />
              <Button
                variant="inv"
                size="sm"
                loading={uploading > 0}
                onClick={() => input.current?.click()}
              >
                <Icon name="upload" size={16} />
                {t('portal.media.upload')}
              </Button>
            </>
          ) : null
        }
      />
      <div role="group" aria-label={t('portal.media.filter')} className="flex gap-1.5">
        {FILTERS.map((f) => (
          <Chip
            key={f}
            on={filter === f}
            onClick={() => go({ filter: f === 'all' ? undefined : f })}
          >
            {t(`portal.media.filters.${f}`)}
            {counts[f] !== undefined ? (
              <span className="text-xs opacity-70">{counts[f]}</span>
            ) : null}
          </Chip>
        ))}
      </div>
      <div
        className="grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-3"
        onDragOver={(e) =>
          site.capabilities.edit && e.dataTransfer.types.includes('Files') && e.preventDefault()
        }
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          void upload([...e.dataTransfer.files]);
        }}
      >
        {list.isPending ? (
          [0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="aspect-[4/3] rounded-2xl" />)
        ) : !items.length ? (
          <EmptyState className="col-span-full" icon="image" title={t('portal.media.empty')} />
        ) : (
          items.map((m) => (
            <button
              key={m.id}
              type="button"
              aria-pressed={m.id === search.sel}
              onClick={() => go({ sel: m.id })}
              className={cn(
                'flex flex-col overflow-hidden rounded-2xl bg-surface text-left shadow-line',
                m.id === search.sel && 'shadow-[inset_0_0_0_2px_var(--fg)]',
              )}
            >
              <span className="relative aspect-[4/3] w-full overflow-hidden">
                <MediaThumb media={m} />
                <span className="absolute top-2 left-2 rounded-[5px] bg-black/55 px-1.5 py-0.5 text-[10px] font-bold text-white">
                  {(m.fileName.split('.').pop() ?? '').toUpperCase()}
                </span>
              </span>
              <span className="flex flex-col px-3 py-2">
                <span className="truncate text-[13px] font-semibold">{m.fileName}</span>
                <span className="truncate text-xs text-fg2">
                  {m.usage.length === 0
                    ? t('portal.media.unused')
                    : m.usage.length === 1
                      ? m.usage[0]!.title
                      : t('portal.media.usedIn', { count: m.usage.length })}
                </span>
              </span>
            </button>
          ))
        )}
      </div>
    </PortalPage>
  );
}

function MediaPanel({ media, onClose }: { media: PortalMedia; onClose: () => void }) {
  const { t, locale } = useI18n();
  const { site } = usePortalSite();
  const qc = useQueryClient();
  const when = useWhen();
  const [alt, setAlt] = useState(media.alt);
  const [confirm, setConfirm] = useState(false);
  const replaceInput = useRef<HTMLInputElement>(null);
  const canEdit = site.capabilities.edit;
  const saveAlt = useMutation({
    mutationFn: (next: Record<string, string>) =>
      api.call('updatePortalMedia', { params: { mediaId: media.id }, body: { alt: next } }),
    onSuccess: () => invalidatePortal(qc),
    onError: (e) => toast(t(errorKey(e))),
  });
  const replace = useMutation({
    mutationFn: (file: File) => replacePortalFile(media.id, file),
    onSuccess: () => {
      invalidatePortal(qc);
      toast(t('portal.media.replaced'));
    },
    onError: (e) => toast(t(errorKey(e))),
  });
  const used = media.usage.length > 0;

  return (
    <ResizablePane id="portal-media" side="right" defaultWidth={340}>
      <aside
        aria-label={media.fileName}
        className="flex w-full min-w-0 flex-col gap-4 overflow-y-auto border-l border-line px-5 py-4"
      >
        <div className="flex items-center gap-2">
          <h2 className="m-0 min-w-0 flex-1 truncate text-sub font-semibold">{media.fileName}</h2>
          <IconButton
            aria-label={t('portal.common.close')}
            size="sm"
            tone="plain"
            onClick={onClose}
          >
            <Icon name="x" size={16} />
          </IconButton>
        </div>
        <div className="aspect-[4/3] w-full overflow-hidden rounded-xl">
          <MediaThumb media={media} />
        </div>
        <dl className="flex flex-col gap-2 text-[13px]">
          <div className="flex justify-between gap-3">
            <dt className="text-fg2">{t('portal.media.size')}</dt>
            <dd className="m-0 tn">
              {[
                media.width && media.height ? `${media.width} × ${media.height}` : null,
                formatBytes(media.size, locale),
              ]
                .filter(Boolean)
                .join(' · ')}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-fg2">{t('portal.media.uploadedBy')}</dt>
            <dd className="m-0 truncate">
              {[media.createdBy?.name, when(media.createdAt, true)].filter(Boolean).join(' · ')}
            </dd>
          </div>
        </dl>
        <FieldRow label={t('portal.media.url')}>
          <div className="flex items-center gap-1.5 rounded-md bg-bg2 py-1 pr-1 pl-3">
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{media.path}</span>
            <IconButton
              aria-label={t('portal.media.copyPath')}
              size="xs"
              tone="plain"
              onClick={() =>
                void navigator.clipboard.writeText(media.path).then(
                  () => toast(t('portal.common.copied')),
                  () => undefined,
                )
              }
            >
              <Icon name="copy" size={14} />
            </IconButton>
          </div>
        </FieldRow>
        {media.mime?.startsWith('image/')
          ? site.locales.map((l) => (
              <FieldRow
                key={l}
                label={t('portal.media.alt', { language: localeTag(l) })}
                htmlFor={`alt-${l}`}
              >
                <input
                  id={`alt-${l}`}
                  className={smallInput}
                  value={alt[l] ?? ''}
                  disabled={!canEdit}
                  placeholder={localeName(l, locale)}
                  onChange={(e) => setAlt({ ...alt, [l]: e.target.value })}
                  onBlur={() => {
                    if (JSON.stringify(alt) !== JSON.stringify(media.alt)) {
                      saveAlt.mutate(
                        Object.fromEntries(Object.entries(alt).filter(([, v]) => v.trim())),
                      );
                    }
                  }}
                />
              </FieldRow>
            ))
          : null}
        <section className="flex flex-col gap-1.5">
          <span className="eyebrow">{t('portal.media.usage')}</span>
          {!used ? (
            <span className="text-[13px] text-fg2">{t('portal.media.unused')}</span>
          ) : (
            media.usage.map((u, i) => (
              <div key={`${u.kind}-${u.id ?? i}`} className="flex items-center gap-2 text-[13px]">
                <span className="text-xs text-fg3">{t(`portal.kind.${u.kind}`)}</span>
                {u.kind === 'doc' && u.id ? (
                  <Link
                    to="/portal/$siteSlug/docs"
                    params={{ siteSlug: site.slug }}
                    search={{ doc: u.id }}
                    className="min-w-0 flex-1 truncate font-semibold hover:underline"
                  >
                    {u.title}
                  </Link>
                ) : u.kind === 'post' && u.id ? (
                  <Link
                    to="/portal/$siteSlug/blog/$postId"
                    params={{ siteSlug: site.slug, postId: u.id }}
                    className="min-w-0 flex-1 truncate font-semibold hover:underline"
                  >
                    {u.title}
                  </Link>
                ) : (
                  <span className="min-w-0 flex-1 truncate font-semibold">{u.title}</span>
                )}
                {u.locale ? <LocaleTag code={u.locale} /> : null}
              </div>
            ))
          )}
        </section>
        {canEdit ? (
          <div className="mt-auto flex gap-2">
            <input
              ref={replaceInput}
              type="file"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) replace.mutate(file);
              }}
            />
            <Button
              variant="out"
              size="sm"
              className="flex-1"
              loading={replace.isPending}
              onClick={() => replaceInput.current?.click()}
            >
              {t('portal.media.replace')}
            </Button>
            <Tooltip content={used ? t('portal.media.inUse') : t('portal.common.delete')}>
              <span className="flex flex-1">
                <Button
                  variant="dng"
                  size="sm"
                  className="flex-1"
                  disabled={used}
                  onClick={() => setConfirm(true)}
                >
                  {t('portal.common.delete')}
                </Button>
              </span>
            </Tooltip>
          </div>
        ) : null}
        <ConfirmDialog
          open={confirm}
          onOpenChange={setConfirm}
          danger
          title={t('portal.media.deleteTitle', { name: media.fileName })}
          description={t('portal.media.deleteBody')}
          confirm={t('portal.common.delete')}
          onConfirm={async () => {
            try {
              await api.call('deletePortalMedia', { params: { mediaId: media.id } });
              invalidatePortal(qc);
              onClose();
            } catch (e) {
              toast(t(errorKey(e)));
            }
          }}
        />
      </aside>
    </ResizablePane>
  );
}
