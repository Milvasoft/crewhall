import { type PortalPostSummary } from '@crewhall/shared';
import {
  Avatar,
  Button,
  Chip,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  EmptyState,
  Field,
  Icon,
  Input,
  Skeleton,
  Table,
  Td,
  Th,
  Tr,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { authorsQuery, invalidatePortal, postQuery, postsQuery } from '@/lib/portal/api';
import { usePortalSite } from '@/lib/portal/context';
import { LocaleTag, PageHeader, StatusChip, useWhen } from '@/components/portal/common';
import { PortalPage } from '@/components/portal/PortalPage';

type Filter = 'all' | 'published' | 'scheduled' | 'draft';
const FILTERS: Filter[] = ['all', 'published', 'scheduled', 'draft'];

const matches = (p: PortalPostSummary, f: Filter) =>
  f === 'all' ||
  (f === 'published' ? p.status === 'published' || p.status === 'changed' : p.status === f);

/** 10.6 Blog posts: one row per post in the source language, translations as tags. */
export function BlogList() {
  const { t } = useI18n();
  const { site } = usePortalSite();
  const navigate = useNavigate();
  const search = useSearch({ from: '/_app/portal/$siteSlug/blog/' });
  const filter: Filter = search.status ?? 'all';
  const posts = useQuery(postsQuery(site.id, { locale: site.defaultLocale }));
  const authors = useQuery(authorsQuery(site.id));
  const when = useWhen();
  const [creating, setCreating] = useState(false);
  const all = posts.data?.items ?? [];
  const rows = all.filter((p) => matches(p, filter));
  const open = (postId: string) =>
    void navigate({
      to: '/portal/$siteSlug/blog/$postId',
      params: { siteSlug: site.slug, postId },
    });

  return (
    <PortalPage crumbs={[{ label: t('portal.nav.blog') }]} previewPath="/blog">
      <PageHeader
        title={t('portal.nav.blog')}
        subtitle={t('portal.blog.subtitle', {
          count: all.length,
          n: authors.data?.items.length ?? 0,
        })}
        actions={
          site.capabilities.edit ? (
            <Button variant="inv" size="sm" onClick={() => setCreating(true)}>
              <Icon name="plus" size={16} />
              {t('portal.blog.new')}
            </Button>
          ) : null
        }
      />
      <div role="group" aria-label={t('portal.blog.filter')} className="flex gap-1.5">
        {FILTERS.map((f) => (
          <Chip
            key={f}
            on={filter === f}
            onClick={() =>
              void navigate({
                to: '/portal/$siteSlug/blog',
                params: { siteSlug: site.slug },
                search: f === 'all' ? {} : { status: f },
              })
            }
          >
            {t(`portal.blog.filters.${f}`)}
            <span className="text-xs opacity-70">{all.filter((p) => matches(p, f)).length}</span>
          </Chip>
        ))}
      </div>
      <div className="overflow-hidden rounded-2xl bg-surface shadow-line">
        <Table aria-label={t('portal.blog.table')}>
          <thead>
            <tr>
              <Th>{t('portal.blog.col.title')}</Th>
              <Th>{t('portal.blog.col.status')}</Th>
              <Th>{t('portal.blog.col.author')}</Th>
              <Th>{t('portal.blog.col.language')}</Th>
              <Th>{t('portal.blog.col.date')}</Th>
              <Th className="text-right">{t('portal.blog.col.reading')}</Th>
            </tr>
          </thead>
          <tbody>
            {posts.isPending ? (
              <tr>
                <Td colSpan={6}>
                  <Skeleton className="h-5" />
                </Td>
              </tr>
            ) : !rows.length ? (
              <tr>
                <Td colSpan={6}>
                  <EmptyState icon="edit" title={t('portal.blog.empty')} />
                </Td>
              </tr>
            ) : (
              rows.map((p) => (
                <Tr
                  key={p.id}
                  className="cursor-pointer hover:[&>td]:bg-bg2"
                  onClick={() => open(p.id)}
                  onKeyDown={(e) => e.key === 'Enter' && open(p.id)}
                  tabIndex={0}
                >
                  <Td className="max-w-[420px] whitespace-normal">
                    <span className="flex flex-col">
                      <span className="truncate font-semibold">{p.title}</span>
                      <span className="truncate font-mono text-xs text-fg3">/blog/{p.slug}</span>
                    </span>
                  </Td>
                  <Td>
                    <StatusChip status={p.status} />
                  </Td>
                  <Td>
                    <span className="flex items-center gap-1.5">
                      {p.authors.map((a) => (
                        <Avatar key={a.id} name={a.name} src={a.imageUrl} size="sm" />
                      ))}
                      <span className="flex flex-col text-xs">
                        <span className="max-w-[160px] truncate font-semibold">
                          {p.authors.map((a) => a.name).join(', ')}
                        </span>
                        {p.authors[0] && !p.authors[0].user ? (
                          <span className="text-fg3">{t('portal.blog.external')}</span>
                        ) : null}
                      </span>
                    </span>
                  </Td>
                  <Td>
                    <span className="flex gap-1">
                      {p.translations.map((tr) => (
                        <LocaleTag key={tr.locale} code={tr.locale} missing={!tr.postId} />
                      ))}
                    </span>
                  </Td>
                  <Td className="text-fg2">
                    {p.status === 'scheduled'
                      ? when(p.scheduledAt)
                      : p.date
                        ? when(p.date, true)
                        : '-'}
                  </Td>
                  <Td className="text-right text-fg2 tn">
                    {t('portal.blog.minutes', { count: p.readingMinutes })}
                  </Td>
                </Tr>
              ))
            )}
          </tbody>
        </Table>
      </div>
      {creating ? <NewPostDialog onClose={() => setCreating(false)} onCreated={open} /> : null}
    </PortalPage>
  );
}

function NewPostDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { t } = useI18n();
  const { site } = usePortalSite();
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const create = useMutation({
    mutationFn: () =>
      api.call('createPortalPost', {
        params: { siteId: site.id },
        body: { locale: site.defaultLocale, title: title.trim() },
      }),
    onSuccess: (p) => {
      qc.setQueryData(postQuery(p.id).queryKey, p);
      invalidatePortal(qc);
      onCreated(p.id);
    },
  });
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent width={460}>
        <DialogHeader icon="edit" title={t('portal.blog.new')} />
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) create.mutate();
          }}
        >
          <Field
            label={t('portal.post.title')}
            error={create.error ? t(errorKey(create.error)) : undefined}
          >
            <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <DialogFooter>
            <Button variant="gh" size="sm" onClick={onClose}>
              {t('portal.common.cancel')}
            </Button>
            <Button
              type="submit"
              variant="inv"
              size="sm"
              disabled={!title.trim()}
              loading={create.isPending}
            >
              {t('portal.common.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
