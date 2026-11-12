import { EmptyState, Spinner } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { Workspace } from '@/components/shell/Workspace';
import { useI18n } from '@/lib/i18n/I18nContext';
import { usePermissions } from '@/lib/session';
import { keyStatusQuery } from '@/lib/vault/api';
import { useAutoLock } from '@/lib/vault/autolock';
import { setupVaultCrypto } from '@/lib/vault/crypto';
import { lock, useVaultSession } from '@/lib/vault/session';
import { HelloOffer } from './DeviceUnlock';
import { CopyToast } from './fields';
import { SetupFlow } from './SetupFlow';
import { UnlockScreen } from './UnlockScreen';

/**
 * Every /vault screen sits behind this gate: setup when the person has no keys, the lock screen
 * when the vault is locked, the screens only while unlocked (design 8.3: "Kilitliyken kenar
 * çubuğu ve liste gizlenir").
 */
export function VaultGate({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const { role } = usePermissions();
  const { unlocked } = useVaultSession();
  const status = useQuery({ ...keyStatusQuery, enabled: role !== 'guest' });
  useAutoLock();

  useEffect(() => {
    setupVaultCrypto();
  }, []);

  // Keys of another account than the one unlocked (sign-out, account switch): lock.
  const mismatch = Boolean(
    unlocked && status.data?.publicKey && status.data.publicKey !== unlocked.publicKey,
  );
  useEffect(() => {
    if (mismatch) lock('manual');
  }, [mismatch]);

  if (role === 'guest') {
    return (
      <Workspace crumbs={[{ label: t('vault.title') }]}>
        <EmptyState
          className="m-auto"
          icon="vault"
          title={t('vault.guest.title')}
          description={t('vault.guest.body')}
        />
      </Workspace>
    );
  }
  if (status.isPending) {
    return (
      <Workspace crumbs={[{ label: t('vault.title') }]}>
        <Spinner className="m-auto" />
      </Workspace>
    );
  }
  if (status.isError || !status.data) {
    return (
      <Workspace crumbs={[{ label: t('vault.title') }]}>
        <EmptyState className="m-auto" icon="alert" title={t('vault.error.load')} />
      </Workspace>
    );
  }
  if (mismatch) return null;
  if (!status.data.setUp) return <SetupFlow />;
  if (!unlocked) return <UnlockScreen status={status.data} />;
  return (
    <>
      {children}
      <CopyToast />
      {/* Desktop app: "Bundan sonra Windows Hello ile aç" after a password unlock. */}
      <HelloOffer status={status.data} />
    </>
  );
}
