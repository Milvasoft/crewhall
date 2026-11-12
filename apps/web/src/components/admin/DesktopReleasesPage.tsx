import {
  type DesktopFileKind,
  type DesktopPlatform,
  type DesktopReleaseVersion,
} from '@crewhall/shared';
import {
  Badge,
  Button,
  CheckboxRow,
  cn,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  Icon,
  IconButton,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  NARROW_QUERY,
  Progress,
  Segmented,
  Skeleton,
  Table,
  Td,
  Th,
  Tr,
  toast,
  useMediaQuery,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { PageHeader, SettingsCard } from '@/components/admin/Settings';
import { Notice } from '@/components/auth/AuthLayout';
import { ConfirmDialog } from '@/components/identity/parts';
import { Workspace } from '@/components/shell/Workspace';
import { desktopReleasesQuery, setPlatformReleases } from '@/features/desktopReleases/api';
import {
  ACCEPT,
  fileKind,
  MAIN_KIND,
  tooLarge,
  refusedForSize,
  VERSION_PATTERN,
  versionOf,
} from '@/features/desktopReleases/files';
import {
  abortUpload,
  canResume,
  DesktopUploadError,
  MissingEtagError,
  type MultipartState,
  uploadDesktopFile,
} from '@/features/desktopReleases/upload';
import { api, isApiError } from '@/lib/api';
import { formatBytes, formatDate, formatTime } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { newId } from '@/lib/ids';

/**
 * Yönetim › Masaüstü sürümleri (docker/README "Masaüstü uygulaması güncellemeleri", option 3):
 * the install admin drops the installers, they go straight to the bucket with presigned PUTs, and
 * "Yayınla" has the server hash them and write latest.yml. An older version can be published again
 * (going back); the live one cannot be deleted.
 */
export function DesktopReleasesPage() {
  const { t } = useI18n();
  const [platform, setPlatform] = useState<DesktopPlatform>('win');
  const releases = useQuery(desktopReleasesQuery);
  const mine = releases.data?.platforms.find((p) => p.platform === platform);
  const fromFolder = mine?.servedFrom === 'folder';
  const forbidden = isApiError(releases.error, 'forbidden');

  return (
    <Workspace
      crumbs={[{ label: t('admin.title') }, { label: t('admin.desktop.nav') }]}
      searchLabel={t('admin.searchSettings')}
    >
      <PageHeader
        title={t('admin.desktop.title')}
        subtitle={t('admin.desktop.subtitle')}
        actions={
          <Segmented
            aria-label={t('admin.desktop.platform')}
            value={platform}
            onValueChange={setPlatform}
            options={[
              { value: 'win', label: t('admin.desktop.platforms.win') },
              { value: 'mac', label: t('admin.desktop.platforms.mac') },
            ]}
          />
        }
      />
      {releases.isError ? (
        <Notice tone={forbidden ? 'info' : 'error'} className="mt-5">
          {forbidden
            ? t('admin.desktop.forbidden')
            : isApiError(releases.error)
              ? t(`errors.${releases.error.code}`)
              : t('errors.internal')}
        </Notice>
      ) : !releases.data ? (
        <Skeleton className="mt-5 h-96 w-full rounded-2xl" />
      ) : (
        <div className="mt-5 grid grid-cols-1 items-start gap-5 pb-10">
          {!releases.data.storage ? (
            <Notice tone="warn">{t('errors.desktop_storage_missing')}</Notice>
          ) : fromFolder ? (
            <Notice tone="warn">{t('admin.desktop.folder')}</Notice>
          ) : null}
          {/* Keyed: switching platform starts a fresh selection (and cancels running uploads). */}
          <UploadCard
            key={platform}
            platform={platform}
            disabled={!releases.data.storage}
            canPublish={!fromFolder}
          />
          <SettingsCard title={t('admin.desktop.list.title')}>
            <ReleaseList
              platform={platform}
              versions={mine?.versions ?? []}
              canPublish={!fromFolder}
            />
          </SettingsCard>
          <Notice tone="info" icon="info">
            <span className="flex flex-col gap-1.5">
              <span>{t('admin.desktop.info.check')}</span>
              {platform === 'win' ? <span>{t('admin.desktop.info.smartscreen')}</span> : null}
            </span>
          </Notice>
        </div>
      )}
    </Workspace>
  );
}

interface Staged {
  id: string;
  file: File;
  kind: DesktopFileKind;
  /** `paused`: the connection dropped; it continues from the parts the store already has. */
  status: 'uploading' | 'paused' | 'done' | 'failed' | 'cancelled';
  loaded: number;
  abort: AbortController;
  resume: MultipartState | null;
}

function UploadCard({
  platform,
  disabled,
  canPublish,
}: {
  platform: DesktopPlatform;
  disabled: boolean;
  canPublish: boolean;
}) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const [staged, setStaged] = useState<Staged[]>([]);
  const [over, setOver] = useState(false);
  const [versionInput, setVersionInput] = useState<string | null>(null);
  const [versionError, setVersionError] = useState<string | null>(null);

  // Leaving the page (or the platform) stops what is still going up. Unlike a cancel, the
  // server keeps the unfinished upload: dropping the same file again later continues it.
  const running = useRef(new Set<AbortController>());
  const leaving = useRef(false);
  useEffect(() => {
    const set = running.current;
    leaving.current = false;
    return () => {
      leaving.current = true;
      set.forEach((c) => c.abort());
    };
  }, []);

  const patch = (id: string, p: Partial<Staged>) =>
    setStaged((list) => list.map((s) => (s.id === id ? { ...s, ...p } : s)));

  const upload = async (s: Staged) => {
    running.current.add(s.abort);
    patch(s.id, { status: 'uploading' });
    try {
      await uploadDesktopFile(
        platform,
        s.file,
        s.abort.signal,
        (loaded) => patch(s.id, { loaded }),
        s.resume,
      );
      patch(s.id, { status: 'done', loaded: s.file.size, resume: null });
    } catch (err) {
      const e = err instanceof DesktopUploadError ? err.cause : err;
      const state = err instanceof DesktopUploadError ? err.state : null;
      if (s.abort.signal.aborted) {
        patch(s.id, { status: 'cancelled', resume: null });
        if (state && !leaving.current) abortUpload(platform, s.file.name, state.uploadId);
      } else if (canResume(e) && !refusedForSize(e, s.file.size)) {
        patch(s.id, { status: 'paused', resume: state });
      } else {
        patch(s.id, { status: 'failed', resume: null });
        if (state) abortUpload(platform, s.file.name, state.uploadId);
        toast(
          isApiError(e)
            ? t(`errors.${e.code}`)
            : e instanceof MissingEtagError
              ? t('admin.desktop.upload.noEtag')
              : // A proxy in front of the store (Cloudflare: 100 MB) refused the request size.
                refusedForSize(e, s.file.size)
                ? t('admin.desktop.upload.tooLargeForProxy', { name: s.file.name })
                : t('admin.desktop.upload.state.failed'),
        );
      }
    } finally {
      running.current.delete(s.abort);
    }
  };

  /** Continue a paused upload: a fresh controller, the same parts state. */
  const resume = (s: Staged) => {
    const next = { ...s, abort: new AbortController() };
    patch(s.id, { abort: next.abort });
    void upload(next);
  };

  /** Cancel: stop the PUT, or (paused) drop the unfinished upload on the server. */
  const cancel = (s: Staged) => {
    if (s.status === 'uploading') {
      s.abort.abort();
      return;
    }
    if (s.resume) abortUpload(platform, s.file.name, s.resume.uploadId);
    patch(s.id, { status: 'cancelled', resume: null });
  };

  // Back online: paused uploads continue by themselves.
  useEffect(() => {
    const paused = staged.filter((s) => s.status === 'paused');
    if (!paused.length) return;
    const onOnline = () => paused.forEach(resume);
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  });

  const add = (files: FileList | File[]) => {
    const next: Staged[] = [];
    for (const file of Array.from(files)) {
      const kind = fileKind(file.name, platform);
      if (!kind || !versionOf(file.name)) {
        toast(t('admin.desktop.upload.unsupported', { name: file.name }));
        continue;
      }
      if (tooLarge(file.size)) {
        toast(t('admin.desktop.upload.tooLarge', { name: file.name }));
        continue;
      }
      next.push({
        id: newId(),
        file,
        kind,
        status: 'uploading',
        loaded: 0,
        abort: new AbortController(),
        resume: null,
      });
    }
    if (!next.length) return;
    // One file per kind: a newer drop of the same kind replaces (and cancels) the older one.
    const kinds = new Set(next.map((s) => s.kind));
    for (const old of staged) {
      if (!kinds.has(old.kind)) continue;
      // The same file dropped again (after a pause or a reload) continues on the server; only a
      // different file drops the old upload there.
      const same = next.some((n) => n.file.name === old.file.name && n.file.size === old.file.size);
      if (same && old.status !== 'uploading') continue;
      cancel(old);
    }
    setStaged((list) => [...list.filter((s) => !kinds.has(s.kind)), ...next]);
    setVersionError(null);
    next.forEach((s) => void upload(s));
  };

  const main = staged.find((s) => s.kind === MAIN_KIND[platform]);
  const version = versionInput ?? (main ? (versionOf(main.file.name) ?? '') : '');
  const uploading = staged.some((s) => s.status === 'uploading' || s.status === 'paused');
  const ready = canPublish && main?.status === 'done' && !uploading;
  const dmg = staged.find((s) => s.kind === 'dmg' && s.status === 'done')?.file.name;

  const publish = useMutation({
    mutationFn: () =>
      api.call('publishDesktopRelease', {
        body: {
          platform,
          installer: main!.file.name,
          ...(platform === 'mac' && dmg ? { dmg } : {}),
          version: version.trim(),
        },
      }),
    onSuccess: (next) => {
      setPlatformReleases(qc, next);
      toast(t('admin.desktop.upload.published', { version: next.current?.version ?? version }));
      setStaged([]);
      setVersionInput(null);
    },
    onError: (e) => {
      if (isApiError(e, 'desktop_version_invalid')) {
        setVersionError(t('admin.desktop.upload.versionInvalid'));
      } else {
        toast(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal'));
      }
    },
  });

  const onPublish = () => {
    if (!VERSION_PATTERN.test(version.trim())) {
      setVersionError(t('admin.desktop.upload.versionInvalid'));
      return;
    }
    publish.mutate();
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (!disabled && e.dataTransfer.files.length) add(e.dataTransfer.files);
  };

  return (
    <SettingsCard title={t('admin.desktop.upload.title')}>
      <div className="flex flex-col gap-4 pt-1 pb-4">
        <label
          onDragOver={(e) => {
            e.preventDefault();
            if (!disabled) setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
          className={cn(
            'flex flex-col items-center gap-1.5 rounded-xl border border-dashed border-line2 px-4 py-7 text-center transition-colors duration-[var(--t-fast)] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-fg',
            disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-bg2',
            over && 'border-accent bg-accent/10',
          )}
        >
          <Icon name="upload" size={22} className="text-fg2" />
          <span className="text-sm font-semibold">
            {t('admin.desktop.upload.drop')}{' '}
            <span className="font-normal text-fg2 underline">{t('admin.desktop.upload.pick')}</span>
          </span>
          <span className="text-cap text-fg2">{t(`admin.desktop.upload.hint.${platform}`)}</span>
          <input
            type="file"
            multiple
            accept={ACCEPT[platform]}
            disabled={disabled}
            className="sr-only"
            aria-label={t('admin.desktop.upload.drop')}
            onChange={(e) => {
              if (e.target.files?.length) add(e.target.files);
              e.target.value = '';
            }}
          />
        </label>

        {staged.length ? (
          <ul className="flex flex-col gap-2">
            {staged.map((s) => (
              <li
                key={s.id}
                className="flex items-center gap-3 rounded-xl px-3 py-2.5 shadow-line"
                data-status={s.status}
              >
                <Icon name="file" size={18} className="shrink-0 text-fg2" />
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="min-w-0 truncate text-sm font-medium">{s.file.name}</span>
                    <Badge plain>{t(`admin.desktop.kind.${s.kind}`)}</Badge>
                    <span className="text-cap text-fg3">{formatBytes(s.file.size, locale)}</span>
                  </div>
                  {s.status === 'uploading' || s.status === 'paused' ? (
                    <>
                      <Progress
                        neutral={s.status === 'paused'}
                        value={s.file.size ? (s.loaded / s.file.size) * 100 : 0}
                        label={t('admin.desktop.upload.progress', { name: s.file.name })}
                      />
                      {s.status === 'paused' ? (
                        <span className="text-cap text-warning">
                          {t('admin.desktop.upload.state.paused')}
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <span
                      className={cn(
                        'text-cap',
                        s.status === 'done'
                          ? 'text-success'
                          : s.status === 'failed'
                            ? 'text-danger'
                            : 'text-fg2',
                      )}
                    >
                      {t(`admin.desktop.upload.state.${s.status}`)}
                    </span>
                  )}
                </div>
                {s.status === 'paused' ? (
                  <Button
                    size="sm"
                    variant="out"
                    aria-label={t('admin.desktop.upload.resumeLabel', { name: s.file.name })}
                    onClick={() => resume(s)}
                  >
                    <Icon name="refresh" size={14} />
                    {t('admin.desktop.upload.resume')}
                  </Button>
                ) : null}
                {s.status === 'uploading' || s.status === 'paused' ? (
                  <IconButton
                    size="sm"
                    tone="plain"
                    aria-label={t('admin.desktop.upload.cancel', { name: s.file.name })}
                    onClick={() => cancel(s)}
                  >
                    <Icon name="x" size={16} />
                  </IconButton>
                ) : (
                  <IconButton
                    size="sm"
                    tone="plain"
                    aria-label={t('admin.desktop.upload.remove', { name: s.file.name })}
                    onClick={() => setStaged((list) => list.filter((x) => x.id !== s.id))}
                  >
                    <Icon name="trash" size={16} />
                  </IconButton>
                )}
              </li>
            ))}
          </ul>
        ) : null}

        {staged.length ? (
          <div className="flex flex-wrap items-end gap-3">
            <Field
              label={t('admin.desktop.upload.version')}
              hint={t('admin.desktop.upload.versionHint')}
              error={versionError ?? undefined}
              className="w-full sm:w-[220px]"
            >
              <Input
                value={version}
                onChange={(e) => {
                  setVersionInput(e.target.value);
                  setVersionError(null);
                }}
                className="font-mono"
                spellCheck={false}
              />
            </Field>
            <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-3 pb-6 max-sm:pb-0">
              {!main ? (
                <span className="text-cap text-fg2">
                  {t(`admin.desktop.upload.missing.${platform}`)}
                </span>
              ) : uploading ? (
                <span className="text-cap text-fg2">{t('admin.desktop.upload.waiting')}</span>
              ) : null}
              <Button
                variant="pri"
                onClick={onPublish}
                disabled={!ready}
                loading={publish.isPending}
              >
                {t('admin.desktop.upload.publish')}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </SettingsCard>
  );
}

function ReleaseList({
  platform,
  versions,
  canPublish,
}: {
  platform: DesktopPlatform;
  versions: DesktopReleaseVersion[];
  canPublish: boolean;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const narrow = useMediaQuery(NARROW_QUERY);
  const [publishing, setPublishing] = useState<DesktopReleaseVersion | null>(null);
  const [deleting, setDeleting] = useState<DesktopReleaseVersion | null>(null);

  const republish = useMutation({
    mutationFn: (v: DesktopReleaseVersion) => {
      const dmg = v.files.find((f) => f.kind === 'dmg')?.name;
      return api.call('publishDesktopRelease', {
        body: {
          platform,
          installer: v.files.find((f) => f.kind === MAIN_KIND[platform])?.name ?? '',
          ...(dmg ? { dmg } : {}),
          version: v.version,
        },
      });
    },
    onSuccess: (next, v) => {
      setPublishing(null);
      setPlatformReleases(qc, next);
      toast(t('admin.desktop.upload.published', { version: v.version }));
    },
    onError: (e) => toast(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal')),
  });

  if (!versions.length) {
    return <p className="py-3 text-cap text-fg2">{t('admin.desktop.list.empty')}</p>;
  }
  const menu = (v: DesktopReleaseVersion) => (
    <RowMenu
      version={v}
      // Only a version with its installer (or update zip) can be what the feed points to.
      canPublish={canPublish && v.files.some((f) => f.kind === MAIN_KIND[platform])}
      onPublish={() => setPublishing(v)}
      onDelete={() => setDeleting(v)}
    />
  );
  return (
    <>
      {narrow ? (
        // Phone: one card per version, its menu always in reach (a table would scroll sideways).
        <ul className="flex flex-col divide-y divide-line">
          {versions.map((v) => (
            <li key={v.version} className="flex flex-col gap-2 py-3">
              <div className="flex items-center justify-between gap-2">
                <VersionCell version={v} />
                {menu(v)}
              </div>
              <FileList version={v} />
              <UploadedCell version={v} />
            </li>
          ))}
        </ul>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <thead>
              <tr>
                <Th>{t('admin.desktop.list.col.version')}</Th>
                <Th>{t('admin.desktop.list.col.files')}</Th>
                <Th>{t('admin.desktop.list.col.uploaded')}</Th>
                <Th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <Tr key={v.version}>
                  <Td>
                    <VersionCell version={v} />
                  </Td>
                  <Td>
                    <FileList version={v} />
                  </Td>
                  <Td>
                    <UploadedCell version={v} />
                  </Td>
                  <Td className="text-right">{menu(v)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
      <ConfirmDialog
        open={publishing !== null}
        onOpenChange={(o) => !o && setPublishing(null)}
        title={t('admin.desktop.confirmPublish.title', { version: publishing?.version ?? '' })}
        body={t('admin.desktop.confirmPublish.body')}
        confirm={t('admin.desktop.confirmPublish.confirm')}
        danger={false}
        pending={republish.isPending}
        onConfirm={() => publishing && republish.mutate(publishing)}
      />
      {deleting ? (
        <DeleteDialog platform={platform} version={deleting} onClose={() => setDeleting(null)} />
      ) : null}
    </>
  );
}

/** Deletes a version; its blockmaps stay unless ticked (older apps diff against them). */
function DeleteDialog({
  platform,
  version: v,
  onClose,
}: {
  platform: DesktopPlatform;
  version: DesktopReleaseVersion;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [blockmaps, setBlockmaps] = useState(false);
  const remove = useMutation({
    mutationFn: () =>
      api.call('deleteDesktopRelease', {
        params: { platform, version: v.version },
        query: { blockmaps: blockmaps ? 'true' : 'false' },
      }),
    onSuccess: (next) => {
      setPlatformReleases(qc, next);
      toast(t('admin.desktop.deleted', { version: v.version }));
      onClose();
    },
    onError: (e) => toast(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal')),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent width={440}>
        <DialogHeader
          icon="alert"
          title={t('admin.desktop.confirmDelete.title', { version: v.version })}
          description={t('admin.desktop.confirmDelete.body')}
        />
        {v.files.some((f) => f.kind === 'blockmap') ? (
          <div className="flex flex-col gap-1">
            <CheckboxRow checked={blockmaps} onCheckedChange={(c) => setBlockmaps(c === true)}>
              {t('admin.desktop.confirmDelete.blockmaps')}
            </CheckboxRow>
            <p className="pl-6 text-cap text-fg3">
              {t('admin.desktop.confirmDelete.blockmapsHint')}
            </p>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="gh" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
          <Button variant="dngf" loading={remove.isPending} onClick={() => remove.mutate()}>
            {t('admin.desktop.confirmDelete.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VersionCell({ version: v }: { version: DesktopReleaseVersion }) {
  const { t } = useI18n();
  return (
    <span className="flex items-center gap-2">
      <span className="font-mono text-[13px] font-semibold">{v.version}</span>
      {v.current ? <Badge tone="ok">{t('admin.desktop.list.live')}</Badge> : null}
    </span>
  );
}

function FileList({ version: v }: { version: DesktopReleaseVersion }) {
  const { locale } = useI18n();
  return (
    <ul className="flex flex-col gap-0.5">
      {v.files.map((f) => (
        <li key={f.name} className="flex flex-wrap gap-x-2 text-[12.5px]">
          <span className="break-all">{f.name}</span>
          <span className="text-fg3">{formatBytes(f.sizeBytes, locale)}</span>
        </li>
      ))}
    </ul>
  );
}

function UploadedCell({ version: v }: { version: DesktopReleaseVersion }) {
  const { locale } = useI18n();
  if (!v.uploadedAt) return <span className="text-fg3">—</span>;
  return (
    <span className="text-[12.5px] whitespace-nowrap">
      {formatDate(v.uploadedAt, locale)} {formatTime(v.uploadedAt, locale)}
    </span>
  );
}

function RowMenu({
  version: v,
  canPublish,
  onPublish,
  onDelete,
}: {
  version: DesktopReleaseVersion;
  canPublish: boolean;
  onPublish: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  return (
    <Menu>
      <MenuTrigger asChild>
        <IconButton
          size="sm"
          tone="plain"
          aria-label={t('admin.desktop.list.menu', { version: v.version })}
        >
          <Icon name="dots" size={18} />
        </IconButton>
      </MenuTrigger>
      <MenuContent align="end" className="w-60">
        <MenuItem icon="upload" disabled={v.current || !canPublish} onSelect={onPublish}>
          {t('admin.desktop.list.publish')}
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon="trash" danger disabled={v.current} onSelect={onDelete}>
          {v.current ? t('admin.desktop.list.deleteLive') : t('admin.desktop.list.delete')}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
