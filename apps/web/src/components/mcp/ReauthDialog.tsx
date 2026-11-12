import { Dialog, DialogContent, DialogHeader } from '@crewhall/ui';
import { useRef, useState } from 'react';
import { StepUpForm } from '@/components/identity/StepUp';
import { api, isApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';

/**
 * Passkey or password check (design 18.5, 18.7): approvals (AI suggestions too) and widening
 * a connection need one in the last 10 minutes. The passkey verifies this session; it no
 * longer signs in again.
 */
export function ReauthDialog({
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
            title={t('mcp.reauth.title')}
            description={t('mcp.reauth.body')}
          />
          <StepUpForm
            verifyPassword={(password) => api.call('mcpReauth', { body: { password } })}
            onVerified={onVerified}
          />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

/**
 * Runs an action; when the server answers mcp_reauth_required, asks for a check and
 * runs it again once verified.
 */
export function useReauth(opts: { onCancel?: () => void } = {}) {
  const [open, setOpen] = useState(false);
  const retry = useRef<(() => void) | null>(null);
  return {
    dialog: (
      <ReauthDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            retry.current = null;
            opts.onCancel?.();
          }
        }}
        onVerified={() => {
          setOpen(false);
          retry.current?.();
          retry.current = null;
        }}
      />
    ),
    /** Call from onError: true when the error was handled by opening the dialog. */
    handle(err: unknown, again: () => void) {
      if (!isApiError(err, 'mcp_reauth_required')) return false;
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
