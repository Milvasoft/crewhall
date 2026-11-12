import { type DriveNode } from '@crewhall/shared';
import {
  Avatar,
  Checkbox,
  cn,
  EmptyState,
  Icon,
  IconButton,
  SelectAllCheckbox,
  Skeleton,
  SpaceDot,
} from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ActionContextMenu } from '@/components/common/ActionMenu';
import { Workspace } from '@/components/shell/Workspace';
import { spaceName } from '@/components/spaces/spaceUtils';
import { api } from '@/lib/api';
import { formatTime } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { isPlainClick } from '@/lib/newTab';
import { useSelection, useSelectionKeys } from '@/lib/selection';
import { useNodeTypeEnabled } from '@/lib/identity/modules';
import { useSpaces } from '@/lib/useSpaces';
import { useNodeActions } from '@/features/drive/actions';
import { favoritesQuery, invalidateDrive, recentQuery } from '@/features/drive/api';
import { DriveSidebar } from '@/features/drive/DriveSidebar';
import { NodeSelectionBar } from '@/features/drive/NodeSelectionBar';
import { useNodeMenu } from '@/features/drive/nodeMenu';
import { NodeIconBox, when } from '@/features/drive/NodeViews';

const DAY = 86_400_000;

function bucket(iso: string): 'today' | 'yesterday' | 'week' | 'older' {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const t = new Date(iso).getTime();
  if (t >= start.getTime()) return 'today';
  if (t >= start.getTime() - DAY) return 'yesterday';
  if (t >= start.getTime() - 6 * DAY) return 'week';
  return 'older';
}

/**
 * Son açılanlar ve favoriler (3.17): personal and across spaces, mixed with space colors.
 * Favorites sit on top as tiles and are sorted by dragging.
 */
export function RecentPage() {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const { items: spaces, preferred } = useSpaces();
  const recent = useQuery(recentQuery);
  const favorites = useQuery(favoritesQuery);
  // Pages, boards and drawings leave the lists while their module is off.
  const typeOn = useNodeTypeEnabled();
  const favItems = favorites.data?.items.filter((n) => typeOn(n.type));
  const recentItems = recent.data?.items.filter((n) => typeOn(n.type));
  const actions = useNodeActions();
  const menu = useNodeMenu(actions);
  const [dragId, setDragId] = useState<string | null>(null);
  const selection = useSelection((recentItems ?? []).map((n) => n.id));
  useSelectionKeys(selection);
  const chosen = (recentItems ?? []).filter((n) => selection.has(n.id));
  const space = preferred();
  const spaceOf = (n: DriveNode) => spaces.find((s) => s.id === n.spaceId);

  useEffect(() => {
    if (window.location.hash === '#favoriler') {
      document.getElementById('favoriler')?.scrollIntoView();
    }
  }, []);

  const dropAfter = (target: DriveNode | null) => {
    if (!dragId || dragId === target?.id) return;
    void api
      .call('setFavorite', {
        params: { nodeId: dragId },
        body: { favorite: true, afterId: target?.id ?? null },
      })
      .then(() => invalidateDrive(qc));
    setDragId(null);
  };

  const groups = new Map<string, NonNullable<typeof recent.data>['items']>();
  for (const n of recentItems ?? []) {
    const b = bucket(n.lastOpenedAt);
    groups.set(b, [...(groups.get(b) ?? []), n]);
  }

  return (
    <Workspace
      sidebar={space ? <DriveSidebar space={space} activeFolderId={undefined} /> : undefined}
      crumbs={[{ label: t('drive.recent.title') }]}
      searchLabel={t('drive.recent.searchAll')}
    >
      <h1 className="m-0 text-wtitle font-bold">{t('drive.recent.title')}</h1>

      <section
        id="favoriler"
        aria-label={t('drive.nav.favorites')}
        className="flex flex-col gap-2.5"
      >
        <span className="eyebrow">
          {t('drive.recent.favorites', { count: favItems?.length ?? 0 })}
        </span>
        {favorites.isLoading ? (
          <Skeleton className="h-16 w-full rounded-xl" />
        ) : favItems?.length ? (
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2.5 p-0">
            {favItems.map((n, i, arr) => {
              const sp = spaceOf(n);
              return (
                <ActionContextMenu key={n.id} entries={menu([n])}>
                  <li
                    draggable
                    onDragStart={() => setDragId(n.id)}
                    onDragOver={(e) => dragId && e.preventDefault()}
                    onDrop={() => dropAfter(i === 0 && dragId !== arr[0]?.id ? null : n)}
                    className={cn(
                      'flex items-center gap-3 rounded-xl bg-surface px-3 py-2.5 shadow-line',
                      dragId === n.id && 'opacity-50',
                    )}
                  >
                    <NodeIconBox node={n} />
                    <a
                      href={actions.href(n)}
                      draggable={false}
                      onClick={(e) => {
                        if (!isPlainClick(e)) return;
                        e.preventDefault();
                        actions.open(n);
                      }}
                      className="flex min-w-0 flex-1 flex-col text-left no-underline"
                    >
                      <span className="truncate text-cap font-semibold">{n.name}</span>
                      <span className="flex items-center gap-1.5 truncate text-xs text-fg2">
                        {sp ? <SpaceDot color={sp.color} /> : null}
                        {sp ? spaceName(sp, t) : ''}
                      </span>
                    </a>
                    <IconButton
                      size="xs"
                      tone="plain"
                      aria-label={t('drive.menu.unfavorite')}
                      onClick={() => actions.favorite(n, false)}
                      className="text-accent-text"
                    >
                      <Icon name="star" size={15} fill="currentColor" />
                    </IconButton>
                  </li>
                </ActionContextMenu>
              );
            })}
          </ul>
        ) : (
          <p className="m-0 text-sm text-fg2">{t('drive.recent.noFavorites')}</p>
        )}
      </section>

      <section aria-label={t('drive.nav.recent')} className="flex flex-col gap-2">
        {recent.isLoading ? (
          <Skeleton className="h-40 w-full rounded-xl" />
        ) : !recentItems?.length ? (
          <EmptyState
            icon="clock"
            title={t('drive.recent.empty')}
            description={t('drive.recent.emptyBody')}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-separate border-spacing-0">
              <thead>
                <tr className="text-left text-xs font-semibold text-fg2 [&>th]:h-9 [&>th]:px-3">
                  <th className="w-9 !pr-0 !pl-2">
                    <SelectAllCheckbox
                      state={selection.state}
                      onChange={selection.setAll}
                      label={t('ui.selectAll')}
                    />
                  </th>
                  <th>{t('drive.list.name')}</th>
                  <th className="w-[200px]">{t('drive.recent.location')}</th>
                  <th className="w-[110px]">{t('drive.recent.opened')}</th>
                  <th className="w-[170px]">{t('drive.recent.lastEdit')}</th>
                  <th className="w-12" />
                </tr>
              </thead>
              {(['today', 'yesterday', 'week', 'older'] as const).map((b) =>
                groups.get(b)?.length ? (
                  <tbody key={b}>
                    <tr>
                      <td colSpan={6} className="px-3 pt-4 pb-1.5">
                        <span className="eyebrow">{t(`drive.recent.groups.${b}`)}</span>
                      </td>
                    </tr>
                    {groups.get(b)!.map((n) => {
                      const sp = spaceOf(n);
                      return (
                        <ActionContextMenu
                          key={n.id}
                          entries={menu(selection.has(n.id) ? chosen : [n])}
                        >
                          <tr
                            tabIndex={0}
                            onDoubleClick={() => actions.open(n)}
                            onKeyDown={(e) => e.key === 'Enter' && actions.open(n)}
                            aria-selected={selection.has(n.id)}
                            className={cn(
                              'group/row h-12 cursor-default outline-none [&>td]:border-b [&>td]:border-line [&>td]:px-3',
                              selection.has(n.id)
                                ? '[&>td]:bg-capsule'
                                : 'hover:[&>td]:bg-bg2 focus-visible:[&>td]:bg-bg2',
                            )}
                          >
                            <td className="!pr-0 !pl-2">
                              <Checkbox
                                checked={selection.has(n.id)}
                                aria-label={t('drive.list.select', { name: n.name })}
                                onClick={(e) => e.stopPropagation()}
                                onCheckedChange={() => selection.toggle(n.id)}
                                className={cn(
                                  selection.count === 0 &&
                                    'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100',
                                )}
                              />
                            </td>
                            <td>
                              <a
                                href={actions.href(n)}
                                onClick={(e) => {
                                  if (!isPlainClick(e)) return;
                                  e.preventDefault();
                                  actions.open(n);
                                }}
                                className="flex min-w-0 items-center gap-3 text-left no-underline"
                              >
                                <NodeIconBox node={n} />
                                <span className="truncate text-sm font-semibold">{n.name}</span>
                              </a>
                            </td>
                            <td>
                              <span className="flex items-center gap-1.5 truncate text-cap text-fg2">
                                {sp ? <SpaceDot color={sp.color} /> : null}
                                {sp ? spaceName(sp, t) : ''}
                              </span>
                            </td>
                            <td className="text-cap text-fg2 tn">
                              {b === 'today' || b === 'yesterday'
                                ? formatTime(n.lastOpenedAt, locale)
                                : when(n.lastOpenedAt, locale)}
                            </td>
                            <td>
                              {n.updatedBy ? (
                                <span className="flex items-center gap-2 text-cap text-fg2">
                                  <Avatar name={n.updatedBy.name} size="sm" />
                                  {n.updatedBy.name.split(' ')[0]} · {when(n.updatedAt, locale)}
                                </span>
                              ) : null}
                            </td>
                            <td>
                              <IconButton
                                size="xs"
                                tone="plain"
                                aria-label={
                                  n.favorite ? t('drive.menu.unfavorite') : t('drive.menu.favorite')
                                }
                                aria-pressed={n.favorite}
                                onClick={() => actions.favorite(n)}
                                className={cn(
                                  n.favorite
                                    ? 'text-accent-text'
                                    : 'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100',
                                )}
                              >
                                <Icon
                                  name="star"
                                  size={15}
                                  fill={n.favorite ? 'currentColor' : 'none'}
                                />
                              </IconButton>
                            </td>
                          </tr>
                        </ActionContextMenu>
                      );
                    })}
                  </tbody>
                ) : null,
              )}
            </table>
          </div>
        )}
      </section>
      <NodeSelectionBar nodes={chosen} actions={actions} onClear={selection.clear} />
    </Workspace>
  );
}
