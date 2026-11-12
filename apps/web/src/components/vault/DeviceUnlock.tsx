import { type VaultKeyStatus } from '@crewhall/shared';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Switch,
  toast,
} from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import { vaultKeys } from '@/lib/vault/api';
import {
  deviceLockName,
  deviceState,
  disableDevice,
  enrolDevice,
  vaultDeviceBridge,
  vaultStamp,
  type DeviceState,
} from '@/lib/vault/desktop-device';
import { useVaultSession } from '@/lib/vault/session';
import { errorMessage } from './errors';

/** The unlock method id of Hello unlock on this computer (to tell it apart in the list). */
export function useThisDeviceUnlockId(userId: string | undefined, status: VaultKeyStatus) {
  return useQuery({
    queryKey: ['vault', 'device', 'id', userId, status.keyVersion, status.passwordChangedAt],
    queryFn: async () => {
      const s = await vaultDeviceBridge()?.status(userId!, vaultStamp(status));
      return s?.available && s.enrolled ? s.unlockId : null;
    },
    enabled: Boolean(userId) && vaultDeviceBridge() !== null,
  });
}

/** Days a Hello unlock lasts after the last unlock with the vault password (desktop app). */
export const HELLO_DAYS = 14;

/** Hello unlock on this device (desktop app); 'unavailable' in a browser. */
export function useDeviceState(userId: string | undefined, status: VaultKeyStatus) {
  return useQuery<DeviceState>({
    // The server's methods are part of the answer (a device it forgot is turned off): a status
    // from before an enrolment must not judge the new device.
    queryKey: [
      'vault',
      'device',
      userId,
      status.keyVersion,
      status.passwordChangedAt,
      status.unlockMethods.map((m) => m.id).join(','),
    ],
    queryFn: () => (userId ? deviceState(userId, status) : 'unavailable'),
    enabled: Boolean(userId) && vaultDeviceBridge() !== null,
    initialData: vaultDeviceBridge() ? undefined : 'unavailable',
    staleTime: 0,
  });
}

const dismissKey = (userId: string) => `crewhall.vault.helloOffer.${userId}`;

function dismissed(userId: string): boolean {
  try {
    return localStorage.getItem(dismissKey(userId)) === 'later';
  } catch {
    return false;
  }
}

/**
 * Right after the first unlock with the vault password in the desktop app: "Bundan sonra
 * Windows Hello ile aç". Accepting sets it up; "Şimdi değil" is remembered (Settings can still
 * turn it on).
 */
export function HelloOffer({ status }: { status: VaultKeyStatus }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { unlocked } = useVaultSession();
  const userId = unlocked?.userId;
  const device = useDeviceState(userId, status);
  const [closed, setClosed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = deviceLockName();

  const open =
    !closed &&
    device.data === 'off' &&
    unlocked?.method === 'password' &&
    Boolean(unlocked.verifier) &&
    !!userId &&
    !dismissed(userId);
  if (!open || !unlocked?.verifier || !userId) return null;
  const verifier = unlocked.verifier;

  const later = () => {
    try {
      localStorage.setItem(dismissKey(userId), 'later');
    } catch {
      // Private mode: asked again next time.
    }
    setClosed(true);
  };

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      await enrolDevice(status, t('vault.hello.methodLabel', { name }), verifier);
      // The key status lists the new method; the device state follows it (its query key).
      await qc.invalidateQueries({ queryKey: vaultKeys.status });
      toast(t('vault.hello.enabled', { name }));
      setClosed(true);
    } catch (e) {
      setError(
        e instanceof DOMException ? t('vault.hello.cancelled', { name }) : errorMessage(e, t),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && later()}>
      <DialogContent width={440}>
        <DialogHeader
          icon="finger"
          title={t('vault.hello.offerTitle', { name })}
          description={t('vault.hello.offerBody', { name, days: HELLO_DAYS })}
        />
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="gh" onClick={later}>
            {t('vault.hello.offerLater')}
          </Button>
          <Button variant="pri" loading={busy} onClick={() => void accept()}>
            {t('vault.hello.offerAccept', { name })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Settings row: Hello unlock on or off on this computer. Turning it on needs the vault password
 * proof (`proof`); off forgets the key here and the method on the server.
 */
export function HelloSettingsRow({
  status,
  proof,
  render,
}: {
  status: VaultKeyStatus;
  proof: { get: () => Promise<Uint8Array>; ready: boolean; field: ReactNode };
  render: (props: {
    title: string;
    hint: string;
    control: ReactNode;
    extra: ReactNode;
  }) => ReactNode;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { unlocked } = useVaultSession();
  const userId = unlocked?.userId;
  const device = useDeviceState(userId, status);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = deviceLockName();
  if (!userId || !device.data || device.data === 'unavailable') return null;
  const on = device.data === 'ready' || device.data === 'expired';

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: vaultKeys.status });
  };

  const turnOn = async () => {
    setBusy(true);
    setError(null);
    try {
      await enrolDevice(status, t('vault.hello.methodLabel', { name }), await proof.get());
      setAsking(false);
      await refresh();
    } catch (e) {
      setError(
        e instanceof DOMException ? t('vault.hello.cancelled', { name }) : errorMessage(e, t),
      );
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    setBusy(true);
    setError(null);
    try {
      await disableDevice(userId);
      await refresh();
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  const extra =
    asking || error ? (
      <div className="flex flex-col gap-3 py-2 pl-4">
        {asking ? (
          <>
            {proof.field}
            <div className="flex gap-2">
              <Button size="sm" variant="gh" onClick={() => setAsking(false)}>
                {t('vault.cancel')}
              </Button>
              <Button
                size="sm"
                variant="pri"
                loading={busy}
                disabled={!proof.ready}
                onClick={() => void turnOn()}
              >
                {t('vault.hello.offerAccept', { name })}
              </Button>
            </div>
          </>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </div>
    ) : null;

  return render({
    title: t('vault.hello.settingsTitle', { name }),
    hint: t('vault.hello.settingsHint', { days: HELLO_DAYS }),
    control: (
      <Switch
        checked={on}
        disabled={busy}
        aria-label={t('vault.hello.settingsTitle', { name })}
        onCheckedChange={(v) => {
          if (!v) void turnOff();
          else if (proof.ready && !proof.field) void turnOn();
          else setAsking(true);
        }}
      />
    ),
    extra,
  });
}
