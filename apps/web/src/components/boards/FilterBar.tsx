import { type BoardDetail } from '@crewhall/shared';
import { Chip, Icon } from '@crewhall/ui';
import { DUE_FILTERS, hasFilters, ME, NOBODY, type BoardSearch } from '@/lib/boards/filters';
import { useI18n } from '@/lib/i18n/I18nContext';
import { MultiPicker, labelOptions, peopleOptions, type PickOption } from './pickers';

/**
 * Filter bar (design 6.4): filters are written to the address and stay personal. An
 * active filter is a filled chip; "Temizle" removes them all.
 */
export function FilterBar({
  detail,
  search,
  meId,
  shown,
  onChange,
}: {
  detail: BoardDetail;
  search: BoardSearch;
  meId: string;
  shown: number;
  onChange: (next: BoardSearch) => void;
}) {
  const { t } = useI18n();
  const total = detail.cards.length;
  const people = detail.people;
  const kisi = search.person ?? [];
  const etiket = search.tag ?? [];
  const mineOnly = kisi.length === 1 && kisi[0] === ME;

  const personCounts = new Map<string, number>();
  let unassigned = 0;
  for (const c of detail.cards) {
    if (!c.assignees.length) unassigned++;
    for (const a of c.assignees) personCounts.set(a.id, (personCounts.get(a.id) ?? 0) + 1);
  }
  const labelCounts = new Map<string, number>();
  for (const c of detail.cards) {
    for (const l of c.labels) labelCounts.set(l, (labelCounts.get(l) ?? 0) + 1);
  }

  // "Ben" is the signed-in person; selecting them stores the portable `ben`.
  const personOpts: PickOption[] = [
    ...peopleOptions(people, meId, personCounts).map((o) => (o.id === meId ? { ...o, id: ME } : o)),
    {
      id: NOBODY,
      search: t('boards.filters.unassigned'),
      node: t('boards.filters.unassigned'),
      count: unassigned,
    },
  ];
  const personNames = kisi
    .map((k) =>
      k === ME
        ? (people.find((p) => p.id === meId)?.name.split(' ')[0] ?? '')
        : k === NOBODY
          ? t('boards.filters.unassigned')
          : (people.find((p) => p.id === k)?.name.split(' ')[0] ?? ''),
    )
    .filter(Boolean)
    .join(', ');
  const labelNames = etiket
    .map((id) => detail.board.settings.labels.find((l) => l.id === id)?.name)
    .filter(Boolean)
    .join(', ');
  const dueOpts: PickOption[] = DUE_FILTERS.map((k) => ({
    id: k,
    search: t(`boards.filters.dueOptions.${k}`),
    node: t(`boards.filters.dueOptions.${k}`),
  }));

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Chip
        size="sm"
        on={mineOnly}
        onClick={() => onChange({ ...search, person: mineOnly ? undefined : [ME] })}
      >
        <Icon name="user" size={14} />
        {t('boards.filters.mine')}
      </Chip>
      <MultiPicker
        trigger={
          <Chip size="sm" on={kisi.length > 0 && !mineOnly}>
            {kisi.length && !mineOnly
              ? t('boards.filters.personOn', { names: personNames })
              : t('boards.filters.person')}
            <Icon name="chevD" size={13} />
          </Chip>
        }
        placeholder={t('boards.filters.searchPeople')}
        options={personOpts}
        value={kisi}
        onChange={(v) => onChange({ ...search, person: v.length ? v : undefined })}
      />
      <MultiPicker
        trigger={
          <Chip size="sm" on={etiket.length > 0}>
            {etiket.length
              ? t('boards.filters.labelOn', { names: labelNames })
              : t('boards.filters.label')}
            <Icon name="chevD" size={13} />
          </Chip>
        }
        options={labelOptions(detail.board.settings.labels, labelCounts)}
        value={etiket}
        onChange={(v) => onChange({ ...search, tag: v.length ? v : undefined })}
      />
      <MultiPicker
        single
        trigger={
          <Chip size="sm" on={Boolean(search.date)}>
            {search.date
              ? t('boards.filters.dueOn', {
                  name: t(`boards.filters.dueOptions.${search.date}`),
                })
              : t('boards.filters.due')}
            <Icon name="chevD" size={13} />
          </Chip>
        }
        options={dueOpts}
        value={search.date ? [search.date] : []}
        onChange={(v) => onChange({ ...search, date: (v[0] as BoardSearch['date']) ?? undefined })}
      />
      <span className="ml-1 text-xs text-fg3 tn">
        {hasFilters(search)
          ? t('boards.toolbar.filtered', { shown, total })
          : t('boards.toolbar.summary', { count: total, archived: detail.archivedCount })}
      </span>
      {hasFilters(search) ? (
        <button
          type="button"
          onClick={() => onChange({ view: search.view, group: search.group } as BoardSearch)}
          className="text-xs font-semibold text-fg2 underline-offset-2 hover:text-fg hover:underline"
        >
          {t('boards.filters.clear')}
        </button>
      ) : null}
    </div>
  );
}
