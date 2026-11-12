import { paths, type BoardCard, type BoardDetail } from '@crewhall/shared';
import { Button, Checkbox, cn, Icon, SelectAllCheckbox } from '@crewhall/ui';
import { useMemo, useState } from 'react';
import { ActionContextMenu } from '@/components/common/ActionMenu';
import { type BoardActions } from '@/lib/boards/actions';
import { cardRef } from '@/lib/boards/filters';
import { useI18n } from '@/lib/i18n/I18nContext';
import { middleClickOpens } from '@/lib/newTab';
import { useSelection, useSelectionKeys } from '@/lib/selection';
import { useBulkCardMenu, type CardMenu } from './cardMenu';
import { MultiPicker, labelOptions, peopleOptions, type PickOption } from './pickers';
import { AvatarStack, DueChip, Labels, WipCount } from './parts';

type SortKey = 'number' | 'title' | 'due' | 'checklist' | 'comments';
type GroupBy = 'column' | 'person' | 'label';

interface Group {
  id: string;
  name: string;
  cards: BoardCard[];
  wip?: { count: number; limit: number | null };
  closedByDefault: boolean;
}

/**
 * List view (design 6.5): the same cards as a table grouped by column (default), person or
 * label. Clicking a header sorts; multi-select moves, assigns, labels or archives at once.
 * "Bitti" and "Fikir"-like first and done groups start closed.
 */
export function ListView({
  detail,
  visible,
  groupBy,
  meId,
  canEdit,
  actions,
  onOpen,
  cardMenu,
}: {
  detail: BoardDetail;
  visible: BoardCard[];
  groupBy: GroupBy;
  meId: string;
  canEdit: boolean;
  actions: BoardActions;
  onOpen: (card: BoardCard) => void;
  /** Right-click menu of one card; a row inside a multi-selection gets the bulk menu. */
  cardMenu?: CardMenu;
}) {
  const { t, locale } = useI18n();
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'due', dir: 1 });
  const selection = useSelection(visible.map((c) => c.id));
  useSelectionKeys(selection, canEdit);
  const selected = selection.selected;
  const [closed, setClosed] = useState<Set<string> | null>(null);
  const { settings } = detail.board;

  const groups = useMemo<Group[]>(() => {
    const cmp = (a: BoardCard, b: BoardCard) => {
      const v = (c: BoardCard) =>
        sort.key === 'number'
          ? c.number
          : sort.key === 'title'
            ? c.title.toLocaleLowerCase(locale)
            : sort.key === 'due'
              ? (c.dueAt ?? '9999')
              : sort.key === 'checklist'
                ? c.checklist.total
                  ? c.checklist.done / c.checklist.total
                  : -1
                : c.commentCount;
      const x = v(a);
      const y = v(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    };
    if (groupBy === 'person') {
      const map = new Map<string, Group>();
      const none: Group = {
        id: 'none',
        name: t('boards.list.noAssignee'),
        cards: [],
        closedByDefault: false,
      };
      for (const c of visible) {
        if (!c.assignees.length) none.cards.push(c);
        for (const p of c.assignees) {
          if (!map.has(p.id)) {
            map.set(p.id, { id: p.id, name: p.name, cards: [], closedByDefault: false });
          }
          map.get(p.id)!.cards.push(c);
        }
      }
      return [...map.values(), none]
        .filter((g) => g.cards.length)
        .map((g) => ({ ...g, cards: g.cards.sort(cmp) }));
    }
    if (groupBy === 'label') {
      const none: Group = {
        id: 'none',
        name: t('boards.list.noLabel'),
        cards: [],
        closedByDefault: false,
      };
      const out = settings.labels.map<Group>((l) => ({
        id: l.id,
        name: l.name,
        cards: visible.filter((c) => c.labels.includes(l.id)).sort(cmp),
        closedByDefault: false,
      }));
      none.cards = visible.filter((c) => !c.labels.length).sort(cmp);
      return [...out, none].filter((g) => g.cards.length);
    }
    return detail.columns.map((col, i) => ({
      id: col.id,
      name: col.name,
      cards: visible.filter((c) => c.columnId === col.id).sort(cmp),
      wip: { count: detail.cards.filter((c) => c.columnId === col.id).length, limit: col.wipLimit },
      closedByDefault: col.isDone || (i === 0 && detail.columns.length > 3),
    }));
  }, [groupBy, visible, sort, detail, settings.labels, locale, t]);

  const isClosed = (g: Group) => (closed ? closed.has(g.id) : g.closedByDefault);
  const toggleGroup = (g: Group) =>
    setClosed((s) => {
      const n = new Set(s ?? groups.filter((x) => x.closedByDefault).map((x) => x.id));
      if (n.has(g.id)) n.delete(g.id);
      else n.add(g.id);
      return n;
    });
  const ids = [...selected];
  const bulk = async (body: Omit<Parameters<BoardActions['bulk']>[0], 'cardIds'>) => {
    await actions.bulk({ cardIds: ids, ...body });
    selection.clear();
  };
  const bulkMenu = useBulkCardMenu({ detail, meId, run: (body) => void bulk(body) });
  const menuOf = (c: BoardCard) =>
    canEdit && selected.has(c.id) && selected.size > 1 ? bulkMenu(selected.size) : cardMenu?.(c);

  const head = (key: SortKey | null, label: string, className?: string) => (
    <th
      className={cn(
        'h-9 px-2 text-left text-[11.5px] font-bold tracking-wide text-fg3 uppercase',
        className,
      )}
    >
      {key ? (
        <button
          type="button"
          onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 }))}
          className="inline-flex items-center gap-1 hover:text-fg"
        >
          {label}
          {sort.key === key ? <Icon name={sort.dir === 1 ? 'chevU' : 'chevD'} size={12} /> : null}
        </button>
      ) : (
        label
      )}
    </th>
  );

  const columnOpts: PickOption[] = detail.columns.map((c) => ({
    id: c.id,
    search: c.name,
    node: c.name,
  }));

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-auto">
      <table className="w-full min-w-[860px] border-separate border-spacing-0">
        <thead className="sticky top-0 z-10 bg-bg">
          <tr>
            <th className="w-9 px-2 text-left">
              {canEdit && visible.length ? (
                <SelectAllCheckbox
                  state={selection.state}
                  onChange={selection.setAll}
                  label={t('ui.selectAll')}
                />
              ) : null}
            </th>
            {head('number', t('boards.list.id'), 'w-[92px]')}
            {head('title', t('boards.list.title'))}
            {head(null, t('boards.list.labels'), 'w-[180px]')}
            {head(null, t('boards.list.assignees'), 'w-[110px]')}
            {head('due', t('boards.list.due'), 'w-[150px]')}
            {head('checklist', t('boards.list.checklist'), 'w-[90px]')}
            {head('comments', t('boards.list.comments'), 'w-[70px]')}
          </tr>
        </thead>
        {groups.map((g) => (
          <tbody key={g.id}>
            <tr>
              <td colSpan={8} className="pt-4 pb-1">
                <button
                  type="button"
                  onClick={() => toggleGroup(g)}
                  aria-expanded={!isClosed(g)}
                  className="flex items-center gap-1.5 px-1 text-[13.5px] font-bold text-fg"
                >
                  <Icon name={isClosed(g) ? 'chevR' : 'chevD'} size={14} className="text-fg3" />
                  {g.name}
                  {g.wip && g.wip.limit !== null ? (
                    <WipCount count={g.wip.count} limit={g.wip.limit} />
                  ) : (
                    <span className="text-xs font-bold text-fg3 tn">{g.cards.length}</span>
                  )}
                </button>
              </td>
            </tr>
            {isClosed(g)
              ? null
              : g.cards.map((c) => {
                  const key = cardRef(settings.key, c.number);
                  const done = detail.columns.find((x) => x.id === c.columnId)?.isDone;
                  const entries = menuOf(c);
                  const row = (
                    <tr
                      key={`${g.id}-${c.id}`}
                      className={cn(
                        'group cursor-pointer hover:bg-bg2/60',
                        selected.has(c.id) && 'bg-accent10',
                      )}
                      onClick={() => onOpen(c)}
                      {...middleClickOpens(paths.boardCard(detail.board.id, key))}
                    >
                      <td
                        className="border-t border-line px-2"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {canEdit ? (
                          <Checkbox
                            checked={selected.has(c.id)}
                            onCheckedChange={() => selection.toggle(c.id)}
                            aria-label={t('boards.list.selectCard', { key })}
                          />
                        ) : null}
                      </td>
                      <td className="h-11 border-t border-line px-2 font-mono text-[12px] text-fg3">
                        {key}
                      </td>
                      <td className="border-t border-line px-2 text-[13.5px] font-semibold text-fg">
                        {c.title}
                      </td>
                      <td className="border-t border-line px-2">
                        <Labels ids={c.labels} labels={settings.labels} />
                      </td>
                      <td className="border-t border-line px-2">
                        <AvatarStack people={c.assignees} />
                      </td>
                      <td className="border-t border-line px-2">
                        {c.dueAt ? (
                          <DueChip dueAt={c.dueAt} done={done} />
                        ) : (
                          <span className="text-fg3">—</span>
                        )}
                        {c.dueAt && !done && Date.parse(c.dueAt) < Date.now() ? (
                          <span className="ml-1.5 text-[11px] text-danger">
                            {t('boards.card.overdue', {
                              days: Math.ceil((Date.now() - Date.parse(c.dueAt)) / 86_400_000),
                            })}
                          </span>
                        ) : null}
                      </td>
                      <td className="border-t border-line px-2 text-[12.5px] text-fg2 tn">
                        {c.checklist.total ? `${c.checklist.done}/${c.checklist.total}` : '—'}
                      </td>
                      <td className="border-t border-line px-2 text-[12.5px] text-fg2 tn">
                        {c.commentCount}
                      </td>
                    </tr>
                  );
                  return entries ? (
                    <ActionContextMenu key={`${g.id}-${c.id}`} entries={entries}>
                      {row}
                    </ActionContextMenu>
                  ) : (
                    row
                  );
                })}
          </tbody>
        ))}
      </table>
      {visible.length === 0 ? (
        <p className="py-10 text-center text-sm text-fg3">{t('boards.filters.noMatch')}</p>
      ) : null}
      {ids.length ? (
        <div className="sticky bottom-3 mx-auto mt-4 flex items-center gap-2 rounded-full bg-fg py-1.5 pr-1.5 pl-4 text-bg shadow-overlay">
          <span className="text-[13px] font-semibold">
            {t('boards.list.selected', { count: ids.length })}
          </span>
          <MultiPicker
            single
            trigger={
              <Button size="xs" variant="gh" className="text-bg enabled:hover:bg-white/10">
                {t('boards.list.move')}
              </Button>
            }
            options={columnOpts}
            value={[]}
            onChange={(v) => v[0] && void bulk({ columnId: v[0] })}
          />
          <MultiPicker
            single
            trigger={
              <Button size="xs" variant="gh" className="text-bg enabled:hover:bg-white/10">
                {t('boards.list.assign')}
              </Button>
            }
            options={peopleOptions(detail.people, meId)}
            value={[]}
            onChange={(v) => v[0] && void bulk({ addAssigneeIds: [v[0]] })}
          />
          <MultiPicker
            single
            trigger={
              <Button size="xs" variant="gh" className="text-bg enabled:hover:bg-white/10">
                {t('boards.list.label')}
              </Button>
            }
            options={labelOptions(settings.labels)}
            value={[]}
            onChange={(v) => v[0] && void bulk({ addLabels: [v[0]] })}
          />
          <Button
            size="xs"
            variant="gh"
            className="text-bg enabled:hover:bg-white/10"
            onClick={() => void bulk({ archive: true })}
          >
            {t('boards.list.archive')}
          </Button>
          <button
            type="button"
            aria-label={t('boards.list.clearSelection')}
            onClick={() => selection.clear()}
            className="flex size-7 items-center justify-center rounded-full hover:bg-white/10"
          >
            <Icon name="x" size={15} />
          </button>
        </div>
      ) : null}
    </div>
  );
}
