import { toast } from '@crewhall/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { invalidateDrive } from '@/features/drive/api';
import { api, idempotencyKey } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';

/** Creates an untitled drawing (in a Drive folder or the space root) and opens it. */
export function useNewDrawing() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const create = async (spaceId: string, parentId: string | null) => {
    setBusy(true);
    try {
      const d = await api.call('createDrawing', {
        params: { spaceId },
        body: { name: t('boards.drawings.untitled'), parentId },
        idempotencyKey: idempotencyKey(),
      });
      invalidateDrive(qc);
      void qc.invalidateQueries({ queryKey: ['drawings', 'list'] });
      void navigate({ to: '/d/$drawingId', params: { drawingId: d.id }, search: { new: '1' } });
    } catch (e) {
      toast(t(errorKey(e)));
    } finally {
      setBusy(false);
    }
  };
  return { create, busy };
}
