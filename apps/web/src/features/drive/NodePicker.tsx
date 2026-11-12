import { CONTAINER_NODE_TYPES, type DriveNode, type Space } from '@crewhall/shared';
import { cn, Icon, Input, Skeleton } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { SpaceAvatar } from '@/components/spaces/SpaceAvatar';
import { spaceName } from '@/components/spaces/spaceUtils';
import { useI18n } from '@/lib/i18n/I18nContext';
import { usePermissions } from '@/lib/session';
import { useSpaces } from '@/lib/useSpaces';
import { nodesQuery, searchQuery } from './api';
import { nodeIcon } from './fileKinds';

export interface PickerPlace {
  spaceId: string;
  /** Folder shown on the right; null = space root. */
  folderId: string | null;
  path: { id: string; name: string }[];
}

const isContainer = (n: DriveNode) => (CONTAINER_NODE_TYPES as readonly string[]).includes(n.type);

/**
 * Spaces on the left, the chosen space's tree on the right (3.13). `folder` mode picks a
 * destination (boards and drawings are dimmed: nothing goes under them); `node` mode picks
 * any node for a quick access card.
 */
export function NodePicker({
  mode,
  place,
  onPlace,
  selectedId,
  onSelect,
  excludeIds,
  writableOnly,
  accept,
}: {
  mode: 'folder' | 'node';
  place: PickerPlace;
  onPlace: (p: PickerPlace) => void;
  selectedId?: string | null;
  onSelect?: (n: DriveNode) => void;
  /** Nodes being moved: they and their subtrees cannot be the target. */
  excludeIds?: Set<string>;
  writableOnly?: boolean;
  /** `node` mode: only these nodes can be picked (e.g. videos); folders still open. */
  accept?: (n: DriveNode) => boolean;
}) {
  const { t } = useI18n();
  const { items } = useSpaces();
  const { canSpace } = usePermissions();
  const [q, setQ] = useState('');
  const spaces = items.filter((s) => !writableOnly || canSpace('space.edit_content', s.myRole));
  const space = spaces.find((s) => s.id === place.spaceId) ?? spaces[0];
  const list = useQuery({
    ...nodesQuery(space?.id ?? '', place.folderId),
    enabled: Boolean(space),
  });
  const search = useQuery({
    ...searchQuery({ q }),
    enabled: mode === 'node' && q.trim().length > 1,
  });

  const enter = (n: DriveNode) =>
    onPlace({ ...place, folderId: n.id, path: [...place.path, { id: n.id, name: n.name }] });

  const rows =
    mode === 'node' && q.trim().length > 1
      ? (search.data?.items.map((h) => h.node) ?? [])
      : (list.data ?? []);

  return (
    <div className="grid h-[360px] grid-cols-[200px_1fr] overflow-hidden rounded-xl shadow-line">
      <ul
        className="m-0 flex list-none flex-col gap-px overflow-y-auto border-r border-line bg-bg p-2"
        aria-label={t('drive.picker.spaces')}
      >
        {spaces.map((s: Space) => (
          <li key={s.id}>
            <button
              type="button"
              aria-current={s.id === space?.id}
              onClick={() => onPlace({ spaceId: s.id, folderId: null, path: [] })}
              className={cn(
                'flex h-9 w-full items-center gap-2 rounded-sm px-2 text-left text-cap font-medium text-fg2 hover:bg-bg2',
                s.id === space?.id && 'bg-capsule font-semibold text-fg',
              )}
            >
              <SpaceAvatar space={s} size="sm" />
              <span className="min-w-0 flex-1 truncate">{spaceName(s, t)}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="flex min-w-0 flex-col">
        <div className="flex shrink-0 flex-col gap-2 border-b border-line px-3 py-2.5">
          <nav
            aria-label={t('drive.picker.path')}
            className="flex min-w-0 flex-wrap items-center gap-1 text-cap font-medium text-fg2"
          >
            <button
              type="button"
              className="hover:text-fg"
              onClick={() => onPlace({ ...place, folderId: null, path: [] })}
            >
              {space ? t('drive.picker.root', { name: spaceName(space, t) }) : ''}
            </button>
            {place.path.map((p, i) => (
              <span key={p.id} className="flex items-center gap-1">
                <Icon name="chevR" size={13} className="text-fg3" />
                <button
                  type="button"
                  className={cn(
                    'hover:text-fg',
                    i === place.path.length - 1 && 'font-semibold text-fg',
                  )}
                  onClick={() =>
                    onPlace({ ...place, folderId: p.id, path: place.path.slice(0, i + 1) })
                  }
                >
                  {p.name}
                </button>
              </span>
            ))}
          </nav>
          {mode === 'node' ? (
            <Input
              containerClassName="h-9 rounded-md"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('drive.picker.search')}
              aria-label={t('drive.picker.search')}
              icon="search"
            />
          ) : null}
        </div>
        <ul
          className="m-0 flex min-h-0 flex-1 list-none flex-col gap-px overflow-y-auto p-1.5"
          role="listbox"
          aria-label={t('drive.picker.items')}
        >
          {list.isLoading ? (
            Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="my-1 h-8 w-full rounded-sm" />
            ))
          ) : rows.length === 0 ? (
            <li className="px-3 py-6 text-center text-cap text-fg3">{t('drive.picker.empty')}</li>
          ) : (
            rows.map((n) => {
              const container = isContainer(n);
              const excluded = excludeIds?.has(n.id) ?? false;
              const refused = mode === 'node' && accept !== undefined && !accept(n);
              const dim = (mode === 'folder' && !container) || excluded || (refused && !container);
              const selectable = mode === 'node' ? !excluded && !refused : container && !excluded;
              return (
                <li
                  key={n.id}
                  role="option"
                  aria-selected={selectedId === n.id}
                  aria-disabled={!selectable}
                >
                  <div
                    className={cn(
                      'flex h-9 items-center gap-2 rounded-sm px-2 text-cap',
                      dim && 'opacity-45',
                      selectedId === n.id ? 'bg-fg text-bg' : selectable && 'hover:bg-bg2',
                    )}
                  >
                    <button
                      type="button"
                      disabled={!selectable}
                      onClick={() => onSelect?.(n)}
                      onDoubleClick={() => container && !excluded && enter(n)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default"
                    >
                      <Icon name={nodeIcon(n)} size={16} className="shrink-0 opacity-70" />
                      <span className="min-w-0 flex-1 truncate font-medium">{n.name}</span>
                    </button>
                    {container && !excluded && n.hasChildren ? (
                      <button
                        type="button"
                        aria-label={t('drive.picker.open', { name: n.name })}
                        onClick={() => enter(n)}
                        className="flex size-6 items-center justify-center rounded-xs opacity-70 hover:opacity-100"
                      >
                        <Icon name="chevR" size={14} />
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })
          )}
        </ul>
      </div>
    </div>
  );
}
