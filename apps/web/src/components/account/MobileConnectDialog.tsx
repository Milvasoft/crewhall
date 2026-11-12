import { parseConnectUrl } from '@crewhall/shared';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Icon,
  Skeleton,
} from '@crewhall/ui';
import { useMutation } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';
import { Notice } from '@/components/auth/AuthLayout';
import { api, isApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useNow } from '@/lib/useNow';

/**
 * "Mobil uygulamayı bağla" (doc 12 · 12.3, faz-0-kapanis §2): a QR with the server address and a
 * 5-minute single-use token that only pre-fills the e-mail in the app. The password and 2FA are
 * still asked on the phone.
 */
export function MobileConnectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(v) => (v ? null : onClose())}>
      {open ? <ConnectBody onClose={onClose} /> : null}
    </Dialog>
  );
}

function ConnectBody({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const now = useNow(1000);
  const [qr, setQr] = useState<string | null>(null);
  const ticket = useMutation({
    mutationFn: () => api.call('createMobileConnect'),
    onSuccess: (data) => {
      void QRCode.toString(data.url, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' }).then(
        setQr,
      );
    },
  });
  const { mutate } = ticket;

  // One ticket per open (StrictMode would otherwise create two).
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    mutate();
  }, [mutate]);

  const expiresAt = ticket.data ? new Date(ticket.data.expiresAt).getTime() : null;
  const left = expiresAt ? Math.max(0, Math.round((expiresAt - now) / 1000)) : null;
  const expired = left === 0;
  const server = ticket.data ? parseConnectUrl(ticket.data.url)?.server : undefined;

  function refresh() {
    setQr(null);
    ticket.mutate();
  }

  return (
    <DialogContent width={460}>
      <DialogHeader
        icon="phone"
        title={t('account.mobile.title')}
        description={t('account.mobile.subtitle')}
      />
      {ticket.isError ? (
        <Notice tone="error">
          {isApiError(ticket.error) ? t(`errors.${ticket.error.code}`) : t('errors.internal')}
        </Notice>
      ) : null}
      <div className="flex items-start gap-5">
        <div className="relative size-[176px] shrink-0 rounded-[14px] bg-white p-3 shadow-line2">
          {qr && !expired ? (
            <div
              role="img"
              aria-label={t('account.mobile.qrAlt')}
              className="size-full [&>svg]:size-full"
              // Generated locally by the qrcode library from the connect link.
              dangerouslySetInnerHTML={{ __html: qr }}
            />
          ) : (
            <Skeleton className="size-full" />
          )}
          {expired ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-[14px] bg-surface/90 text-center">
              <Icon name="clock" size={22} className="text-fg2" />
              <span className="text-cap font-semibold text-fg">{t('account.mobile.expired')}</span>
            </div>
          ) : null}
        </div>
        <ol className="m-0 flex list-decimal flex-col gap-2 pl-4 text-cap text-fg2">
          <li>{t('account.mobile.step1')}</li>
          <li>{t('account.mobile.step2')}</li>
          <li>{t('account.mobile.step3')}</li>
        </ol>
      </div>
      <div className="flex items-center justify-between gap-3 rounded-lg bg-bg2 px-3.5 py-2.5 text-cap">
        <span className="truncate font-mono text-fg2">{server ?? ''}</span>
        <span className="shrink-0 font-mono font-semibold tn" role="timer" aria-live="off">
          {left === null
            ? ''
            : t('account.mobile.validFor', {
                time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`,
              })}
        </span>
      </div>
      <DialogFooter>
        <Button variant="gh" onClick={onClose}>
          {t('common.actions.close')}
        </Button>
        <Button variant={expired ? 'pri' : 'default'} loading={ticket.isPending} onClick={refresh}>
          <Icon name="refresh" size={16} />
          {t('account.mobile.refresh')}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
