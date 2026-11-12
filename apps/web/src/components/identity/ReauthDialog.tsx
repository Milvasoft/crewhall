import { Dialog, DialogContent, DialogHeader } from '@crewhall/ui';
import { useRef, useState } from 'react';
import { StepUpForm } from '@/components/identity/StepUp';
import { api, isApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';

/**
 * Re-verification for sensitive admin changes (security policy, secret rotation): a passkey
 * or the password, valid for 10 minutes in this session.
 */
function IdentityReauthDialog({
  open,
  onOpenChange,
  onVerified,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onVerified: () => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent width={420}>
          <DialogHeader
            icon="shield"
            title={t('identity.reauth.title')}
            description={t('identity.reauth.body')}
          />
          <StepUpForm
            verifyPassword={(password) => api.call('identityReauth', { body: { password } })}
            onVerified={onVerified}
          />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

/**
 * Runs an action that may need a fresh verification: `handle` in onError opens the dialog on
 * 403 identity_reauth_required and retries once verified; `ask` opens it up front.
 */
export function useIdentityReauth() {
  const [open, setOpen] = useState(false);
  const retry = useRef<(() => void) | null>(null);
  return {
    dialog: (
      <IdentityReauthDialog
        open={open}
        onOpenChange={setOpen}
        onVerified={() => {
          setOpen(false);
          retry.current?.();
          retry.current = null;
        }}
      />
    ),
    handle(err: unknown, again: () => void): boolean {
      if (!isApiError(err, 'identity_reauth_required')) return false;
      retry.current = again;
      setOpen(true);
      return true;
    },
    ask(again: () => void) {
      retry.current = again;
      setOpen(true);
    },
  };
}
