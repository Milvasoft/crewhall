import { Button, Field, Icon, Input } from '@crewhall/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useState, type FormEvent } from 'react';
import { OrDivider } from '@/components/auth/AuthLayout';
import { isApiError } from '@/lib/api';
import { addPasskey } from '@/lib/auth/auth';
import { useI18n } from '@/lib/i18n/I18nContext';
import {
  declineDevicePasskey,
  deviceLockLabel,
  prefetchPasskeyOptions,
  reauthWithPasskey,
  shouldOfferDevicePasskey,
} from '@/lib/identity/stepup';
import { meQuery } from '@/lib/queries';
import { useMe } from '@/lib/session';

/**
 * The body of every re-verification dialog (security settings, MCP and AI approvals): a
 * passkey first when the person has one (Windows Hello, Touch ID, a security key; the
 * desktop app too), the password as the alternative; without a passkey the password, then (in
 * the same window, inside the 10-minute verification) an offer to verify with this device's lock
 * next time: Windows Hello, Touch ID or Face ID become a passkey, asked for first from then on.
 */
export function StepUpForm({
  verifyPassword,
  onVerified,
}: {
  verifyPassword: (password: string) => Promise<unknown>;
  onVerified: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const me = useMe();
  const hasPasskey = me?.user.hasPasskey === true;
  const [offer, setOffer] = useState(false);
  const [withPassword, setWithPassword] = useState(!hasPasskey);
  const [password, setPassword] = useState('');
  const [passkeyError, setPasskeyError] = useState<string | null>(null);

  // The server's options are fetched while the person reads the dialog (no wait on click).
  useEffect(() => {
    if (hasPasskey) prefetchPasskeyOptions();
  }, [hasPasskey]);
  const viaPasskey = useMutation({
    mutationFn: reauthWithPasskey,
    onSuccess: (res) => {
      if (res.ok) return onVerified();
      if (res.kind === 'cancelled') return;
      setPasskeyError(
        res.code === 'rate_limited' ? t('errors.rate_limited') : t('identity.stepup.passkeyFailed'),
      );
      setWithPassword(true);
    },
  });
  const viaPassword = useMutation({
    mutationFn: () => verifyPassword(password),
    onSuccess: async () => {
      setPassword('');
      // Verified; before going on, offer the device lock for next time (once, if it has one).
      if (!hasPasskey && me && (await shouldOfferDevicePasskey(me.user.id))) setOffer(true);
      else onVerified();
    },
  });

  if (offer && me) {
    return (
      <DevicePasskeyOffer
        onDone={() => {
          void qc.invalidateQueries({ queryKey: meQuery.queryKey });
          onVerified();
        }}
        onLater={() => {
          declineDevicePasskey(me.user.id);
          onVerified();
        }}
      />
    );
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (password) viaPassword.mutate();
  }

  const passwordError = viaPassword.error
    ? isApiError(viaPassword.error)
      ? t(`errors.${viaPassword.error.code}`)
      : t('errors.internal')
    : undefined;

  return (
    <div className="flex flex-col gap-3">
      {hasPasskey ? (
        <>
          <Button
            variant="pri"
            full
            autoFocus
            loading={viaPasskey.isPending}
            onClick={() => {
              setPasskeyError(null);
              viaPasskey.mutate();
            }}
          >
            <Icon name="finger" size={18} />
            {t('identity.stepup.passkey')}
          </Button>
          {passkeyError ? (
            <span role="alert" className="text-xs text-danger">
              {passkeyError}
            </span>
          ) : null}
          {withPassword ? (
            <OrDivider>{t('identity.stepup.or')}</OrDivider>
          ) : (
            <button
              type="button"
              className="self-center text-cap font-medium text-fg2 underline decoration-line2 underline-offset-[3px] hover:text-fg"
              onClick={() => setWithPassword(true)}
            >
              {t('identity.stepup.withPassword')}
            </button>
          )}
        </>
      ) : null}
      {withPassword ? (
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Field label={t('identity.stepup.password')} error={passwordError}>
            <Input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus={!hasPasskey}
            />
          </Field>
          <Button
            type="submit"
            variant={hasPasskey ? 'out' : 'pri'}
            full
            loading={viaPassword.isPending}
            disabled={!password}
          >
            {hasPasskey ? t('identity.stepup.withPassword') : t('identity.stepup.confirm')}
          </Button>
        </form>
      ) : null}
      {hasPasskey ? null : (
        <Link
          to="/account/security"
          className="flex items-center gap-1.5 text-xs text-fg2 hover:text-fg"
        >
          <Icon name="finger" size={14} />
          {t('identity.stepup.addPasskeyHint')}
        </Link>
      )}
    </div>
  );
}

/** "Bir dahaki sefere Windows Hello ile doğrula": a platform passkey, or not now. */
function DevicePasskeyOffer({ onDone, onLater }: { onDone: () => void; onLater: () => void }) {
  const { t } = useI18n();
  const name = deviceLockLabel() ?? t('identity.stepup.deviceLock');
  const [failed, setFailed] = useState(false);
  const add = useMutation({
    mutationFn: () => addPasskey(t('identity.stepup.passkeyName', { name }), { platform: true }),
    onSuccess: (res) => {
      if (res.ok) onDone();
      // The person closed the system prompt: the same as "not now", without remembering it.
      else if (res.kind === 'cancelled') onDone();
      else setFailed(true);
    },
    onError: () => setFailed(true),
  });
  return (
    <div className="flex flex-col gap-3">
      <span className="flex size-11 items-center justify-center self-center rounded-2xl bg-bg2">
        <Icon name="finger" size={22} />
      </span>
      <h3 className="text-center text-sub font-semibold">
        {t('identity.stepup.offerTitle', { name })}
      </h3>
      <p className="text-center text-cap text-fg2">{t('identity.stepup.offerBody')}</p>
      {failed ? (
        <span role="alert" className="text-xs text-danger">
          {t('identity.stepup.offerFailed')}
        </span>
      ) : null}
      <Button
        variant="pri"
        full
        autoFocus
        loading={add.isPending}
        onClick={() => (failed ? onDone() : add.mutate())}
      >
        <Icon name="finger" size={18} />
        {failed ? t('identity.stepup.confirm') : t('identity.stepup.offerAccept', { name })}
      </Button>
      {failed ? null : (
        <Button variant="gh" full onClick={onLater}>
          {t('identity.stepup.offerLater')}
        </Button>
      )}
    </div>
  );
}
