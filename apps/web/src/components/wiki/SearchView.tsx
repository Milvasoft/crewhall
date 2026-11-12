import {
  pagePath,
  SNIPPET_MARK_END,
  SNIPPET_MARK_START,
  type PageSearchHit,
} from '@crewhall/shared';
import {
  Avatar,
  Chip,
  Icon,
  Input,
  Kbd,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { Workspace } from '@/components/shell/Workspace';
import { spaceName } from '@/components/spaces/spaceUtils';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useSpaces } from '@/lib/useSpaces';
import { wikiKeys } from '@/lib/wiki/api';
import { WikiSidebar } from './WikiSidebar';
import './wiki.css';

export interface SearchParams {
  q?: string;
  space?: string;
  comments?: boolean;
  days?: number;
}

/** Snippet with the matched words highlighted (markers come from the server, never HTML). */
export function Snippet({ text }: { text: string }): ReactNode {
  const parts: ReactNode[] = [];
  let rest = text;
  while (rest.length) {
    const s = rest.indexOf(SNIPPET_MARK_START);
    if (s < 0) {
      parts.push(<Fragment key={parts.length}>{rest}</Fragment>);
      break;
    }
    const e = rest.indexOf(SNIPPET_MARK_END, s);
    parts.push(<Fragment key={parts.length}>{rest.slice(0, s)}</Fragment>);
    parts.push(<mark key={parts.length}>{rest.slice(s + 1, e < 0 ? undefined : e)}</mark>);
    if (e < 0) break;
    rest = rest.slice(e + 1);
  }
  return <span className="wk-snippet">{parts}</span>;
}

/** Full-text search over pages and comments (design 5.18). */
export function SearchView({ search }: { search: SearchParams }) {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const { items: spaces, preferred } = useSpaces();
  const [text, setText] = useState(search.q ?? '');
  const q = (search.q ?? '').trim();
  const comments = search.comments ?? true;
  const query = useQuery({
    queryKey: wikiKeys.search({ q, space: search.space, comments, days: search.days }),
    queryFn: ({ signal }) =>
      api.call('searchPages', {
        query: {
          q,
          spaceId: search.space,
          comments: comments ? 'true' : 'false',
          days: search.days,
          limit: 30,
        },
        signal,
      }),
    enabled: q.length > 0,
  });

  useEffect(() => {
    const h = setTimeout(() => {
      if (text.trim() !== q) {
        void navigate({
          to: '/pages/search',
          search: (s: SearchParams) => ({ ...s, q: text.trim() || undefined }),
          replace: true,
        });
      }
    }, 300);
    return () => clearTimeout(h);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (next: Partial<SearchParams>) =>
    void navigate({
      to: '/pages/search',
      search: (s: SearchParams) => ({ ...s, ...next }),
      replace: true,
    });
  const hits = query.data?.items ?? [];

  return (
    <Workspace
      sidebar={<WikiSidebar space={spaces.find((s) => s.id === search.space) ?? preferred()} />}
      crumbs={[{ label: t('shell.modules.pages') }, { label: t('wiki.search.title') }]}
    >
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4">
        <div className="relative">
          <Icon
            name="search"
            size={18}
            className="absolute top-1/2 left-3 -translate-y-1/2 text-fg3"
          />
          <Input
            autoFocus
            className="pl-10"
            value={text}
            placeholder={t('wiki.search.placeholder')}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setText('');
              if (e.key === 'Enter' && hits[0]) {
                void navigate({
                  to: '/p/$pageRef',
                  params: { pageRef: pagePath(hits[0].node).slice(3) },
                });
              }
            }}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={search.space ?? 'all'}
            onValueChange={(v) => set({ space: v === 'all' ? undefined : v })}
          >
            <SelectTrigger className="h-8 w-auto min-w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('wiki.search.allSpaces')}</SelectItem>
              {spaces.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {spaceName(s, t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Chip
            on={search.days === 90}
            onClick={() => set({ days: search.days === 90 ? undefined : 90 })}
          >
            {t('wiki.search.last90')}
          </Chip>
          <Chip on={comments} onClick={() => set({ comments: !comments })}>
            {t('wiki.search.inComments')}
          </Chip>
          {query.data ? (
            <span className="ml-auto text-cap text-fg3">
              {t('wiki.search.count', { count: hits.length })}
            </span>
          ) : null}
        </div>
        {!q ? (
          <p className="py-10 text-center text-sm text-fg3">{t('wiki.search.hint')}</p>
        ) : query.isPending ? (
          <div className="flex flex-col gap-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        ) : hits.length === 0 ? (
          <p className="py-10 text-center text-sm text-fg3">{t('wiki.search.none', { q })}</p>
        ) : (
          <div className="flex flex-col gap-1">
            {hits.map((h, i) => (
              <Hit key={`${h.node.id}-${i}`} hit={h} first={i === 0} locale={locale} />
            ))}
          </div>
        )}
      </div>
    </Workspace>
  );
}

function Hit({ hit, first, locale }: { hit: PageSearchHit; first: boolean; locale: 'tr' | 'en' }) {
  const { t } = useI18n();
  return (
    <Link
      to="/p/$pageRef"
      params={{ pageRef: pagePath(hit.node).slice(3) }}
      search={{}}
      className="flex flex-col gap-1 rounded-lg px-4 py-3 hover:bg-bg2"
    >
      <span className="flex items-center gap-2">
        {hit.node.icon ? <span>{hit.node.icon}</span> : <Icon name="page" size={16} />}
        <b className="text-[15px] font-semibold text-fg">{hit.node.name}</b>
        <span className="truncate text-cap text-fg3">
          {spaceName({ kind: 'shared', name: hit.space.name }, t)}
          {hit.path ? ` › ${hit.path}` : ''} · {t(`wiki.search.matched.${hit.matchedIn}`)}
        </span>
        {first ? <Kbd className="ml-auto">Enter</Kbd> : null}
      </span>
      {hit.snippet ? (
        <span className="line-clamp-2 text-[13.5px] text-fg2">
          <Snippet text={hit.snippet} />
        </span>
      ) : null}
      <span className="flex items-center gap-1.5 text-xs text-fg3">
        {(hit.author ?? hit.updatedBy) ? (
          <Avatar
            size="sm"
            name={(hit.author ?? hit.updatedBy)!.name}
            src={(hit.author ?? hit.updatedBy)!.imageUrl ?? undefined}
          />
        ) : null}
        {(hit.author ?? hit.updatedBy)?.name} · {formatDate(hit.updatedAt, locale)}
      </span>
    </Link>
  );
}
