import { type PortalPost, type UpdatePortalPost } from '@crewhall/shared';
import {
  Avatar,
  Button,
  cn,
  EmptyState,
  Icon,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Radio,
  RadioGroup,
  Skeleton,
  DatePicker,
  TimePicker,
  toast,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useCallback, useState } from 'react';
import { api, isApiError } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { formatNumber } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { authorsQuery, invalidatePortal, postQuery } from '@/lib/portal/api';
import { useAutosave } from '@/lib/portal/autosave';
import { usePortalSite } from '@/lib/portal/context';
import { useNow } from '@/lib/useNow';
import {
  fromZoned,
  localeName,
  localeTag,
  offsetLabel,
  postPath,
  slugify,
  toZoned,
} from '@/lib/portal/format';
import {
  ConfirmDialog,
  Counter,
  FieldRow,
  PrefixedInput,
  SaveStatus,
  smallInput,
  StatusChip,
  useWhen,
} from '@/components/portal/common';
import { ConflictBanner } from '@/components/portal/docs/DocEditor';
import { MediaPicker, MediaThumb } from '@/components/portal/MediaPicker';
import { PortalEditor } from '@/components/portal/PortalEditor';
import { PortalPage } from '@/components/portal/PortalPage';
import { ResizablePane } from '@/components/shell/ResizablePane';

type Patch = Omit<UpdatePortalPost, 'baseRev'>;

/** 10.7 post editor route: loads the post and keys the editor by id (and reloads). */
export function PostEditorScreen() {
  const { t } = useI18n();
  const { postId } = useParams({ from: '/_app/portal/$siteSlug/blog/$postId' });
  const { site } = usePortalSite();
  const qc = useQueryClient();
  const post = useQuery(postQuery(postId));
  const [reload, setReload] = useState(0);
  const p = post.data;
  return (
    <PortalPage
      crumbs={[{ label: t('portal.nav.blog') }, { label: p?.title ?? '' }]}
      previewPath={p ? postPath(site, p.locale, p.slug) : null}
      bodyClassName="flex-row gap-0 p-0 overflow-hidden max-md:flex-col max-md:overflow-y-auto"
    >
      {post.isError ? (
        <EmptyState className="m-auto" icon="alert" title={t(errorKey(post.error))} />
      ) : !p ? (
        <div className="flex flex-1 flex-col gap-3 p-8">
          <Skeleton className="h-40 rounded-2xl" />
          <Skeleton className="h-8 w-1/2" />
        </div>
      ) : (
        <PostEditor
          key={`${p.id}:${reload}`}
          post={p}
          onReload={async () => {
            await qc.invalidateQueries({ queryKey: postQuery(p.id).queryKey });
            setReload((r) => r + 1);
          }}
        />
      )}
    </PortalPage>
  );
}

function PostEditor({ post, onReload }: { post: PortalPost; onReload: () => void }) {
  const { t, locale } = useI18n();
  const { site } = usePortalSite();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const when = useWhen();
  const tz = site.settings.timezone;
  const canEdit = site.capabilities.edit;
  const save = useCallback(
    async (patch: Patch, baseRev: number) => {
      const p = await api.call('updatePortalPost', {
        params: { postId: post.id },
        body: { ...patch, baseRev },
      });
      qc.setQueryData(postQuery(post.id).queryKey, p);
      invalidatePortal(qc);
      return p.rev;
    },
    [post.id, qc],
  );
  const autosave = useAutosave<Patch>({ rev: post.rev, save });
  const [title, setTitle] = useState(post.title);
  const [slug, setSlug] = useState(post.slug);
  const [description, setDescription] = useState(post.description ?? '');
  const [tags, setTags] = useState(post.tags);
  const [tagDraft, setTagDraft] = useState('');
  const [authorIds, setAuthorIds] = useState(post.authors.map((a) => a.id));
  const [cover, setCover] = useState(post.cover);
  const [coverOpen, setCoverOpen] = useState(false);
  const [mode, setMode] = useState<'now' | 'schedule'>(post.scheduledAt ? 'schedule' : 'now');
  const now = useNow(60_000);
  const [initial] = useState(() =>
    toZoned(post.scheduledAt ?? new Date(Date.now() + 86_400_000).toISOString(), tz),
  );
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(post.scheduledAt ? initial.time : '10:00');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const scheduledIso = mode === 'schedule' ? fromZoned(date, time, tz) : null;
  const slugError = isApiError(autosave.error, 'portal_slug_taken');

  const schedule = (m: 'now' | 'schedule', d = date, tm = time) => {
    setMode(m);
    autosave.queue({ scheduledAt: m === 'schedule' ? fromZoned(d, tm, tz) : null });
  };

  const translate = useMutation({
    mutationFn: (l: string) =>
      api.call('createPortalPost', {
        params: { siteId: site.id },
        body: { locale: l, title: post.title, translationOf: post.id },
      }),
    onSuccess: (p) => {
      invalidatePortal(qc);
      void navigate({
        to: '/portal/$siteSlug/blog/$postId',
        params: { siteSlug: site.slug, postId: p.id },
      });
    },
    onError: (e) => toast(t(errorKey(e))),
  });

  const statusText =
    post.status === 'scheduled' && post.scheduledAt
      ? t('portal.post.scheduledFor', { when: when(post.scheduledAt) })
      : undefined;
  const relDays = scheduledIso
    ? Math.round((new Date(scheduledIso).getTime() - now) / 86_400_000)
    : 0;
  const weekday = scheduledIso
    ? new Intl.DateTimeFormat(locale === 'tr' ? 'tr-TR' : 'en-US', {
        weekday: 'long',
        timeZone: tz,
      }).format(new Date(scheduledIso))
    : '';

  return (
    <>
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto max-md:flex-none max-md:overflow-visible">
        <div className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2.5 border-b border-line bg-bg px-6">
          <StatusChip status={post.status}>{statusText}</StatusChip>
          <span className="text-xs text-fg2">
            {t('portal.post.words', { count: post.wordCount })}
          </span>
          <SaveStatus state={autosave.state} savedAt={autosave.savedAt} />
          <div className="ml-auto flex items-center gap-2">
            <div
              role="group"
              aria-label={t('portal.docs.language')}
              className="flex gap-0.5 rounded-md bg-bg2 p-[3px]"
            >
              {post.translations.map((tr) => (
                <button
                  key={tr.locale}
                  type="button"
                  aria-pressed={tr.locale === post.locale}
                  aria-label={localeName(tr.locale, locale)}
                  onClick={() =>
                    tr.postId
                      ? void navigate({
                          to: '/portal/$siteSlug/blog/$postId',
                          params: { siteSlug: site.slug, postId: tr.postId },
                        })
                      : canEdit && translate.mutate(tr.locale)
                  }
                  className={cn(
                    'flex h-[26px] items-center gap-1 rounded-sm px-2 text-xs font-semibold text-fg2',
                    tr.locale === post.locale && 'bg-surface text-fg shadow-sm dark:bg-capsule',
                  )}
                >
                  {localeTag(tr.locale)}
                  {!tr.postId ? (
                    <span className="font-normal text-fg3">{t('portal.docs.none')}</span>
                  ) : null}
                </button>
              ))}
            </div>
            {canEdit ? (
              <Menu>
                <MenuTrigger asChild>
                  <IconButton aria-label={t('portal.docs.more')} size="sm" shape="sq" tone="plain">
                    <Icon name="dots" size={16} />
                  </IconButton>
                </MenuTrigger>
                <MenuContent align="end">
                  <MenuItem icon="trash" danger onSelect={() => setConfirmDelete(true)}>
                    {t('portal.common.delete')}
                  </MenuItem>
                </MenuContent>
              </Menu>
            ) : null}
          </div>
        </div>
        <div className="mx-auto flex w-full max-w-[820px] flex-col gap-5 px-8 py-6 max-md:px-4">
          {autosave.state === 'conflict' ? <ConflictBanner onReload={onReload} /> : null}
          <div className="relative aspect-[5/2] w-full overflow-hidden rounded-2xl bg-bg2">
            {cover ? (
              <MediaThumb path={cover} className="object-cover" />
            ) : (
              <span className="flex size-full flex-col items-center justify-center gap-2 text-sm text-fg2">
                <Icon name="image" size={28} />
                {t('portal.post.noCover')}
              </span>
            )}
            {canEdit ? (
              <span className="absolute right-3 bottom-3 flex gap-1.5">
                <Button size="xs" variant="inv" onClick={() => setCoverOpen(true)}>
                  <Icon name="image" size={14} />
                  {cover ? t('portal.post.changeCover') : t('portal.post.addCover')}
                </Button>
                {cover ? (
                  <Button
                    size="xs"
                    variant="default"
                    onClick={() => {
                      setCover(null);
                      autosave.queue({ cover: null });
                    }}
                  >
                    {t('portal.common.remove')}
                  </Button>
                ) : null}
              </span>
            ) : null}
            {cover ? (
              <span className="absolute bottom-3 left-3 rounded-sm bg-black/55 px-2 py-1 font-mono text-[11px] text-white">
                {cover.split('/').pop()}
              </span>
            ) : null}
          </div>
          <input
            aria-label={t('portal.post.title')}
            value={title}
            disabled={!canEdit}
            onChange={(e) => {
              setTitle(e.target.value);
              if (e.target.value.trim()) autosave.queue({ title: e.target.value });
            }}
            className="w-full bg-transparent text-large font-bold outline-none placeholder:text-fg3"
            placeholder={t('portal.post.titlePlaceholder')}
          />
          <PortalEditor
            siteId={site.id}
            value={post.content}
            editable={canEdit && autosave.state !== 'conflict'}
            enableTruncate
            onChange={(content) => autosave.queue({ content })}
          />
        </div>
      </div>
      <ResizablePane id="portal-post" side="right" defaultWidth={320} className="max-md:w-full">
        <aside
          aria-label={t('portal.post.settings')}
          className="flex w-full min-w-0 flex-col gap-4 overflow-y-auto border-l border-line px-5 py-4 max-md:w-full max-md:overflow-visible max-md:border-t max-md:border-l-0"
        >
          <h2 className="m-0 text-sub font-semibold">{t('portal.post.settings')}</h2>
          <FieldRow label={t('portal.post.slug')} htmlFor="post-slug">
            <PrefixedInput
              id="post-slug"
              prefix="/blog/"
              value={slug}
              disabled={!canEdit}
              aria-invalid={slugError || undefined}
              onChange={(e) => {
                const v = slugify(e.target.value) || e.target.value.replace(/[^A-Za-z0-9._-]/g, '');
                setSlug(v);
                if (v) autosave.queue({ slug: v });
              }}
            />
            {slugError ? (
              <span role="alert" className="text-xs text-danger">
                {t('errors.portal_slug_taken')}
              </span>
            ) : null}
          </FieldRow>
          <FieldRow label={t('portal.post.authors')}>
            <div className="flex flex-wrap items-center gap-1.5">
              {post.authors
                .filter((a) => authorIds.includes(a.id))
                .concat([])
                .map((a) => (
                  <AuthorChip
                    key={a.id}
                    name={a.name}
                    src={a.imageUrl}
                    onRemove={
                      canEdit
                        ? () => {
                            const ids = authorIds.filter((x) => x !== a.id);
                            setAuthorIds(ids);
                            autosave.queue({ authorIds: ids });
                          }
                        : undefined
                    }
                  />
                ))}
              <ExtraAuthors
                ids={authorIds.filter((id) => !post.authors.some((a) => a.id === id))}
                onRemove={(id) => {
                  const ids = authorIds.filter((x) => x !== id);
                  setAuthorIds(ids);
                  autosave.queue({ authorIds: ids });
                }}
              />
              {canEdit ? (
                <AddAuthor
                  selected={authorIds}
                  onAdd={(id) => {
                    const ids = [...authorIds, id];
                    setAuthorIds(ids);
                    autosave.queue({ authorIds: ids });
                  }}
                />
              ) : null}
            </div>
          </FieldRow>
          <FieldRow label={t('portal.post.tags')} htmlFor="post-tag">
            <div className="flex flex-wrap items-center gap-1.5">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex h-7 items-center gap-1 rounded-full bg-bg2 pr-1 pl-2.5 text-xs font-semibold"
                >
                  {tag}
                  {canEdit ? (
                    <button
                      type="button"
                      aria-label={t('portal.post.removeTag', { name: tag })}
                      className="flex size-5 items-center justify-center rounded-full text-fg2 hover:bg-capsule"
                      onClick={() => {
                        const next = tags.filter((x) => x !== tag);
                        setTags(next);
                        autosave.queue({ tags: next });
                      }}
                    >
                      <Icon name="x" size={12} />
                    </button>
                  ) : null}
                </span>
              ))}
              {canEdit ? (
                <input
                  id="post-tag"
                  value={tagDraft}
                  placeholder={t('portal.post.addTag')}
                  onChange={(e) => setTagDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' && e.key !== ',') return;
                    e.preventDefault();
                    const v = slugify(tagDraft);
                    if (v && !tags.includes(v)) {
                      const next = [...tags, v];
                      setTags(next);
                      autosave.queue({ tags: next });
                    }
                    setTagDraft('');
                  }}
                  className="h-7 w-24 min-w-0 flex-1 rounded-full bg-transparent px-2 text-xs outline-none placeholder:text-fg3"
                />
              ) : null}
            </div>
          </FieldRow>
          <FieldRow label={t('portal.post.timing')}>
            <RadioGroup
              value={mode}
              onValueChange={(v) => schedule(v as 'now' | 'schedule')}
              disabled={!canEdit}
              className="flex flex-col gap-2"
              aria-label={t('portal.post.timing')}
            >
              <label className="flex items-center gap-2 text-[13px]">
                <Radio value="now" />
                {t('portal.post.now')}
              </label>
              <label className="flex items-center gap-2 text-[13px]">
                <Radio value="schedule" />
                {t('portal.post.schedule')}
              </label>
            </RadioGroup>
            {mode === 'schedule' ? (
              <div className="flex flex-col gap-1.5 pl-6">
                <div className="flex gap-1.5">
                  <DatePicker
                    size="sm"
                    className="min-w-0 flex-1"
                    aria-label={t('portal.post.date')}
                    value={date || null}
                    clearable={false}
                    disabled={!canEdit}
                    onChange={(v) => {
                      if (!v) return;
                      setDate(v);
                      schedule('schedule', v, time);
                    }}
                  />
                  <TimePicker
                    size="sm"
                    className="w-28"
                    aria-label={t('portal.post.time')}
                    value={time || null}
                    disabled={!canEdit}
                    onChange={(v) => {
                      if (!v) return;
                      setTime(v);
                      schedule('schedule', date, v);
                    }}
                  />
                </div>
                <span className="text-xs text-fg2">
                  {t('portal.post.zoneHint', {
                    name: tz,
                    current: offsetLabel(tz),
                    date: weekday,
                    days: relDays,
                  })}
                </span>
              </div>
            ) : null}
          </FieldRow>
          <FieldRow
            label={t('portal.post.reading')}
            aside={<span className="text-xs text-fg3">{t('portal.post.auto')}</span>}
          >
            <div className="flex items-center justify-between rounded-md bg-bg2 px-3 py-2 text-[13px]">
              <span className="font-semibold">
                {t('portal.post.readingMinutes', { count: post.readingMinutes })}
              </span>
              <span className="text-xs text-fg2">
                {t('portal.post.counts', {
                  value: formatNumber(post.wordCount, locale),
                  n: post.codeBlockCount,
                })}
              </span>
            </div>
          </FieldRow>
          <FieldRow
            label={t('portal.post.description')}
            htmlFor="post-desc"
            aside={<Counter value={description} max={160} />}
          >
            <textarea
              id="post-desc"
              className={cn(smallInput, 'h-auto min-h-24 py-2')}
              value={description}
              disabled={!canEdit}
              onChange={(e) => {
                setDescription(e.target.value);
                autosave.queue({ description: e.target.value || null });
              }}
            />
          </FieldRow>
        </aside>
      </ResizablePane>
      <MediaPicker
        open={coverOpen}
        onOpenChange={setCoverOpen}
        folder="blog"
        onPick={(path) => {
          setCover(path);
          autosave.queue({ cover: path });
        }}
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        danger
        title={t('portal.post.deleteTitle', { title: post.title })}
        description={
          post.published ? t('portal.post.deletePublished') : t('portal.post.deleteDraft')
        }
        confirm={t('portal.common.delete')}
        onConfirm={async () => {
          try {
            await api.call('deletePortalPost', { params: { postId: post.id } });
            invalidatePortal(qc);
            void navigate({ to: '/portal/$siteSlug/blog', params: { siteSlug: site.slug } });
          } catch (e) {
            toast(t(errorKey(e)));
          }
        }}
      />
    </>
  );
}

function AuthorChip({
  name,
  src,
  onRemove,
}: {
  name: string;
  src: string | null;
  onRemove?: () => void;
}) {
  const { t } = useI18n();
  return (
    <span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-bg2 pr-1 pl-1 text-xs font-semibold">
      <Avatar name={name} src={src} size="sm" className="size-5 text-[9px]" />
      {name}
      {onRemove ? (
        <button
          type="button"
          aria-label={t('portal.post.removeAuthor', { name })}
          onClick={onRemove}
          className="flex size-5 items-center justify-center rounded-full text-fg2 hover:bg-capsule"
        >
          <Icon name="x" size={12} />
        </button>
      ) : null}
    </span>
  );
}

/** Authors added in this session (not yet in the saved post's author list). */
function ExtraAuthors({ ids, onRemove }: { ids: string[]; onRemove: (id: string) => void }) {
  const { site } = usePortalSite();
  const authors = useQuery(authorsQuery(site.id));
  return (
    <>
      {ids.map((id) => {
        const a = authors.data?.items.find((x) => x.id === id);
        return a ? (
          <AuthorChip key={id} name={a.name} src={a.imageUrl} onRemove={() => onRemove(id)} />
        ) : null;
      })}
    </>
  );
}

function AddAuthor({ selected, onAdd }: { selected: string[]; onAdd: (id: string) => void }) {
  const { t } = useI18n();
  const { site } = usePortalSite();
  const qc = useQueryClient();
  const authors = useQuery(authorsQuery(site.id));
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () =>
      api.call('createPortalAuthor', {
        params: { siteId: site.id },
        body: { key: slugify(name).replace(/-/g, '') || 'author', name: name.trim() },
      }),
    onSuccess: (a) => {
      void qc.invalidateQueries({ queryKey: authorsQuery(site.id).queryKey });
      onAdd(a.id);
      setName('');
      setOpen(false);
    },
    onError: (e) => toast(t(errorKey(e))),
  });
  const rest = (authors.data?.items ?? []).filter((a) => !selected.includes(a.id));
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-xs font-semibold text-fg2 shadow-line2 hover:bg-bg2"
        >
          <Icon name="plus" size={12} />
          {t('portal.post.addAuthor')}
        </button>
      </PopoverTrigger>
      <PopoverContent className="flex w-64 flex-col gap-1 p-2">
        {rest.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => {
              onAdd(a.id);
              setOpen(false);
            }}
            className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[13px] hover:bg-capsule"
          >
            <Avatar name={a.name} src={a.imageUrl} size="sm" />
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-semibold">{a.name}</span>
              <span className="truncate text-xs text-fg2">
                {a.user ? a.user.email : t('portal.blog.external')}
              </span>
            </span>
          </button>
        ))}
        <span className="my-1 h-px bg-line" />
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('portal.post.externalAuthor')}
            aria-label={t('portal.post.externalAuthor')}
            className={smallInput}
          />
          <Button
            type="submit"
            size="xs"
            variant="inv"
            disabled={!name.trim()}
            loading={create.isPending}
          >
            {t('portal.common.add')}
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
