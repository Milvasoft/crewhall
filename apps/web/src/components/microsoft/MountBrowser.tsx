import { MICROSOFT_RAW_PATHS, type MountItem } from '@crewhall/shared';
import { Badge, Button, Icon, Input, Skeleton, toast } from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { Notice } from '@/components/auth/AuthLayout';
import { Workspace } from '@/components/shell/Workspace';
import { config } from '@/config';
import { api, ApiError } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { formatBytes, formatRelative } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { microsoftKeys } from '@/lib/microsoft/queries';

/**
 * External storage in Drive (SharePoint, OneDrive, SMB): the space's mounts above its root
 * folder, and a live browser of one mount. Nothing is copied unless "Drive'a kopyala".
 */
export function SpaceMounts({ spaceId, spaceSlug }: { spaceId: string; spaceSlug: string }) {
  const { t } = useI18n();
  const mounts = useQuery({
    queryKey: microsoftKeys.spaceMounts(spaceId),
    queryFn: () => api.call('listSpaceMounts', { params: { spaceId } }),
    staleTime: 60_000,
  });
  const items = mounts.data?.items ?? [];
  if (!items.length) return null;
  return (
    <nav aria-label={t('microsoft.drive.mounts')} className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-semibold text-fg2">{t('microsoft.drive.mounts')}</span>
      {items.map((m) => (
        <Button key={m.id} asChild size="sm" variant="out">
          <Link to="/drive/$spaceSlug/mount/$mountId" params={{ spaceSlug, mountId: m.id }}>
            <Icon name="folder" size={16} />
            {m.name}
          </Link>
        </Button>
      ))}
    </nav>
  );
}

const parentOf = (path: string) => path.split('/').slice(0, -1).join('/');

export function MountPage({
  spaceSlug,
  spaceId,
  mountId,
  path,
}: {
  spaceSlug: string;
  spaceId: string;
  mountId: string;
  path: string;
}) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const fileInput = useRef<HTMLInputElement>(null);
  const [folderName, setFolderName] = useState('');
  const listing = useQuery({
    queryKey: microsoftKeys.listing(mountId, path),
    queryFn: () => api.call('listMountItems', { params: { mountId }, query: { path } }),
  });
  const refresh = () =>
    void qc.invalidateQueries({ queryKey: microsoftKeys.listing(mountId, path) });
  const go = (next: string) =>
    void navigate({
      to: '/drive/$spaceSlug/mount/$mountId',
      params: { spaceSlug, mountId },
      search: next ? { path: next } : {},
    });

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      for (const file of files) {
        const url = new URL(MICROSOFT_RAW_PATHS.mountUpload(mountId), config.apiUrl);
        url.searchParams.set('path', path);
        url.searchParams.set('name', file.name);
        const res = await fetch(url, {
          method: 'PUT',
          credentials: 'include',
          headers: { 'content-type': file.type || 'application/octet-stream' },
          body: file,
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            code?: string;
            message?: string;
          } | null;
          throw new ApiError(res.status, (body?.code ?? 'internal') as never, body?.message ?? '');
        }
      }
    },
    onSuccess: refresh,
    onError: (e) => toast.error(t(errorKey(e))),
  });
  const mkdir = useMutation({
    mutationFn: () =>
      api.call('createMountFolder', {
        params: { mountId },
        body: { path, name: folderName.trim() },
      }),
    onSuccess: () => {
      setFolderName('');
      refresh();
    },
    onError: (e) => toast.error(t(errorKey(e))),
  });
  const copy = useMutation({
    mutationFn: () =>
      api.call('startMountImport', {
        body: { source: { kind: 'mount', mountId, path }, target: { spaceId, parentId: null } },
      }),
    onSuccess: () => toast(t('microsoft.drive.copyStarted')),
    onError: (e) => toast.error(t(errorKey(e))),
  });
  const download = (item: MountItem) => {
    const url = new URL(MICROSOFT_RAW_PATHS.mountDownload(mountId), config.apiUrl);
    url.searchParams.set('path', item.path);
    return url.toString();
  };

  const mount = listing.data?.mount;
  const segments = path ? path.split('/') : [];
  return (
    <Workspace crumbs={[{ label: t('microsoft.drive.mounts') }, { label: mount?.name ?? '' }]}>
      <div className="flex flex-col gap-4 pb-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex min-w-0 flex-col">
            <h1 className="m-0 flex items-center gap-2 truncate text-wtitle font-bold">
              {mount?.name ?? <Skeleton className="h-7 w-48" />}
              {mount?.readOnly ? <Badge>{t('microsoft.drive.readOnly')}</Badge> : null}
            </h1>
            <span className="truncate text-cap text-fg2">{mount?.location}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="out" loading={copy.isPending} onClick={() => copy.mutate()}>
              <Icon name="copy" size={16} />
              {t('microsoft.drive.copyToDrive')}
            </Button>
            {listing.data?.canWrite ? (
              <>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  hidden
                  aria-label={t('microsoft.drive.upload')}
                  onChange={(e) => {
                    upload.mutate([...(e.target.files ?? [])]);
                    e.target.value = '';
                  }}
                />
                <Button
                  size="sm"
                  variant="inv"
                  loading={upload.isPending}
                  onClick={() => fileInput.current?.click()}
                >
                  <Icon name="upload" size={16} />
                  {t('microsoft.drive.upload')}
                </Button>
              </>
            ) : null}
          </div>
        </div>
        <nav
          aria-label={t('microsoft.drive.mounts')}
          className="flex flex-wrap items-center gap-1 text-cap"
        >
          <Button size="sm" variant="gh" onClick={() => go('')}>
            {t('microsoft.drive.root')}
          </Button>
          {segments.map((s, i) => (
            <span key={`${i}-${s}`} className="flex items-center gap-1">
              <span className="text-fg3">/</span>
              <Button size="sm" variant="gh" onClick={() => go(segments.slice(0, i + 1).join('/'))}>
                {s}
              </Button>
            </span>
          ))}
        </nav>
        {listing.data?.canWrite ? (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              mkdir.mutate();
            }}
          >
            <Input
              className="max-w-xs"
              value={folderName}
              onChange={(e) => setFolderName(e.target.value)}
              placeholder={t('microsoft.drive.folderName')}
              aria-label={t('microsoft.drive.folderName')}
            />
            <Button
              type="submit"
              size="sm"
              variant="out"
              disabled={!folderName.trim()}
              loading={mkdir.isPending}
            >
              <Icon name="plus" size={16} />
              {t('microsoft.drive.newFolder')}
            </Button>
          </form>
        ) : null}
        {listing.isError ? (
          <Notice tone="error">{t(errorKey(listing.error))}</Notice>
        ) : !listing.data ? (
          <Skeleton className="h-40 rounded-xl" />
        ) : listing.data.items.length === 0 ? (
          <span className="text-cap text-fg2">{t('microsoft.drive.empty')}</span>
        ) : (
          <ul className="m-0 flex list-none flex-col rounded-xl bg-surface p-0 shadow-line">
            {path ? (
              <li className="border-b border-line">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-cap"
                  onClick={() => go(parentOf(path))}
                >
                  <Icon name="folder" size={16} />
                  ..
                </button>
              </li>
            ) : null}
            {listing.data.items.map((item) => (
              <li
                key={item.path}
                className="flex items-center gap-3 border-b border-line px-3 py-2 last:border-b-0"
              >
                <Icon name={item.type === 'folder' ? 'folder' : 'file'} size={16} />
                {item.type === 'folder' ? (
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left text-cap font-semibold"
                    onClick={() => go(item.path)}
                  >
                    {item.name}
                  </button>
                ) : (
                  <span className="min-w-0 flex-1 truncate text-cap">{item.name}</span>
                )}
                <span className="hidden w-24 text-right text-xs text-fg2 sm:block">
                  {item.sizeBytes !== null ? formatBytes(item.sizeBytes, locale) : ''}
                </span>
                <span className="hidden w-32 text-right text-xs text-fg2 md:block">
                  {item.modifiedAt ? formatRelative(item.modifiedAt, locale) : ''}
                </span>
                {item.type === 'file' ? (
                  <Button asChild size="sm" variant="gh">
                    <a
                      href={download(item)}
                      download
                      aria-label={`${t('microsoft.drive.download')}: ${item.name}`}
                    >
                      <Icon name="download" size={16} />
                    </a>
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Workspace>
  );
}
