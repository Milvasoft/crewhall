import { pagePath, type DriveNode } from '@crewhall/shared';
import {
  Checkbox,
  cn,
  EmptyState,
  Icon,
  IconButton,
  SelectAllCheckbox,
  Skeleton,
  SpaceDot,
} from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Workspace } from '@/components/shell/Workspace';
import { spaceName } from '@/components/spaces/spaceUtils';
import { useNodeActions } from '@/features/drive/actions';
import { favoritesQuery, recentQuery } from '@/features/drive/api';
import { NodeSelectionBar } from '@/features/drive/NodeSelectionBar';
import { NodeIconBox, when } from '@/features/drive/NodeViews';
import { formatTime } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useSelection, useSelectionKeys, type Selection } from '@/lib/selection';
import { useSpaces } from '@/lib/useSpaces';
import { useSetPageFavorite } from '@/lib/wiki/favorite';
import { WikiSidebar } from './WikiSidebar';

/**
 * Pages › "Son açılanlar" and "Favoriler": the pages of Drive's recent and favorites lists
 * (the same nodes, so a star given in Drive shows here too), across spaces.
 */

const DAY = 86_400_000;
const BUCKETS = ['today', 'yesterday', 'week', 'older'] as const;
type Bucket = (typeof BUCKETS)[number];

function bucket(iso: string, now = new Date()): Bucket {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const at = new Date(iso).getTime();
  if (at >= start.getTime()) return 'today';
  if (at >= start.getTime() - DAY) return 'yesterday';
  if (at >= start.getTime() - 6 * DAY) return 'week';
  return 'older';
}

function PageRow({
  node,
  time,
  selection,
}: {
  node: DriveNode;
  time?: string;
  selection: Selection;
}) {
  const { t } = useI18n();
  const { items: spaces } = useSpaces();
  const setFavorite = useSetPageFavorite();
  const space = spaces.find((s) => s.id === node.spaceId);
  const label = t(node.favorite ? 'wiki.menu.unfavorite' : 'wiki.menu.favorite');
  return (
    <li
      className={cn(
        'group/row flex h-12 items-center gap-3 border-b border-line px-3',
        selection.has(node.id) ? 'bg-capsule' : 'hover:bg-bg2',
      )}
    >
      <Checkbox
        checked={selection.has(node.id)}
        aria-label={t('drive.list.select', { name: node.name })}
        onCheckedChange={() => selection.toggle(node.id)}
        className={cn(
          selection.count === 0 &&
            'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100',
        )}
      />
      <Link
        to="/p/$pageRef"
        params={{ pageRef: pagePath(node).slice(3) }}
        className="flex min-w-0 flex-1 items-center gap-3 outline-none focus-visible:underline"
      >
        <NodeIconBox node={node} />
        <span className="truncate text-sm font-semibold">{node.name}</span>
      </Link>
      <span className="flex w-[200px] shrink-0 items-center gap-1.5 truncate text-cap text-fg2 max-sm:hidden">
        {space ? <SpaceDot color={space.color} /> : null}
        {space ? spaceName(space, t) : ''}
      </span>
      {time !== undefined ? (
        <span className="w-[90px] shrink-0 text-right text-cap text-fg2 tn">{time}</span>
      ) : null}
      <IconButton
        size="xs"
        tone="plain"
        aria-label={label}
        aria-pressed={node.favorite}
        onClick={() => void setFavorite(node, !node.favorite)}
        className={cn(
          node.favorite
            ? 'text-accent-text'
            : 'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100',
        )}
      >
        <Icon name="star" size={15} fill={node.favorite ? 'currentColor' : 'none'} />
      </IconButton>
    </li>
  );
}

export function PagesListView({ mode }: { mode: 'recent' | 'favorites' }) {
  const { t, locale } = useI18n();
  const { preferred } = useSpaces();
  const recent = useQuery({ ...recentQuery, enabled: mode === 'recent' });
  const favorites = useQuery({ ...favoritesQuery, enabled: mode === 'favorites' });
  const q = mode === 'recent' ? recent : favorites;
  const items: (DriveNode & { lastOpenedAt?: string })[] = q.data?.items ?? [];
  const pages = items.filter((n) => n.type === 'page' && !n.deletedAt);
  const title = t(mode === 'recent' ? 'wiki.nav.recent' : 'wiki.nav.favorites');
  const actions = useNodeActions();
  const selection = useSelection(pages.map((n) => n.id));
  useSelectionKeys(selection);
  const openedAt = (n: (typeof pages)[number]) => n.lastOpenedAt ?? n.updatedAt;

  const groups = new Map<Bucket, typeof pages>();
  if (mode === 'recent') {
    for (const n of pages) {
      const b = bucket(openedAt(n));
      groups.set(b, [...(groups.get(b) ?? []), n]);
    }
  }

  return (
    <Workspace
      sidebar={<WikiSidebar space={preferred()} />}
      crumbs={[{ label: t('wiki.nav.pages') }, { label: title }]}
      searchLabel={t('wiki.search.placeholder')}
    >
      <h1 className="m-0 text-wtitle font-bold">{title}</h1>
      {pages.length ? (
        <span className="flex items-center gap-3 px-3 text-xs text-fg2">
          <SelectAllCheckbox
            state={selection.state}
            onChange={selection.setAll}
            label={t('ui.selectAll')}
          />
          {t('ui.selectAll')}
        </span>
      ) : null}
      {q.isPending ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : pages.length === 0 ? (
        <EmptyState
          icon={mode === 'recent' ? 'clock' : 'star'}
          title={t(mode === 'recent' ? 'wiki.lists.recentEmpty' : 'wiki.lists.favoritesEmpty')}
          description={t(
            mode === 'recent' ? 'wiki.lists.recentEmptyBody' : 'wiki.lists.favoritesEmptyBody',
          )}
        />
      ) : mode === 'favorites' ? (
        <ul aria-label={title} className="m-0 list-none p-0">
          {pages.map((n) => (
            <PageRow key={n.id} node={n} selection={selection} />
          ))}
        </ul>
      ) : (
        BUCKETS.map((b) =>
          groups.get(b)?.length ? (
            <section key={b} aria-label={t(`drive.recent.groups.${b}`)} className="flex flex-col">
              <span className="eyebrow px-3 pt-2 pb-1.5">{t(`drive.recent.groups.${b}`)}</span>
              <ul className="m-0 list-none p-0">
                {groups.get(b)!.map((n) => {
                  const opened = openedAt(n);
                  return (
                    <PageRow
                      key={n.id}
                      node={n}
                      selection={selection}
                      time={
                        b === 'today' || b === 'yesterday'
                          ? formatTime(opened, locale)
                          : when(opened, locale)
                      }
                    />
                  );
                })}
              </ul>
            </section>
          ) : null,
        )
      )}
      <NodeSelectionBar
        nodes={pages.filter((n) => selection.has(n.id))}
        actions={actions}
        onClear={selection.clear}
      />
    </Workspace>
  );
}
