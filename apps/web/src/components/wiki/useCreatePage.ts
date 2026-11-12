import { pagePath } from '@crewhall/shared';
import { toast } from '@crewhall/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { invalidateDrive } from '@/features/drive/api';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { wikiKeys } from '@/lib/wiki/api';

/**
 * Creates an untitled page (under a page, a Drive folder or the space root) and opens it with
 * the caret in the title (design 5.14).
 */
export function useCreatePage() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  return async (spaceId: string, parentId: string | null, templateId?: string) => {
    try {
      const page = await api.call('createPage', {
        params: { spaceId },
        body: { parentId, name: t('wiki.untitled'), templateId },
      });
      void qc.invalidateQueries({ queryKey: wikiKeys.tree(spaceId) });
      invalidateDrive(qc);
      void navigate({
        to: '/p/$pageRef',
        params: { pageRef: pagePath(page).slice(3) },
        search: { new: true },
      });
      return page;
    } catch (e) {
      toast(t(errorKey(e)));
      return null;
    }
  };
}
