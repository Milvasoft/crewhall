import {
  pageIdFromRef,
  pagePath,
  type BodyOf,
  type CommentThread,
  type Page,
} from '@crewhall/shared';
import {
  Avatar,
  Button,
  cn,
  Icon,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Skeleton,
  Tooltip,
  toast,
} from '@crewhall/ui';
import type { Editor } from '@tiptap/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { InShellNotFound } from '@/components/common/NotFoundPage';
import { Workspace } from '@/components/shell/Workspace';
import { spaceName } from '@/components/spaces/spaceUtils';
import { openDriveDialog } from '@/features/drive/actions';
import { api, isApiError } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { formatDate, formatRelative, formatTime } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { membersQuery, spaceMembersQuery } from '@/lib/queries';
import { useMe, usePermissions } from '@/lib/session';
import { enabledModules } from '@/lib/identity/modules';
import { rememberSpace, useSpaces } from '@/lib/useSpaces';
import {
  backlinksQuery,
  pageCommentsQuery,
  pageQuery,
  pageTreeQuery,
  treeChildren,
  wikiKeys,
} from '@/lib/wiki/api';
import { colorFor, usePageCollab, type CollabEvent, type PageCollab } from '@/lib/wiki/collab';
import { useSetPageFavorite } from '@/lib/wiki/favorite';
import { useSetPageFollow } from '@/lib/wiki/follow';
import { usePageHideDone, usePagesFullWidth } from '@/lib/wiki/fullWidth';
import { useCalmSaveState } from '@/lib/wiki/saveState';
import { anchorRange } from '@/lib/wiki/editor/comments';
import { CommentsPanel } from './CommentsPanel';
import { useChatEnabled } from '@/lib/chat/enabled';
import { openWikiDialog } from './dialogs';
import { downloadPageExport } from './ExportDialog';
import { PageEditor, type PageEditorHandle } from './PageEditor';
import { PageLinkPreview } from './PageLinkPreview';
import { PageOutlineLayout } from './PageOutline';
import { VersionsPanel, VersionView } from './Versions';
import { WikiDialogs } from './WikiDialogs';
import { useCreatePage } from './useCreatePage';
import { WikiSidebar } from './WikiSidebar';

export interface PageSearch {
  comment?: string;
  version?: string;
  panel?: 'comments' | 'versions';
  new?: boolean;
  /** A finished export to download (the "export ready" notification links here). */
  import?: string;
}

export const COVER_PRESETS: Record<string, string> = {
  sunrise: 'linear-gradient(120deg, #FBC419 0%, #F38424 100%)',
  graphite: 'linear-gradient(120deg, #141516 0%, #3a3d40 100%)',
  sea: 'linear-gradient(120deg, #0e7490 0%, #2F80ED 100%)',
  forest: 'linear-gradient(120deg, #15803d 0%, #6D7A00 100%)',
  dusk: 'linear-gradient(120deg, #9B51E0 0%, #D6457F 100%)',
  sand: 'linear-gradient(120deg, #f3e7d3 0%, #e2c9a0 100%)',
};
const ICONS = [
  '📄',
  '📘',
  '🏗️',
  '🧭',
  '🛠️',
  '🚀',
  '📌',
  '✅',
  '🗂️',
  '📝',
  '💡',
  '⚙️',
  '🔒',
  '📊',
  '🧪',
  '🗓️',
  '👋',
  '🎯',
  '📦',
  '🔥',
  '🧩',
  '🌍',
  '🤝',
  '📣',
];

/** A page (design 5.1-5.12, 5.17): one surface for reading and writing. */
export function PageView({ pageRef, search }: { pageRef: string; search: PageSearch }) {
  const nodeId = pageIdFromRef(pageRef) ?? '';
  const q = useQuery({ ...pageQuery(nodeId), enabled: Boolean(nodeId), retry: false });
  if (!nodeId || (q.isError && isApiError(q.error, 'not_found'))) return <InShellNotFound />;
  if (!q.data) {
    return (
      <Workspace sidebar={<WikiSidebar space={undefined} />} crumbs={[]}>
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4 pt-16">
          <Skeleton className="h-10 w-2/3" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-40 w-full" />
        </div>
      </Workspace>
    );
  }
  return <Loaded key={nodeId} page={q.data} pageRef={pageRef} search={search} />;
}

function Loaded({ page, pageRef, search }: { page: Page; pageRef: string; search: PageSearch }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const me = useMe();
  const { items: spaces } = useSpaces();
  const space = spaces.find((s) => s.id === page.spaceId);
  const editorRef = useRef<PageEditorHandle>(null);
  const [pending, setPending] = useState<{ start: string; end: string; quote: string } | null>(
    null,
  );

  const user = useMemo(
    () => (me ? { id: me.user.id, name: me.user.name, color: colorFor(me.user.id) } : null),
    [me],
  );
  const onEvent = useRef<(e: CollabEvent) => void>(() => undefined);
  const handleEvent = (e: CollabEvent) => {
    if (e.type === 'meta') {
      void qc.invalidateQueries({ queryKey: wikiKeys.page(page.id) });
      void qc.invalidateQueries({ queryKey: wikiKeys.comments(page.id) });
      void qc.invalidateQueries({ queryKey: wikiKeys.tree(page.spaceId) });
    }
    if (e.type === 'restored') {
      toast(t('wiki.versions.restoredLive'));
      void qc.invalidateQueries({ queryKey: wikiKeys.versions(page.id) });
    }
  };
  useEffect(() => {
    onEvent.current = handleEvent;
  });
  const collab = usePageCollab(page.id, user, (e) => onEvent.current(e));
  const content = useQuery({
    queryKey: ['wiki', 'content', page.id],
    queryFn: ({ signal }) =>
      api.call('getPageContent', {
        params: { nodeId: page.id },
        query: { format: 'json' },
        signal,
      }),
    enabled: collab?.status === 'local',
  });

  const comments = useQuery(pageCommentsQuery(page.id));
  const threads = comments.data?.items ?? [];
  const tree = useQuery(pageTreeQuery(page.spaceId));
  const people = useQuery({ ...membersQuery({}), retry: false });
  const spaceMembers = useQuery({ ...spaceMembersQuery(page.spaceId), retry: false });
  const memberIds = useMemo(
    () => new Set((spaceMembers.data?.items ?? []).map((m) => m.user.id)),
    [spaceMembers.data],
  );
  const create = useCreatePage();
  const [fullWidth, setFullWidth] = usePagesFullWidth();
  const [hideDone, setHideDone] = usePageHideDone(page.id);
  const [doneCount, setDoneCount] = useState(0);
  const [bodyEditor, setBodyEditor] = useState<Editor | null>(null);
  const setFavorite = useSetPageFavorite();
  const setFollow = useSetPageFollow();

  // Canonical address: the slug follows the title, old ones still resolve (design 05).
  useEffect(() => {
    const canonical = pagePath(page).slice(3);
    if (canonical !== pageRef) {
      void navigate({ to: '/p/$pageRef', params: { pageRef: canonical }, search, replace: true });
    }
  }, [page.name, page.id, pageRef]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (space) rememberSpace(space.slug);
    void api.call('markNodeOpened', { params: { nodeId: page.id } }).catch(() => undefined);
  }, [page.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const editable = page.canEdit && !(collab?.readOnly ?? true) && collab?.status !== 'denied';
  const panel = search.version ? 'versions' : search.panel;
  const setSearch = (next: Partial<PageSearch>) =>
    void navigate({
      to: '/p/$pageRef',
      params: { pageRef },
      search: { ...search, ...next },
      replace: true,
    });

  const startComment = () => {
    const a = editorRef.current?.selectionAnchor() ?? null;
    setPending(a);
    setSearch({ panel: 'comments', version: undefined });
  };

  const isAnchored = (th: CommentThread) => {
    const ed = editorRef.current?.editor;
    if (!ed || !th.anchorStart || !th.anchorEnd) return false;
    return anchorRange(ed.state, { start: th.anchorStart, end: th.anchorEnd }) !== null;
  };

  useEffect(() => {
    if (!search.import) return;
    downloadPageExport(search.import);
    setSearch({ import: undefined });
  }, [search.import]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!search.comment) return;
    const th = threads.find((x) => x.id === search.comment);
    if (th) editorRef.current?.scrollToThread(th);
  }, [search.comment, threads.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = async (body: BodyOf<'updatePage'>) => {
    try {
      const next = await api.call('updatePage', { params: { nodeId: page.id }, body });
      qc.setQueryData(wikiKeys.page(page.id), next);
      void qc.invalidateQueries({ queryKey: wikiKeys.tree(page.spaceId) });
    } catch (e) {
      toast(t(errorKey(e)));
    }
  };

  const driveNode = async () => api.call('getNode', { params: { nodeId: page.id } });
  const chatOn = useChatEnabled();
  const { canOrg } = usePermissions();
  // "Portal'a gönder": for portal editors while the module is on (design 05 5.12).
  const portalOn = enabledModules(me).has('portal') && canOrg('portal.edit');

  const crumbs = [
    { label: space ? spaceName(space, t) : page.space.name },
    ...page.path.map((p) => ({ label: p.name })),
    { label: page.name },
  ];

  const kids = treeChildren(tree.data?.items ?? []).get(page.id) ?? [];

  return (
    <Workspace
      sidebar={<WikiSidebar space={space} activeId={page.id} />}
      crumbs={crumbs}
      searchLabel={t('wiki.search.placeholder')}
      bodyClassName="px-0 py-0 gap-0"
      tools={
        <div className="wk-noprint flex items-center gap-1.5">
          <SaveStatus collab={collab} />
          <Presence collab={collab} meId={me?.user.id} />
          <Tooltip content={t(page.favorite ? 'wiki.menu.unfavorite' : 'wiki.menu.favorite')}>
            <IconButton
              aria-label={t(page.favorite ? 'wiki.menu.unfavorite' : 'wiki.menu.favorite')}
              aria-pressed={page.favorite}
              size="sm"
              tone="plain"
              onClick={() => void setFavorite(page, !page.favorite)}
              className={cn(page.favorite && 'text-accent-text')}
            >
              <Icon name="star" size={18} fill={page.favorite ? 'currentColor' : 'none'} />
            </IconButton>
          </Tooltip>
          <Tooltip
            content={t(
              !page.following
                ? 'wiki.menu.follow'
                : page.followingDescendants
                  ? 'wiki.menu.followingDescendants'
                  : 'wiki.menu.unfollow',
            )}
          >
            <IconButton
              aria-label={t(page.following ? 'wiki.menu.unfollow' : 'wiki.menu.follow')}
              aria-pressed={Boolean(page.following)}
              size="sm"
              tone="plain"
              onClick={() => void setFollow(page, !page.following)}
              className={cn(page.following && 'text-accent-text')}
            >
              <Icon name="bell" size={18} fill={page.following ? 'currentColor' : 'none'} />
            </IconButton>
          </Tooltip>
          <Button
            size="sm"
            variant="out"
            onClick={() =>
              void driveNode().then((node) => openDriveDialog({ kind: 'share', node }))
            }
          >
            <Icon name="share" size={16} /> {t('wiki.page.share')}
          </Button>
          {chatOn ? (
            <Tooltip content={t('chat.refs.sendToChat')}>
              <IconButton
                aria-label={t('chat.refs.sendToChat')}
                size="sm"
                tone="plain"
                onClick={() =>
                  openDriveDialog({
                    kind: 'sendToChat',
                    target: { kind: 'node', id: page.id },
                    title: page.name,
                  })
                }
              >
                <Icon name="send" size={17} />
              </IconButton>
            </Tooltip>
          ) : null}
          <Tooltip content={t('wiki.comments.title')}>
            <IconButton
              aria-label={t('wiki.comments.title')}
              size="sm"
              tone={panel === 'comments' ? 'filled' : 'plain'}
              onClick={() =>
                setSearch({
                  panel: panel === 'comments' ? undefined : 'comments',
                  version: undefined,
                })
              }
            >
              <Icon name="comment" size={18} />
            </IconButton>
          </Tooltip>
          <PageMenu
            page={page}
            fullWidth={fullWidth}
            onFullWidth={setFullWidth}
            onToggle={(k, v) => void update({ [k]: v })}
            onHistory={() => setSearch({ panel: panel === 'versions' ? undefined : 'versions' })}
            onExport={() => openWikiDialog({ kind: 'export', nodeId: page.id, name: page.name })}
            onDuplicate={async () => {
              try {
                const copy = await api.call('duplicatePage', {
                  params: { nodeId: page.id },
                  body: { name: t('wiki.page.copyName', { name: page.name }) },
                });
                void qc.invalidateQueries({ queryKey: wikiKeys.tree(page.spaceId) });
                void navigate({ to: '/p/$pageRef', params: { pageRef: pagePath(copy).slice(3) } });
              } catch (e) {
                toast(t(errorKey(e)));
              }
            }}
            onMove={() =>
              void driveNode().then((node) => openDriveDialog({ kind: 'move', nodes: [node] }))
            }
            onFavorite={() => void setFavorite(page, !page.favorite)}
            onToPortal={
              portalOn
                ? () => openWikiDialog({ kind: 'toPortal', nodeId: page.id, name: page.name })
                : undefined
            }
            onFollowDescendants={() =>
              void setFollow(page, true, !(page.following && page.followingDescendants))
            }
            onTrash={async () => {
              try {
                await api.call('trashNodes', { body: { nodeIds: [page.id] } });
                void qc.invalidateQueries({ queryKey: wikiKeys.tree(page.spaceId) });
                toast(t('wiki.page.trashed'));
                if (space) {
                  void navigate({ to: '/pages/$spaceSlug', params: { spaceSlug: space.slug } });
                }
              } catch (e) {
                toast(t(errorKey(e)));
              }
            }}
            onSaveTemplate={() =>
              openWikiDialog({
                kind: 'saveTemplate',
                templateKind: 'page',
                nodeId: page.id,
                spaceId: page.spaceId,
                name: page.name,
              })
            }
            onImport={() =>
              openWikiDialog({ kind: 'import', spaceId: page.spaceId, parentId: page.id })
            }
          />
        </div>
      }
      panel={
        panel === 'comments' ? (
          <CommentsPanel
            page={page}
            threads={threads}
            people={people.data?.items ?? []}
            active={search.comment ?? null}
            onActivate={(id) => {
              setSearch({ comment: id ?? undefined });
              const th = threads.find((x) => x.id === id);
              if (th) editorRef.current?.scrollToThread(th);
            }}
            pending={pending}
            onPendingDone={() => setPending(null)}
            isAnchored={isAnchored}
            onClose={() => {
              setPending(null);
              setSearch({ panel: undefined, comment: undefined });
            }}
          />
        ) : panel === 'versions' ? (
          <VersionsPanel
            page={page}
            selected={search.version ?? null}
            onSelect={(id) => setSearch({ version: id ?? undefined, panel: 'versions' })}
            onClose={() => setSearch({ panel: undefined, version: undefined })}
          />
        ) : undefined
      }
    >
      <WikiDialogs />
      <PageLinkPreview currentId={page.id} />
      <PageOutlineLayout
        editor={bodyEditor}
        enabled={!panel && !search.version}
        fullWidth={fullWidth}
      >
        <article
          className={cn(
            'mx-auto w-full px-7 pb-24',
            page.smallText && 'wk-small',
            hideDone && 'wk-hide-done',
            fullWidth ? 'max-w-none' : panel ? 'max-w-[560px]' : 'max-w-[720px]',
          )}
        >
          {page.cover ? (
            <Cover
              page={page}
              canEdit={page.canEdit}
              onChange={(cover) => void update({ cover })}
            />
          ) : (
            <div className="h-14" />
          )}
          <PageHeader
            page={page}
            autoFocus={Boolean(search.new)}
            onRename={(name) => void update({ name })}
            onIcon={(icon) => void update({ icon })}
            onCover={() =>
              void update({
                cover: `preset:${Object.keys(COVER_PRESETS)[Math.floor(Math.random() * 6)]}`,
              })
            }
            onComment={startComment}
            onEnter={() => editorRef.current?.focus()}
          />
          <p className="mt-2 mb-6 flex flex-wrap items-center gap-1.5 text-cap text-fg2">
            {page.editedBy ? (
              <Avatar
                size="sm"
                name={page.editedBy.name}
                src={page.editedBy.imageUrl ?? undefined}
              />
            ) : null}
            <span>
              {t('wiki.page.edited', {
                name: page.editedBy?.name ?? '',
                when: `${formatRelative(page.editedAt, locale)} ${formatTime(page.editedAt, locale)}`,
              })}
            </span>
            {page.readingMinutes ? (
              <span>· {t('wiki.page.reading', { minutes: page.readingMinutes })}</span>
            ) : null}
            {page.openCommentCount ? (
              <button
                type="button"
                className="hover:text-fg"
                onClick={() => setSearch({ panel: 'comments' })}
              >
                · {t('wiki.page.comments', { count: page.openCommentCount })}
              </button>
            ) : null}
            {page.lastSource && page.lastSource !== 'web' ? (
              <span>· {t(`wiki.versions.source.${page.lastSource}`)}</span>
            ) : null}
            {doneCount > 0 && !search.version ? (
              <button
                type="button"
                aria-pressed={hideDone}
                className="wk-noprint ml-auto flex items-center gap-1 rounded-sm px-1.5 py-0.5 hover:bg-bg2 hover:text-fg"
                onClick={() => setHideDone(!hideDone)}
              >
                <Icon name={hideDone ? 'eye' : 'eyeOff'} size={14} />
                {t(hideDone ? 'wiki.page.showDone' : 'wiki.page.hideDone', { count: doneCount })}
              </button>
            ) : null}
          </p>
          {page.locked ? (
            <div className="wk-noprint mb-5 flex items-center gap-2 rounded-lg bg-bg2 px-3 py-2 text-cap text-fg2">
              <Icon name="lock" size={16} /> {t('wiki.page.lockedBanner')}
              {page.myRole !== 'viewer' ? (
                <Button
                  size="xs"
                  variant="gh"
                  className="ml-auto"
                  onClick={() => void update({ locked: false })}
                >
                  {t('wiki.page.unlock')}
                </Button>
              ) : null}
            </div>
          ) : null}
          {page.deletedAt ? (
            <div className="mb-5 flex items-center gap-2 rounded-lg bg-bg2 px-3 py-2 text-cap text-fg2">
              <Icon name="trash" size={16} /> {t('wiki.page.inTrash')}
            </div>
          ) : null}

          {search.version ? (
            <VersionView
              page={page}
              versionId={search.version}
              onRestored={() => setSearch({ version: undefined })}
              onCopy={async (markdown) => {
                try {
                  const copy = await api.call('createPage', {
                    params: { spaceId: page.spaceId },
                    body: {
                      parentId: page.parentId,
                      name: t('wiki.page.copyName', { name: page.name }),
                      markdown,
                    },
                  });
                  void qc.invalidateQueries({ queryKey: wikiKeys.tree(page.spaceId) });
                  void navigate({
                    to: '/p/$pageRef',
                    params: { pageRef: pagePath(copy).slice(3) },
                  });
                } catch (e) {
                  toast(t(errorKey(e)));
                }
              }}
            />
          ) : collab && user && (collab.status !== 'local' || content.data) ? (
            <>
              {collab.status === 'denied' ? (
                <p className="mb-4 text-cap text-danger">{t('wiki.page.collabDenied')}</p>
              ) : null}
              {page.empty && page.canEdit && collab.status !== 'local' ? (
                <EmptyShortcuts
                  onTemplate={() =>
                    openWikiDialog({
                      kind: 'templates',
                      spaceId: page.spaceId,
                      parentId: page.parentId,
                    })
                  }
                  onImport={() =>
                    openWikiDialog({ kind: 'import', spaceId: page.spaceId, parentId: page.id })
                  }
                  onBlank={() => editorRef.current?.focus()}
                />
              ) : null}
              <PageEditor
                handleRef={editorRef}
                pageId={page.id}
                spaceId={page.spaceId}
                onDoneCount={setDoneCount}
                onEditor={setBodyEditor}
                collab={collab}
                user={user}
                editable={editable}
                initialContent={content.data?.doc}
                threads={threads}
                activeThread={search.comment ?? null}
                onThreadClick={(id) => setSearch({ panel: 'comments', comment: id })}
                onComment={startComment}
                host={{
                  pages: (tree.data?.items ?? []).filter((x) => x.id !== page.id),
                  people: people.data?.items ?? [],
                  spaceMemberIds: memberIds,
                  createSubpage: async () => create(page.spaceId, page.id).then((p) => p),
                }}
              />
            </>
          ) : (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          )}

          {!search.version ? (
            <footer className="wk-noprint mt-14 flex flex-col gap-6 border-t border-line pt-6">
              {kids.length ? (
                <section>
                  <h2 className="eyebrow mb-2">{t('wiki.page.children')}</h2>
                  <div className="flex flex-col gap-1">
                    {kids.map((k) => (
                      <Link
                        key={k.id}
                        to="/p/$pageRef"
                        params={{ pageRef: pagePath(k).slice(3) }}
                        className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[14px] font-medium hover:bg-bg2"
                      >
                        {k.icon ? <span>{k.icon}</span> : <Icon name="page" size={16} />}
                        {k.name}
                      </Link>
                    ))}
                  </div>
                </section>
              ) : null}
              <Backlinks page={page} />
            </footer>
          ) : null}
        </article>
      </PageOutlineLayout>
    </Workspace>
  );
}

function SaveStatus({ collab }: { collab: PageCollab | null }) {
  const { t } = useI18n();
  const save = useCalmSaveState(collab?.unsynced ?? 0);
  if (!collab) return null;
  const synced = collab.status === 'synced' && !collab.readOnly;
  const label =
    collab.status === 'offline'
      ? t('wiki.status.offline', { count: collab.unsynced })
      : collab.status === 'connecting'
        ? t('wiki.status.connecting')
        : collab.status === 'denied'
          ? t('wiki.status.denied')
          : collab.status === 'local'
            ? t('wiki.status.local')
            : collab.readOnly
              ? t('wiki.status.readOnly')
              : save === 'slow'
                ? t('wiki.status.saving')
                : t('wiki.status.saved');
  return (
    <span
      className={cn(
        'flex items-center gap-1.5 px-2 text-cap whitespace-nowrap text-fg3',
        collab.status === 'offline' && 'text-warning',
      )}
      aria-live="polite"
      title={label}
    >
      <Icon
        name={collab.status === 'offline' ? 'wifiOff' : collab.readOnly ? 'eye' : 'cloud'}
        size={14}
      />
      {/*
        Phone: the icon alone; the words would push the page actions off screen. While typing
        the words are hidden but keep their place, so the toolbar does not move.
      */}
      <span
        data-testid="save-status-text"
        className={cn(
          'transition-opacity duration-300 max-md:sr-only',
          synced && save === 'quiet' && 'invisible opacity-0',
        )}
      >
        {label}
      </span>
    </span>
  );
}

interface AwareUser {
  clientId: number;
  user: { id: string; name: string; color: string };
}

/** Everyone on the page (design 5.8): ringed avatars in their caret colour. */
function Presence({ collab, meId }: { collab: PageCollab | null; meId?: string }) {
  const { t } = useI18n();
  const [list, setList] = useState<AwareUser[]>([]);
  useEffect(() => {
    const aw = collab?.provider?.awareness;
    if (!aw) return;
    const read = () => {
      const seen = new Map<string, AwareUser>();
      aw.getStates().forEach((s, clientId) => {
        const u = (s as { user?: AwareUser['user'] }).user;
        if (u?.id && u.id !== meId && !seen.has(u.id)) seen.set(u.id, { clientId, user: u });
      });
      setList([...seen.values()]);
    };
    read();
    aw.on('change', read);
    return () => aw.off('change', read);
  }, [collab?.provider, meId]);
  if (!list.length) return null;
  return (
    <div
      className="flex -space-x-1.5 pr-1"
      aria-label={t('wiki.page.presence', { count: list.length })}
    >
      {list.slice(0, 5).map((p) => (
        <Tooltip key={p.user.id} content={p.user.name}>
          <span
            className="rounded-full"
            style={{ boxShadow: `0 0 0 2px var(--bg), 0 0 0 4px ${p.user.color}` }}
          >
            <Avatar size="sm" name={p.user.name} />
          </span>
        </Tooltip>
      ))}
      {list.length > 5 ? <span className="pl-2 text-cap text-fg3">+{list.length - 5}</span> : null}
    </div>
  );
}

function Cover({
  page,
  canEdit,
  onChange,
}: {
  page: Page;
  canEdit: boolean;
  onChange: (cover: string | null) => void;
}) {
  const { t } = useI18n();
  const preset = page.cover?.startsWith('preset:') ? COVER_PRESETS[page.cover.slice(7)] : undefined;
  return (
    <div
      className="group relative -mx-7 mb-4 h-44 rounded-b-lg"
      style={{ background: preset ?? 'var(--bg2)' }}
    >
      {canEdit ? (
        <div className="wk-noprint absolute right-4 bottom-3 hidden gap-1.5 group-hover:flex">
          {Object.keys(COVER_PRESETS).map((k) => (
            <button
              key={k}
              type="button"
              aria-label={t('wiki.page.coverPick', { name: k })}
              className="size-6 rounded-full border-2 border-white/70"
              style={{ background: COVER_PRESETS[k] }}
              onClick={() => onChange(`preset:${k}`)}
            />
          ))}
          <Button size="xs" variant="default" onClick={() => onChange(null)}>
            {t('wiki.page.coverRemove')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function PageHeader({
  page,
  autoFocus,
  onRename,
  onIcon,
  onCover,
  onComment,
  onEnter,
}: {
  page: Page;
  autoFocus: boolean;
  onRename: (name: string) => void;
  onIcon: (icon: string | null) => void;
  onCover: () => void;
  onComment: () => void;
  onEnter: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(page.name);
  const ref = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (document.activeElement !== ref.current) setName(page.name);
  }, [page.name]);
  useEffect(() => {
    if (autoFocus && ref.current) {
      ref.current.focus();
      ref.current.select();
    }
  }, [autoFocus]);
  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [name]);
  const commit = (v: string) => {
    const trimmed = v.trim();
    if (trimmed && trimmed !== page.name) onRename(trimmed);
  };
  const canEdit = page.canEdit;
  return (
    <div className="group">
      {page.icon ? (
        <IconPicker value={page.icon} disabled={!canEdit} onPick={onIcon}>
          <button
            type="button"
            className="mb-2 text-[56px] leading-none"
            disabled={!canEdit}
            aria-label={t('wiki.page.changeIcon')}
          >
            {page.icon}
          </button>
        </IconPicker>
      ) : null}
      {canEdit ? (
        <div className="wk-noprint mb-1 flex h-7 gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {!page.icon ? (
            <IconPicker value={null} onPick={onIcon}>
              <Button size="xs" variant="gh">
                <Icon name="smile" size={14} /> {t('wiki.page.addIcon')}
              </Button>
            </IconPicker>
          ) : null}
          {!page.cover ? (
            <Button size="xs" variant="gh" onClick={onCover}>
              <Icon name="image" size={14} /> {t('wiki.page.addCover')}
            </Button>
          ) : null}
          <Button size="xs" variant="gh" onClick={onComment}>
            <Icon name="comment" size={14} /> {t('wiki.page.addComment')}
          </Button>
        </div>
      ) : null}
      <textarea
        ref={ref}
        rows={1}
        value={name}
        readOnly={!canEdit}
        aria-label={t('wiki.page.title')}
        placeholder={t('wiki.untitled')}
        onChange={(e) => {
          const v = e.target.value.replace(/\n/g, '');
          setName(v);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => commit(v), 800);
        }}
        onBlur={() => {
          if (timer.current) clearTimeout(timer.current);
          commit(name);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit(name);
            onEnter();
          }
        }}
        className="w-full resize-none overflow-hidden bg-transparent text-[40px] leading-[1.15] font-extrabold tracking-[-0.02em] text-fg outline-none placeholder:text-fg3"
      />
    </div>
  );
}

function IconPicker({
  value,
  disabled,
  onPick,
  children,
}: {
  value: string | null;
  disabled?: boolean;
  onPick: (icon: string | null) => void;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (disabled) return <>{children}</>;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-[264px] p-2">
        <div className="grid grid-cols-8 gap-1">
          {ICONS.map((i) => (
            <button
              key={i}
              type="button"
              className="flex size-7 items-center justify-center rounded-sm text-[18px] hover:bg-bg2"
              onClick={() => {
                onPick(i);
                setOpen(false);
              }}
            >
              {i}
            </button>
          ))}
        </div>
        {value ? (
          <Button
            size="xs"
            variant="gh"
            className="mt-2 w-full"
            onClick={() => {
              onPick(null);
              setOpen(false);
            }}
          >
            {t('wiki.page.removeIcon')}
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function EmptyShortcuts({
  onTemplate,
  onImport,
  onBlank,
}: {
  onTemplate: () => void;
  onImport: () => void;
  onBlank: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="wk-noprint mb-4 flex flex-col gap-1 text-[14px]">
      <button
        type="button"
        onClick={onTemplate}
        className="flex w-fit items-center gap-2 rounded-md px-2 py-1 text-fg2 hover:bg-bg2 hover:text-fg"
      >
        <Icon name="layers" size={16} /> {t('wiki.page.startTemplate')}
      </button>
      <button
        type="button"
        onClick={onImport}
        className="flex w-fit items-center gap-2 rounded-md px-2 py-1 text-fg2 hover:bg-bg2 hover:text-fg"
      >
        <Icon name="upload" size={16} /> {t('wiki.page.startImport')}
      </button>
      <button
        type="button"
        onClick={onBlank}
        className="flex w-fit items-center gap-2 rounded-md px-2 py-1 text-fg2 hover:bg-bg2 hover:text-fg"
      >
        <Icon name="page" size={16} /> {t('wiki.page.startBlank')}
      </button>
    </div>
  );
}

function Backlinks({ page }: { page: Page }) {
  const { t, locale } = useI18n();
  const q = useQuery(backlinksQuery(page.id));
  const items = q.data?.items ?? [];
  return (
    <section>
      <h2 className="eyebrow mb-2">{t('wiki.backlinks.title', { count: items.length })}</h2>
      {items.length === 0 ? (
        <p className="text-cap text-fg3">{t('wiki.backlinks.none')}</p>
      ) : (
        <div className="flex flex-col gap-1">
          {items.map((b) => (
            <Link
              key={b.node.id}
              to="/p/$pageRef"
              params={{ pageRef: pagePath(b.node).slice(3) }}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[14px] hover:bg-bg2"
            >
              {b.node.icon ? <span>{b.node.icon}</span> : <Icon name="page" size={16} />}
              <span className="font-medium">{b.node.name}</span>
              <span className="text-cap text-fg3">
                {b.kinds.map((k) => t(`wiki.backlinks.kind.${k}`)).join(', ')} ·{' '}
                {formatDate(b.updatedAt, locale)}
              </span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

function PageMenu({
  page,
  fullWidth,
  onFullWidth,
  onToggle,
  onHistory,
  onExport,
  onDuplicate,
  onMove,
  onFavorite,
  onFollowDescendants,
  onToPortal,
  onTrash,
  onSaveTemplate,
  onImport,
}: {
  page: Page;
  /** The person's choice for every page (UiPrefs), not a page setting. */
  fullWidth: boolean;
  onFullWidth: (next: boolean) => void;
  onToggle: (key: 'smallText' | 'locked', value: boolean) => void;
  onHistory: () => void;
  onExport: () => void;
  onDuplicate: () => void;
  onMove: () => void;
  onFavorite: () => void;
  /** Follows the page with its sub-pages, or back to the page alone. */
  onFollowDescendants: () => void;
  /** Absent for people who may not edit the portal, or with the module off. */
  onToPortal?: (() => void) | undefined;
  onTrash: () => void;
  onSaveTemplate: () => void;
  onImport: () => void;
}) {
  const { t } = useI18n();
  const editor = page.myRole !== 'viewer';
  const check = (on: boolean) => (on ? <Icon name="check" size={14} /> : undefined);
  return (
    <Menu>
      <MenuTrigger asChild>
        <IconButton aria-label={t('wiki.page.menu')} size="sm" tone="plain">
          <Icon name="dots" size={18} />
        </IconButton>
      </MenuTrigger>
      <MenuContent align="end" className="w-60">
        <MenuItem icon="frame" shortcut={check(fullWidth)} onSelect={() => onFullWidth(!fullWidth)}>
          {t('wiki.menu.fullWidth')}
        </MenuItem>
        {editor ? (
          <>
            <MenuItem
              icon="text"
              shortcut={check(page.smallText)}
              onSelect={() => onToggle('smallText', !page.smallText)}
            >
              {t('wiki.menu.smallText')}
            </MenuItem>
            <MenuItem
              icon={page.locked ? 'unlock' : 'lock'}
              onSelect={() => onToggle('locked', !page.locked)}
            >
              {t(page.locked ? 'wiki.menu.unlock' : 'wiki.menu.lock')}
            </MenuItem>
            <MenuSeparator />
          </>
        ) : null}
        <MenuItem icon="star" onSelect={onFavorite}>
          {t(page.favorite ? 'wiki.menu.unfavorite' : 'wiki.menu.favorite')}
        </MenuItem>
        <MenuItem
          icon="bell"
          shortcut={check(Boolean(page.following && page.followingDescendants))}
          onSelect={onFollowDescendants}
        >
          {t('wiki.menu.followDescendants')}
        </MenuItem>
        <MenuItem
          icon="link"
          shortcut="Ctrl ⇧ C"
          onSelect={() => {
            void navigator.clipboard?.writeText(`${window.location.origin}${pagePath(page)}`);
            toast(t('wiki.menu.linkCopied'));
          }}
        >
          {t('wiki.menu.copyLink')}
        </MenuItem>
        {editor ? (
          <>
            <MenuItem icon="copy" onSelect={onDuplicate}>
              {t('wiki.menu.duplicate')}
            </MenuItem>
            <MenuItem icon="arrowR" onSelect={onMove}>
              {t('wiki.menu.move')}
            </MenuItem>
            <MenuItem icon="layers" onSelect={onSaveTemplate}>
              {t('wiki.menu.saveTemplate')}
            </MenuItem>
          </>
        ) : null}
        <MenuSeparator />
        <MenuItem icon="history" onSelect={onHistory}>
          {t('wiki.menu.history')}
        </MenuItem>
        {editor ? (
          <MenuItem icon="upload" onSelect={onImport}>
            {t('wiki.menu.import')}
          </MenuItem>
        ) : null}
        <MenuItem icon="download" onSelect={onExport}>
          {t('wiki.menu.export')}
        </MenuItem>
        {onToPortal ? (
          <MenuItem icon="portal" onSelect={onToPortal}>
            {t('wiki.menu.toPortal')}
          </MenuItem>
        ) : null}
        {editor ? (
          <>
            <MenuSeparator />
            <MenuItem icon="trash" danger onSelect={onTrash}>
              {t('wiki.menu.trash')}
            </MenuItem>
          </>
        ) : null}
      </MenuContent>
    </Menu>
  );
}
