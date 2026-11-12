import { queryKeys } from '@crewhall/api-client';
import { paths, type PublicNode, type PublicShare } from '@crewhall/shared';
import {
  Button,
  Checkbox,
  cn,
  CrewhallMark,
  Field,
  Icon,
  Input,
  Skeleton,
  Spinner,
  Tag,
  toast,
} from '@crewhall/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { LanguageMenu, Notice } from '@/components/auth/AuthLayout';
import { saveFromUrl } from '@/features/drive/actions';
import { badgeOf } from '@/features/drive/fileKinds';
import { MediaView } from '@/features/drive/Previewer';
import { CONTENT_TYPES, PublicContentView } from './PublicContentView';
import { api, isApiError } from '@/lib/api';
import { formatBytes, formatDateLong, formatTime } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { readStorage, StorageKey, writeStorage } from '@/lib/storage';
import { useBootstrap } from '@/lib/useBranding';

type Grants = Record<string, { grant: string; expiresAt: string }>;

function readGrant(token: string): string | undefined {
  try {
    const all = JSON.parse(readStorage(StorageKey.shareGrants) ?? '{}') as Grants;
    const g = all[token];
    return g && new Date(g.expiresAt).getTime() > Date.now() ? g.grant : undefined;
  } catch {
    return undefined;
  }
}

function saveGrant(token: string, grant: { grant: string; expiresAt: string }) {
  let all: Grants = {};
  try {
    all = JSON.parse(readStorage(StorageKey.shareGrants) ?? '{}') as Grants;
  } catch {
    /* start over */
  }
  writeStorage(StorageKey.shareGrants, JSON.stringify({ ...all, [token]: grant }));
}

type Ok = Extract<PublicShare, { status: 'ok' }>;

/**
 * Public link (19.1-19.5) for someone without an account: a thin brand bar, no shell.
 * Unknown, revoked and deleted links read the same (19.3) so links cannot be guessed.
 */
export function PublicSharePage({
  token,
  search,
}: {
  token: string;
  search: { file?: string; folder?: string };
}) {
  const [grant, setGrant] = useState(() => readGrant(token));
  const share = useQuery({
    queryKey: [...queryKeys.publicShare(token), grant ?? null],
    queryFn: ({ signal }) =>
      api.call('getPublicShare', { params: { token }, query: { grant }, signal }),
    retry: false,
    staleTime: 60_000,
  });

  let body: ReactNode;
  if (share.isLoading) {
    body = (
      <div className="m-auto">
        <Spinner />
      </div>
    );
  } else if (share.error) {
    body = isApiError(share.error, 'share_expired') ? (
      <Expired details={share.error.details} token={token} />
    ) : isApiError(share.error, 'share_locked') ? (
      <Locked until={(share.error.details as { lockedUntil?: string } | undefined)?.lockedUntil} />
    ) : (
      <Invalid token={token} />
    );
  } else if (share.data?.status === 'password_required') {
    body = (
      <PasswordForm
        token={token}
        sharedBy={share.data.sharedBy.name}
        orgName={share.data.orgName}
        onGrant={(g) => {
          saveGrant(token, g);
          setGrant(g.grant);
        }}
      />
    );
  } else if (share.data) {
    body =
      share.data.node.type === 'folder' && !search.file ? (
        <FolderView token={token} grant={grant} share={share.data} folderId={search.folder} />
      ) : (
        <FileView
          token={token}
          grant={grant}
          share={share.data}
          fileId={search.file}
          folderId={search.folder}
        />
      );
  }

  return <PublicFrame token={token}>{body}</PublicFrame>;
}

function PublicFrame({ token, children }: { token: string; children: ReactNode }) {
  const { t } = useI18n();
  const { branding } = useBootstrap();
  const logo = branding.logoLightUrl ?? branding.logoDarkUrl;
  return (
    <div className="flex min-h-screen flex-col bg-bg text-fg">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-6">
        {logo ? (
          <img src={logo} alt={branding.orgName} className="h-7 max-w-[160px] object-contain" />
        ) : (
          <span className="flex items-center gap-2 text-sm font-bold">
            <CrewhallMark size={24} />
            {branding.orgName}
          </span>
        )}
        {branding.showPoweredBy ? (
          <span className="text-xs text-fg3">{t('publicShare.poweredBy')}</span>
        ) : null}
        <span className="ml-auto flex items-center gap-2">
          <LanguageMenu />
          <Button size="sm" variant="out" asChild>
            <Link to="/login" search={{ redirect: paths.share(token) }}>
              {t('publicShare.signIn')}
            </Link>
          </Button>
        </span>
      </header>
      <main className="flex min-h-0 flex-1 flex-col px-6 py-6">{children}</main>
      <footer className="shrink-0 px-6 pb-5 text-center text-xs text-fg3">
        {t('publicShare.footer', { year: new Date().getFullYear(), org: branding.orgName })}
      </footer>
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="m-auto flex w-full max-w-[420px] flex-col gap-4">{children}</div>;
}

function StateIcon({ icon, tone }: { icon: 'lock' | 'clock' | 'alert'; tone?: 'danger' }) {
  return (
    <span
      className={cn(
        'flex size-12 items-center justify-center rounded-[14px]',
        tone === 'danger'
          ? 'bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] text-danger'
          : 'bg-bg2 text-fg',
      )}
    >
      <Icon name={icon} size={24} />
    </span>
  );
}

/** 19.2: name, type and size stay hidden until the password; only the sharer is shown. */
function PasswordForm({
  token,
  sharedBy,
  orgName,
  onGrant,
}: {
  token: string;
  sharedBy: string;
  orgName: string;
  onGrant: (g: { grant: string; expiresAt: string }) => void;
}) {
  const { t, locale } = useI18n();
  const [password, setPassword] = useState('');
  const unlock = useMutation({
    mutationFn: () => api.call('unlockPublicShare', { params: { token }, body: { password } }),
    onSuccess: onGrant,
  });
  const err = unlock.error;
  const remaining = isApiError(err, 'share_password_invalid')
    ? (err.details as { remainingAttempts?: number } | undefined)?.remainingAttempts
    : undefined;
  const lockedUntil = isApiError(err, 'share_locked')
    ? (err.details as { lockedUntil?: string } | undefined)?.lockedUntil
    : undefined;
  return (
    <Centered>
      <StateIcon icon="lock" />
      <div className="flex flex-col gap-1.5">
        <h1 className="m-0 text-title font-bold">{t('publicShare.password.title')}</h1>
        <p className="m-0 text-sm text-fg2">
          {t('publicShare.password.body', { name: sharedBy, org: orgName })}
        </p>
      </div>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (password) unlock.mutate();
        }}
      >
        <Field
          label={t('publicShare.password.label')}
          error={
            lockedUntil
              ? t('publicShare.locked.body', { time: formatTime(lockedUntil, locale) })
              : remaining !== undefined
                ? t('publicShare.password.wrong', { count: remaining })
                : unlock.isError
                  ? t('errors.internal')
                  : undefined
          }
        >
          <Input
            type="password"
            autoFocus
            autoComplete="off"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Button
          type="submit"
          variant="pri"
          full
          loading={unlock.isPending}
          disabled={!password || Boolean(lockedUntil)}
        >
          {t('publicShare.password.open')}
        </Button>
      </form>
      <Notice tone="info">{t('publicShare.password.hint')}</Notice>
    </Centered>
  );
}

function Locked({ until }: { until?: string }) {
  const { t, locale } = useI18n();
  return (
    <Centered>
      <StateIcon icon="lock" tone="danger" />
      <h1 className="m-0 text-title font-bold">{t('publicShare.locked.title')}</h1>
      <p className="m-0 text-sm text-fg2">
        {until
          ? t('publicShare.locked.body', { time: formatTime(until, locale) })
          : t('publicShare.locked.later')}
      </p>
    </Centered>
  );
}

/** 410: the sharer is known, so their name is shown (asking for a new link is out of phase 1). */
function Expired({ details, token }: { details: unknown; token: string }) {
  const { t, locale } = useI18n();
  const d = details as { sharedByName?: string; expiredAt?: string } | undefined;
  return (
    <Centered>
      <span className="font-mono text-xs text-fg3">410</span>
      <StateIcon icon="clock" />
      <h1 className="m-0 text-title font-bold">{t('publicShare.expired.title')}</h1>
      <p className="m-0 text-sm text-fg2">
        {d?.expiredAt
          ? t('publicShare.expired.body', {
              name: d.sharedByName ?? '',
              date: formatDateLong(d.expiredAt, locale),
            })
          : t('publicShare.expired.bodyNoDate', { name: d?.sharedByName ?? '' })}
      </p>
      <MemberHint token={token} />
    </Centered>
  );
}

function Invalid({ token }: { token: string }) {
  const { t } = useI18n();
  return (
    <Centered>
      <span className="font-mono text-xs text-fg3">404</span>
      <StateIcon icon="alert" />
      <h1 className="m-0 text-title font-bold">{t('publicShare.invalid.title')}</h1>
      <p className="m-0 text-sm text-fg2">{t('publicShare.invalid.body')}</p>
      <MemberHint token={token} />
    </Centered>
  );
}

function MemberHint({ token }: { token: string }) {
  const { t } = useI18n();
  const { branding } = useBootstrap();
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-bg2 p-4">
      <span className="text-sm">{t('publicShare.member', { org: branding.orgName })}</span>
      <Button variant="inv" asChild className="self-start">
        <Link to="/login" search={{ redirect: paths.share(token) }}>
          {t('publicShare.memberSignIn', { org: branding.orgName })}
        </Link>
      </Button>
    </div>
  );
}

// ---- file (19.1) ----

const CONTENT_ICON: Partial<Record<PublicNode['type'], 'page' | 'board' | 'vector'>> = {
  page: 'page',
  board: 'board',
  drawing: 'vector',
};

function FileView({
  token,
  grant,
  share,
  fileId,
  folderId,
}: {
  token: string;
  grant?: string;
  share: Ok;
  fileId?: string;
  folderId?: string;
}) {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const inner = useQuery({
    queryKey: [...queryKeys.publicShare(token), 'node', fileId, grant ?? null],
    queryFn: async ({ signal }) => {
      // A file inside a shared folder: find it in its folder listing (the API has no single-node read).
      const page = await api.call('listPublicShareNodes', {
        params: { token },
        query: { grant, parentId: folderId, limit: 100 },
        signal,
      });
      return page.items.find((n) => n.id === fileId) ?? null;
    },
    enabled: Boolean(fileId),
  });
  const node: PublicNode | null | undefined = fileId ? inner.data : share.node;
  const nodeId = fileId;
  // Pages, boards and drawings show their content: no size, no file download (H15).
  const content = node ? CONTENT_TYPES.has(node.type) : false;
  const download = useQuery({
    queryKey: [...queryKeys.publicShare(token), 'download', nodeId ?? null, grant ?? null],
    queryFn: ({ signal }) =>
      api.call('getPublicDownloadUrl', { params: { token }, query: { grant, nodeId }, signal }),
    enabled: share.allowDownload && Boolean(node) && !content,
    staleTime: 4 * 60_000,
  });
  const preview = useQuery({
    queryKey: [...queryKeys.publicShare(token), 'preview', nodeId ?? null, grant ?? null],
    queryFn: ({ signal }) =>
      api.call('getPublicPreview', {
        params: { token },
        query: { grant, nodeId, kind: 'thumb_1024' },
        signal,
      }),
    enabled: !share.allowDownload && node?.preview === 'ready' && !content,
    retry: false,
  });

  if (fileId && inner.isLoading) return <Spinner className="m-auto" />;
  if (!node) return <Invalid token={token} />;

  const fallback = (
    <div className="flex flex-col items-center gap-3 text-center">
      <span className="flex h-16 min-w-16 items-center justify-center rounded-2xl bg-surface px-2 text-sm font-bold text-fg2 shadow-line">
        {badgeOf(node.name) || <Icon name="file" size={28} />}
      </span>
      <span className="text-sm text-fg2">{t('publicShare.noPreview')}</span>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 gap-6">
      <div className="flex h-[calc(100vh-150px)] min-h-[420px] min-w-0 flex-1 items-center justify-center overflow-auto rounded-2xl bg-bg2 p-6">
        {content ? (
          <PublicContentView
            token={token}
            grant={grant}
            type={node.type}
            nodeId={nodeId}
            fallback={fallback}
          />
        ) : share.allowDownload ? (
          download.data ? (
            <MediaView
              name={node.name}
              mime={node.mime}
              url={download.data.url}
              fallback={fallback}
            />
          ) : download.isError ? (
            fallback
          ) : (
            <Spinner />
          )
        ) : preview.data ? (
          <img
            src={preview.data.url}
            alt={node.name}
            className="max-h-full max-w-full rounded-lg object-contain shadow-overlay"
          />
        ) : (
          fallback
        )}
      </div>
      <aside className="flex w-[320px] shrink-0 flex-col gap-5">
        <div className="flex items-start gap-3">
          <span className="flex h-10 min-w-10 items-center justify-center rounded-[10px] bg-bg2 px-1 text-[10.5px] font-bold text-fg2">
            {content ? (
              <Icon name={CONTENT_ICON[node.type] ?? 'file'} size={18} />
            ) : (
              badgeOf(node.name) || <Icon name="file" size={18} />
            )}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="text-sm font-semibold break-words">{node.name}</span>
            <span className="text-xs text-fg2">
              {content
                ? t(`publicShare.kind.${node.type as 'page' | 'board' | 'drawing'}`)
                : formatBytes(node.sizeBytes, locale)}
            </span>
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {content ? null : share.allowDownload ? (
            <Button
              variant="pri"
              disabled={!download.data}
              onClick={() =>
                download.data && saveFromUrl(download.data.url, download.data.fileName)
              }
            >
              <Icon name="download" size={16} />
              {t('drive.menu.download')}
            </Button>
          ) : (
            <Tag>{t('publicShare.viewOnly')}</Tag>
          )}
          <Button
            variant="out"
            onClick={() => {
              void navigator.clipboard?.writeText(window.location.href);
              toast(t('drive.linkCopied'));
            }}
          >
            {t('drive.menu.copyLink')}
          </Button>
          {fileId ? (
            <Button
              variant="gh"
              onClick={() =>
                void navigate({
                  to: '/s/$token',
                  params: { token },
                  search: folderId ? { folder: folderId } : {},
                })
              }
            >
              <Icon name="arrowL" size={16} />
              {t('publicShare.backToFolder')}
            </Button>
          ) : null}
        </div>
        <ShareFacts share={share} />
      </aside>
    </div>
  );
}

function ShareFacts({ share }: { share: Ok }) {
  const { t, locale } = useI18n();
  return (
    <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 rounded-xl p-4 text-cap shadow-line">
      <dt className="text-fg2">{t('publicShare.facts.sharedBy')}</dt>
      <dd className="m-0 font-medium">
        {share.sharedBy.name} · {share.orgName}
      </dd>
      <dt className="text-fg2">{t('publicShare.facts.expires')}</dt>
      <dd className="m-0 font-medium">
        {share.expiresAt
          ? t('drive.share.until', { date: formatDateLong(share.expiresAt, locale) })
          : t('drive.share.expiries.none')}
      </dd>
      <dt className="text-fg2">{t('publicShare.facts.access')}</dt>
      <dd className="m-0 font-medium">{t('publicShare.facts.anyone')}</dd>
      <dt className="text-fg2">{t('publicShare.facts.download')}</dt>
      <dd className="m-0 font-medium">
        {share.allowDownload ? t('publicShare.facts.on') : t('publicShare.facts.off')}
      </dd>
    </dl>
  );
}

// ---- folder (19.5) ----

function FolderView({
  token,
  grant,
  share,
  folderId,
}: {
  token: string;
  grant?: string;
  share: Ok;
  folderId?: string;
}) {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [names, setNames] = useState<Record<string, string>>({});
  const list = useQuery({
    queryKey: [...queryKeys.publicShare(token), 'nodes', folderId ?? null, grant ?? null],
    queryFn: ({ signal }) =>
      api.call('listPublicShareNodes', {
        params: { token },
        query: { grant, parentId: folderId, limit: 100 },
        signal,
      }),
  });
  const items = (list.data?.items ?? []).filter((n) =>
    n.name.toLocaleLowerCase(locale).includes(q.trim().toLocaleLowerCase(locale)),
  );
  const chosen = items.filter((n) => selected.has(n.id));
  const size = (list.data?.items ?? []).reduce((a, n) => a + n.sizeBytes, 0);

  const downloadOne = async (n: PublicNode) => {
    try {
      const d = await api.call('getPublicDownloadUrl', {
        params: { token },
        query: { grant, nodeId: n.id },
      });
      saveFromUrl(d.url, d.fileName);
    } catch {
      toast(t('errors.internal'));
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-[960px] flex-col gap-4">
      <div className="flex items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <nav
            aria-label={t('drive.picker.path')}
            className="flex items-center gap-1 text-cap text-fg2"
          >
            <button
              type="button"
              className="hover:text-fg"
              onClick={() => void navigate({ to: '/s/$token', params: { token }, search: {} })}
            >
              {share.node.name}
            </button>
            {folderId ? (
              <>
                <Icon name="chevR" size={13} className="text-fg3" />
                <span className="font-semibold text-fg">{names[folderId] ?? '…'}</span>
              </>
            ) : null}
          </nav>
          <h1 className="m-0 truncate text-wtitle font-bold">
            {folderId ? (names[folderId] ?? share.node.name) : share.node.name}
          </h1>
          <span className="text-cap text-fg2">
            {t('publicShare.folder.meta', {
              name: share.sharedBy.name,
              org: share.orgName,
              count: list.data?.items.length ?? 0,
              size: formatBytes(size, locale),
            })}
            {share.expiresAt
              ? ` · ${t('drive.share.until', { date: formatDateLong(share.expiresAt, locale) })}`
              : ''}
          </span>
        </div>
        <Input
          containerClassName="h-10 w-[260px] rounded-md"
          icon="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('publicShare.folder.search')}
          aria-label={t('publicShare.folder.search')}
        />
      </div>
      {!share.allowDownload ? <Tag className="self-start">{t('publicShare.viewOnly')}</Tag> : null}
      {list.isLoading ? (
        <Skeleton className="h-48 w-full rounded-xl" />
      ) : (
        <table className="w-full border-separate border-spacing-0" aria-label={share.node.name}>
          <thead>
            <tr className="text-left text-xs font-semibold text-fg2 [&>th]:h-9 [&>th]:px-3">
              {share.allowDownload ? <th className="w-9" /> : null}
              <th>{t('drive.list.name')}</th>
              <th className="w-[140px]">{t('drive.list.updated')}</th>
              <th className="w-[100px] text-right">{t('drive.list.size')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((n) => (
              <tr
                key={n.id}
                className="h-12 hover:[&>td]:bg-bg2 [&>td]:border-b [&>td]:border-line [&>td]:px-3"
              >
                {share.allowDownload ? (
                  <td>
                    {n.type === 'file' ? (
                      <Checkbox
                        checked={selected.has(n.id)}
                        aria-label={t('drive.list.select', { name: n.name })}
                        onCheckedChange={() => {
                          const next = new Set(selected);
                          if (next.has(n.id)) next.delete(n.id);
                          else next.add(n.id);
                          setSelected(next);
                        }}
                      />
                    ) : null}
                  </td>
                ) : null}
                <td>
                  <button
                    type="button"
                    className="flex min-w-0 items-center gap-3 text-left"
                    onClick={() => {
                      if (n.type === 'folder') {
                        setNames({ ...names, [n.id]: n.name });
                        void navigate({
                          to: '/s/$token',
                          params: { token },
                          search: { folder: n.id },
                        });
                      } else {
                        void navigate({
                          to: '/s/$token',
                          params: { token },
                          search: { file: n.id, folder: folderId },
                        });
                      }
                    }}
                  >
                    <span className="flex h-8 min-w-8 items-center justify-center rounded-[8px] bg-bg2 px-1 text-[10px] font-bold text-fg2">
                      {n.type === 'folder' ? (
                        <Icon name="folder" size={17} />
                      ) : CONTENT_ICON[n.type] ? (
                        <Icon name={CONTENT_ICON[n.type]!} size={16} />
                      ) : (
                        badgeOf(n.name) || <Icon name="file" size={16} />
                      )}
                    </span>
                    <span className="truncate text-sm font-semibold">{n.name}</span>
                  </button>
                </td>
                <td className="text-cap text-fg2">{formatDateLong(n.updatedAt, locale)}</td>
                <td className="text-right text-cap text-fg2 tn">
                  {n.type === 'file' ? formatBytes(n.sizeBytes, locale) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {chosen.length ? (
        <div
          role="toolbar"
          className="fixed bottom-6 left-1/2 z-30 flex -translate-x-1/2 items-center gap-3 rounded-full bg-fg py-1.5 pr-1.5 pl-4 text-bg shadow-overlay keyboard:hidden"
        >
          <span className="text-cap font-semibold">
            {t('drive.selection.count', { count: chosen.length })} ·{' '}
            {formatBytes(
              chosen.reduce((a, n) => a + n.sizeBytes, 0),
              locale,
            )}
          </span>
          <button
            type="button"
            className="h-8 rounded-full px-3 text-cap font-semibold hover:bg-white/10"
            onClick={() => setSelected(new Set())}
          >
            {t('drive.selection.clear')}
          </button>
          <button
            type="button"
            className="flex h-8 items-center gap-1.5 rounded-full bg-accent px-3 text-cap font-semibold text-accent-fg"
            onClick={() => void Promise.all(chosen.map(downloadOne))}
          >
            <Icon name="download" size={15} />
            {t('publicShare.folder.download', { count: chosen.length })}
          </button>
        </div>
      ) : null}
    </div>
  );
}
