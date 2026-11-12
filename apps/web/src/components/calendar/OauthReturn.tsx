import { ERROR_CODES, type ErrorCode } from '@crewhall/shared';
import { toast } from '@crewhall/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import { calendarAccountsKey, calendarKeys } from '@/lib/calendar/queries';

const isErrorCode = (v: string): v is ErrorCode => (ERROR_CODES as readonly string[]).includes(v);

/**
 * Connecting a Google / Microsoft account returns to /calendar?connected=<provider> or
 * ?error=<code>. The first sync runs in the background, so the views refresh a little later.
 */
export function OauthReturn({
  connected,
  error,
  onSeen,
}: {
  connected?: string;
  error?: string;
  onSeen: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  useEffect(() => {
    if (!error && !connected) return;
    if (error) {
      toast(t(`errors.${isErrorCode(error) ? error : 'calendar_oauth_failed'}`));
    } else {
      toast(t('calendar.accounts.connected'));
      const refresh = () => {
        void qc.invalidateQueries({ queryKey: calendarAccountsKey });
        void qc.invalidateQueries({ queryKey: calendarKeys.all });
      };
      refresh();
      // Not cleared on re-render: onSeen drops the query parameters right away.
      window.setTimeout(refresh, 5_000);
    }
    onSeen();
  }, [error, connected, onSeen, qc, t]);
  return null;
}
