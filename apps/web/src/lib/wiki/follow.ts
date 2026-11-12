import type { Page } from '@crewhall/shared';
import { toast } from '@crewhall/ui';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { wikiKeys } from './api';

type FollowState = Pick<Page, 'following' | 'followingDescendants'>;

/**
 * Follows a page, alone or with its sub-pages (`descendants`; omitted keeps the current choice):
 * the button answers at once and goes back if the server refuses.
 */
export function useSetPageFollow() {
  const { t } = useI18n();
  const qc = useQueryClient();
  return async (page: { id: string } & FollowState, following: boolean, descendants?: boolean) => {
    const before: FollowState = {
      following: page.following,
      followingDescendants: page.followingDescendants,
    };
    const after: FollowState = {
      following,
      followingDescendants: following ? (descendants ?? Boolean(page.followingDescendants)) : false,
    };
    const setLocal = (state: FollowState) =>
      qc.setQueryData<Page>(wikiKeys.page(page.id), (p) => (p ? { ...p, ...state } : p));
    setLocal(after);
    try {
      await api.call('setPageFollow', {
        params: { nodeId: page.id },
        body: descendants === undefined ? { following } : { following, descendants },
      });
    } catch (e) {
      setLocal(before);
      toast(t(errorKey(e)));
    }
  };
}
