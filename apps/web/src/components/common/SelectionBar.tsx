import { Icon, IconButton, type IconName } from '@crewhall/ui';
import { useState, type ReactNode } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import { type Selection } from '@/lib/selection';

/** Floating bar of the bulk actions while rows are selected. */
export function SelectionBar({
  label,
  count,
  clearLabel,
  onClear,
  children,
}: {
  label: string;
  /** "3 seçildi" */
  count: string;
  clearLabel: string;
  onClear: () => void;
  children: ReactNode;
}) {
  return (
    <div
      role="toolbar"
      aria-label={label}
      className="fixed bottom-6 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-fg py-1.5 pr-1.5 pl-4 text-bg shadow-overlay keyboard:hidden"
    >
      <span className="mr-2 text-cap font-semibold whitespace-nowrap">{count}</span>
      {children}
      <IconButton
        size="xs"
        aria-label={clearLabel}
        onClick={onClear}
        className="bg-transparent text-bg hover:bg-white/10"
      >
        <Icon name="x" size={15} />
      </IconButton>
    </div>
  );
}

export function SelectionButton({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-8 items-center gap-1.5 rounded-full px-3 text-cap font-semibold whitespace-nowrap text-bg hover:bg-white/10 disabled:opacity-50"
    >
      <Icon name={icon} size={15} />
      {label}
    </button>
  );
}

/** What AllPagesNote needs of a `useInfiniteQuery` result. */
interface PagedList<P> {
  hasNextPage: boolean;
  fetchNextPage: () => Promise<{ hasNextPage: boolean; isError: boolean; data?: { pages: P[] } }>;
}

/**
 * Paged lists: once every loaded row is selected, "Bu sayfadakiler seçildi · Tümünü (N) seç"
 * loads the rest and selects it too, so a bulk action only sees rows the list can show. N only
 * when the server tells the total.
 */
export function AllPagesNote<P>({
  selection,
  list,
  idsOf,
  total,
}: {
  selection: Selection;
  list: PagedList<P>;
  idsOf: (pages: P[]) => string[];
  total?: number;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  if (selection.state !== 'all' || !list.hasNextPage) return null;
  const selectEvery = async () => {
    setBusy(true);
    try {
      let res = await list.fetchNextPage();
      while (res.hasNextPage && !res.isError) res = await list.fetchNextPage();
      if (res.data) selection.replace(idsOf(res.data.pages));
    } finally {
      setBusy(false);
    }
  };
  return (
    <p className="m-0 flex flex-wrap items-center justify-center gap-1.5 rounded-lg bg-bg2 px-3 py-2 text-cap text-fg2">
      {t('ui.pageSelected')}
      <span aria-hidden="true">·</span>
      <button
        type="button"
        disabled={busy}
        onClick={() => void selectEvery()}
        className="font-semibold text-fg underline-offset-2 hover:underline disabled:opacity-50"
      >
        {total === undefined ? t('ui.selectEvery') : t('ui.selectEveryCount', { count: total })}
      </button>
    </p>
  );
}
