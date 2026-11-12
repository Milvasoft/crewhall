import { type UiPrefs, type UpdateUiPrefs } from '@crewhall/shared';
import { toast } from '@crewhall/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { uiPrefsKey } from './navOrder';

/** Saves part of the left menu's choices at once, optimistically. */
export function useRailPrefs() {
  const { t } = useI18n();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateUiPrefs) => api.call('updateUiPrefs', { body }),
    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: uiPrefsKey });
      const before = qc.getQueryData<UiPrefs>(uiPrefsKey);
      qc.setQueryData<UiPrefs>(uiPrefsKey, { navOrder: [], ...before, ...body });
      return { before };
    },
    onError: (e, _v, ctx) => {
      qc.setQueryData(uiPrefsKey, ctx?.before);
      toast.error(t(errorKey(e)));
    },
    onSuccess: (prefs) => qc.setQueryData(uiPrefsKey, prefs),
  });
}
