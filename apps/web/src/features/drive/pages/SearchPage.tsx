import { SNIPPET_MARK_END, SNIPPET_MARK_START, type NodeType } from '@crewhall/shared';
import {
  Checkbox,
  Chip,
  cn,
  EmptyState,
  Input,
  SelectAllCheckbox,
  Skeleton,
  SpaceDot,
} from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { ActionContextMenu } from '@/components/common/ActionMenu';
import { Workspace } from '@/components/shell/Workspace';
import { spaceName } from '@/components/spaces/spaceUtils';
import { useI18n } from '@/lib/i18n/I18nContext';
import { isPlainClick } from '@/lib/newTab';
import { useNodeTypeEnabled } from '@/lib/identity/modules';
import { useSelection, useSelectionKeys } from '@/lib/selection';
import { useSpaces } from '@/lib/useSpaces';
import { useNodeActions } from '@/features/drive/actions';
import { searchQuery } from '@/features/drive/api';
import { DriveSidebar } from '@/features/drive/DriveSidebar';
import { NodeSelectionBar } from '@/features/drive/NodeSelectionBar';
import { useNodeMenu } from '@/features/drive/nodeMenu';
import { NodeIconBox, typeLabel, when } from '@/features/drive/NodeViews';

const TYPES: NodeType[] = ['folder', 'file', 'page', 'board', 'drawing'];

/** Underlines where the query matches the name (case and Turkish-letter insensitive). */
export function Highlight({ text, q }: { text: string; q: string }) {
  const i = text.toLocaleLowerCase('tr').indexOf(q.trim().toLocaleLowerCase('tr'));
  if (!q.trim() || i < 0) return <>{text}</>;
  const end = i + q.trim().length;
  return (
    <>
      {text.slice(0, i)}
      <u className="decoration-2 underline-offset-2">{text.slice(i, end)}</u>
      {text.slice(end)}
    </>
  );
}

/** Server excerpt with the matched words marked (markers, never HTML). */
export function ContentSnippet({ text }: { text: string }) {
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
    parts.push(
      <mark key={parts.length} className="rounded-xs bg-accent10 px-0.5 font-semibold text-fg">
        {rest.slice(s + 1, e < 0 ? undefined : e)}
      </mark>,
    );
    if (e < 0) break;
    rest = rest.slice(e + 1);
  }
  return <>{parts}</>;
}

/** Plain text of a server excerpt (Ctrl K rows). */
export const plainSnippet = (text: string) =>
  text.replaceAll(SNIPPET_MARK_START, '').replaceAll(SNIPPET_MARK_END, '');

/**
 * Drive search (3.15): this space or all spaces, filtered by type; filters live in the URL so
 * a search can be shared. Names match first, then the text inside files (roadmap 10), with an
 * excerpt.
 */
export function SearchPage({
  search,
}: {
  search: { q?: string; space?: string; type?: NodeType };
}) {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const { items: spaces, preferred } = useSpaces();
  const actions = useNodeActions();
  const menu = useNodeMenu(actions);
  const [text, setText] = useState(search.q ?? '');
  const here = spaces.find((s) => s.slug === search.space) ?? preferred();
  const results = useQuery(
    searchQuery({
      q: search.q ?? '',
      spaceId: search.space ? here?.id : undefined,
      type: search.type,
      limit: 50,
    }),
  );

  const set = (patch: Partial<typeof search>) =>
    void navigate({ to: '/drive/search', search: { ...search, ...patch }, replace: true });

  useEffect(() => {
    const id = setTimeout(() => {
      if (text !== (search.q ?? '')) set({ q: text || undefined });
    }, 300);
    return () => clearTimeout(id);
  });

  // Pages, boards and drawings leave the results while their module is off.
  const typeOn = useNodeTypeEnabled();
  const hits = (results.data?.items ?? []).filter((h) => typeOn(h.node.type));
  const selection = useSelection(hits.map((h) => h.node.id));
  useSelectionKeys(selection);
  const chosen = hits.filter((h) => selection.has(h.node.id)).map((h) => h.node);
  return (
    <Workspace
      sidebar={here ? <DriveSidebar space={here} activeFolderId={undefined} /> : undefined}
      crumbs={[{ label: t('drive.search.title') }]}
    >
      <Input
        autoFocus
        icon="search"
        size="lg"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t('drive.search.placeholder')}
        aria-label={t('drive.search.placeholder')}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Chip size="sm" on={Boolean(search.space)} onClick={() => set({ space: here?.slug })}>
          {here
            ? t('drive.search.thisSpace', { name: spaceName(here, t) })
            : t('drive.search.thisSpaceShort')}
        </Chip>
        <Chip size="sm" on={!search.space} onClick={() => set({ space: undefined })}>
          {t('drive.search.allSpaces')}
        </Chip>
        <span className="mx-1 h-5 w-px bg-line" />
        <Chip size="sm" on={!search.type} onClick={() => set({ type: undefined })}>
          {t('drive.filters.all')}
        </Chip>
        {TYPES.filter(typeOn).map((ty) => (
          <Chip key={ty} size="sm" on={search.type === ty} onClick={() => set({ type: ty })}>
            {t(`drive.types.${ty}`)}
          </Chip>
        ))}
      </div>
      {!search.q ? (
        <EmptyState
          icon="search"
          title={t('drive.search.start')}
          description={t('drive.search.startBody')}
        />
      ) : results.isLoading ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : hits.length === 0 ? (
        <EmptyState
          icon="search"
          title={t('drive.search.none', { q: search.q })}
          description={t('drive.search.noneBody')}
        />
      ) : (
        <>
          <span className="flex items-center gap-3 pl-3 text-xs text-fg2">
            <SelectAllCheckbox
              state={selection.state}
              onChange={selection.setAll}
              label={t('ui.selectAll')}
            />
            {t('drive.search.count', { count: hits.length })}
          </span>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {hits.map((h) => (
              <ActionContextMenu
                key={h.node.id}
                entries={menu(selection.has(h.node.id) ? chosen : [h.node])}
              >
                <li
                  className={cn(
                    'group/row flex items-center gap-3 rounded-lg pl-3',
                    selection.has(h.node.id) ? 'bg-capsule' : 'hover:bg-bg2',
                  )}
                >
                  <Checkbox
                    checked={selection.has(h.node.id)}
                    aria-label={t('drive.list.select', { name: h.node.name })}
                    onCheckedChange={() => selection.toggle(h.node.id)}
                    className={cn(
                      selection.count === 0 &&
                        'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100',
                    )}
                  />
                  <a
                    href={actions.href(h.node)}
                    onClick={(e) => {
                      if (!isPlainClick(e)) return;
                      e.preventDefault();
                      if (h.node.type === 'file') actions.preview(h.node);
                      else actions.open(h.node);
                    }}
                    className="flex min-w-0 flex-1 items-center gap-3 rounded-lg py-2.5 pr-3 text-left no-underline"
                  >
                    <NodeIconBox node={h.node} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm font-semibold">
                        <Highlight text={h.node.name} q={search.q ?? ''} />
                      </span>
                      <span className="flex items-center gap-1.5 truncate text-xs text-fg2">
                        <SpaceDot color={h.space.color} />
                        {[h.space.name, ...h.path.map((p) => p.name)].map((p, i) => (
                          <Fragment key={i}>
                            {i > 0 ? ' › ' : ''}
                            {p}
                          </Fragment>
                        ))}
                        {' · '}
                        {typeLabel(h.node, t)}
                      </span>
                      {h.matchedIn === 'content' && h.snippet ? (
                        <span className="mt-1 line-clamp-2 text-xs text-fg2">
                          <span className="mr-1.5 font-semibold text-fg">
                            {t('drive.search.inContent')}
                          </span>
                          <ContentSnippet text={h.snippet} />
                        </span>
                      ) : null}
                    </span>
                    <span className="shrink-0 text-xs text-fg3">
                      {h.node.updatedBy?.name.split(' ')[0]} · {when(h.node.updatedAt, locale)}
                    </span>
                  </a>
                </li>
              </ActionContextMenu>
            ))}
          </ul>
        </>
      )}
      <NodeSelectionBar nodes={chosen} actions={actions} onClear={selection.clear} />
    </Workspace>
  );
}
