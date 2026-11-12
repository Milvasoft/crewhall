import type { Page, ResponseOf } from '@crewhall/shared';
import { toast } from '@crewhall/ui';
import { useQueryClient } from '@tanstack/react-query';
import { invalidateDrive } from '@/features/drive/api';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { wikiKeys } from './api';

/**
 * Stars a page (the Drive favorite of its node, so Drive and the pages module share one list).
 * The page header and the tree show it at once; the favorites and recent lists refresh after.
 */
export function useSetPageFavorite() {
  const { t } = useI18n();
  const qc = useQueryClient();
  return async (page: { id: string; spaceId: string }, favorite: boolean) => {
    const setLocal = (on: boolean) => {
      qc.setQueryData<Page>(wikiKeys.page(page.id), (p) => (p ? { ...p, favorite: on } : p));
      qc.setQueryData<ResponseOf<'listPageTree'>>(wikiKeys.tree(page.spaceId), (d) =>
        d
          ? { ...d, items: d.items.map((i) => (i.id === page.id ? { ...i, favorite: on } : i)) }
          : d,
      );
    };
    setLocal(favorite);
    try {
      await api.call('setFavorite', { params: { nodeId: page.id }, body: { favorite } });
    } catch (e) {
      setLocal(!favorite);
      toast(t(errorKey(e)));
    }
    invalidateDrive(qc);
  };
}
