import { type MailBulkAction } from '@crewhall/shared';
import { toast } from '@crewhall/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { formatNumber } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import {
  applyLocally,
  restore,
  runFolderJob,
  runOnUids,
  snapshot,
  type Target,
} from '@/lib/mail/bulk';
import { mailKeys } from '@/lib/mail/queries';
import { codeText, mailError } from './errors';

let jobSeq = 0;

/**
 * One entry point for every bulk change of the list: optimistic cache update, the requests (a
 * selection in 500-UID calls, a whole folder as a server job with a progress toast), then a
 * refresh, or the rollback and the error when it fails. Resolves true on success.
 */
export function useMailBulk() {
  const { t, locale } = useI18n();
  const qc = useQueryClient();

  return useCallback(
    async (folder: string, action: MailBulkAction, target: Target, moveTo?: string) => {
      const before = snapshot(qc, folder);
      applyLocally(qc, folder, action, target, moveTo);
      const refresh = () => {
        void qc.invalidateQueries({ queryKey: mailKeys.folders });
        void qc.invalidateQueries({ queryKey: mailKeys.lists });
        void qc.invalidateQueries({ queryKey: ['mail', 'thread'] });
      };
      const fail = (message: string) => {
        restore(qc, before);
        refresh();
        return message;
      };
      if (target.kind === 'uids') {
        try {
          await runOnUids(folder, target.uids, action, moveTo);
          refresh();
          return true;
        } catch (e) {
          toast(fail(mailError(t, e)));
          return false;
        }
      }

      const id = `mail-bulk-${++jobSeq}`;
      const num = (n: number) => formatNumber(n, locale);
      toast(t('mail.bulk.starting'), { id, duration: Infinity });
      try {
        const job = await runFolderJob(
          folder,
          action,
          (j) => {
            if (j.total !== null && j.status !== 'done' && j.status !== 'failed') {
              toast(t('mail.bulk.progress', { done: num(j.done), total: num(j.total) }), {
                id,
                duration: Infinity,
              });
            }
          },
          moveTo,
        );
        if (job.status === 'failed') {
          toast(fail(t('mail.bulk.failed', { error: codeText(t, job.error, 'internal') })), {
            id,
            duration: 6000,
          });
          return false;
        }
        toast(t(`mail.bulk.done.${action}`, { count: job.done }), { id, duration: 4000 });
        refresh();
        return true;
      } catch (e) {
        toast(fail(t('mail.bulk.failed', { error: mailError(t, e) })), { id, duration: 6000 });
        return false;
      }
    },
    [qc, t, locale],
  );
}
