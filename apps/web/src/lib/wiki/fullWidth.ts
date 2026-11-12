import type { UiPrefs } from '@crewhall/shared';
import { toast } from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { uiPrefsKey, uiPrefsQuery } from '@/lib/shell/navOrder';

/**
 * Pages › "Tam genişlik": the person's choice for every page (UiPrefs.pagesFullWidth, kept on
 * the server so it follows them to other devices). Switching it shows at once; the server
 * write follows and a failure puts the old value back.
 */
export function usePagesFullWidth(): [boolean, (next: boolean) => void] {
  const prefs = useQuery(uiPrefsQuery);
  const patch = usePatchUiPrefs();
  return [prefs.data?.pagesFullWidth ?? false, (next) => patch({ pagesFullWidth: next })];
}

/** Writes personal page choices optimistically: shown at once, put back when the save fails. */
function usePatchUiPrefs() {
  const { t } = useI18n();
  const qc = useQueryClient();
  return (body: Pick<UiPrefs, 'pagesFullWidth' | 'pagesHideDone'>) => {
    const before = qc.getQueryData<UiPrefs>(uiPrefsKey);
    qc.setQueryData<UiPrefs>(uiPrefsKey, (old) => ({ navOrder: [], ...old, ...body }));
    api
      .call('updateUiPrefs', { body })
      .then((saved) => qc.setQueryData(uiPrefsKey, saved))
      .catch((e: unknown) => {
        qc.setQueryData(uiPrefsKey, before);
        toast(t(errorKey(e)));
      });
  };
}

const HIDE_DONE_KEPT = 500;

/**
 * "Tamamlananları gizle" on one page: the person's own view, kept across devices. The document
 * and what others see stay as they are.
 */
export function usePageHideDone(pageId: string): [boolean, (next: boolean) => void] {
  const prefs = useQuery(uiPrefsQuery);
  const patch = usePatchUiPrefs();
  const list = prefs.data?.pagesHideDone ?? [];
  const set = (next: boolean) => {
    const rest = list.filter((id) => id !== pageId);
    patch({ pagesHideDone: next ? [pageId, ...rest].slice(0, HIDE_DONE_KEPT) : rest });
  };
  return [list.includes(pageId), set];
}
