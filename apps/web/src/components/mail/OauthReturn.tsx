import { toast } from '@crewhall/ui';
import { useEffect } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import { codeText } from './errors';

/** The OAuth2 callback returns to /mail?connected=1 or /mail?error=<error code>. */
export function OauthReturn({
  connected,
  error,
  onSeen,
}: {
  connected?: boolean;
  error?: string;
  onSeen: () => void;
}) {
  const { t } = useI18n();
  useEffect(() => {
    if (!error && !connected) return;
    if (error) toast(codeText(t, error, 'mail_oauth_failed'));
    else toast(t('mail.connect.connected'));
    onSeen();
  }, [error, connected, onSeen, t]);
  return null;
}
