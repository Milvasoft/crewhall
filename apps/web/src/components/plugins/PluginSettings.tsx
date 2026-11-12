import { localize } from '@crewhall/plugin-sdk';
import {
  type PluginNotificationChannels,
  type PluginNotificationPref,
  type UpdatePluginNotificationPref,
} from '@crewhall/shared';
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  IconButton,
  Icon,
  Skeleton,
  Switch,
  toast,
} from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { pluginKeys, pluginNotificationPrefsQuery } from '@/lib/plugins/queries';
import { usePluginSurfaces } from './surfaces';

/**
 * A person's settings for one plugin (docs/contracts/eklentiler.md › Bildirimler): where its
 * notifications reach them (bell, desktop, phone) and whether it shows in the mobile app.
 * Used in Bildirim ayarları › Eklentiler and from the plugin's own tab ("Bu eklentinin
 * ayarları"). Stored on the server: it follows the person to every device.
 */

const CHANNELS: (keyof PluginNotificationChannels)[] = ['bell', 'desktop', 'push'];
const ALL_ON: PluginNotificationChannels = { bell: true, desktop: true, push: true };

export function usePluginPrefUpdate() {
  const { t } = useI18n();
  const qc = useQueryClient();
  return async (installationId: string, body: UpdatePluginNotificationPref) => {
    try {
      const next = await api.call('updatePluginNotificationPref', {
        params: { installationId },
        body,
      });
      qc.setQueryData(pluginKeys.notificationPrefs, (list: PluginNotificationPref[] = []) =>
        list.map((x) => (x.installationId === next.installationId ? next : x)),
      );
      // The mobile flag and the pins also change what the surfaces say.
      if (body.showOnMobile !== undefined || body.pinnedTabs !== undefined) {
        void qc.invalidateQueries({ queryKey: pluginKeys.surfaces });
      }
    } catch (e) {
      toast.error(t(errorKey(e)));
    }
  };
}

/** Only turns off: saying yes happens in the dialog the plugin opens, where it is explained. */
function OfflineAccessToggle({ installationId }: { installationId: string }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const key = [...pluginKeys.notificationPrefs, 'offline', installationId];
  const grant = useQuery({
    queryKey: key,
    queryFn: () => api.call('getPluginOfflineGrant', { params: { installationId } }),
  });
  if (!grant.data?.granted) return null;
  return (
    <label className="flex items-center gap-2 pl-8 text-xs text-fg2">
      <Switch
        checked
        onCheckedChange={() =>
          void api
            .call('revokePluginOffline', { params: { installationId } })
            .then(() => qc.invalidateQueries({ queryKey: key }))
            .catch((e: unknown) => toast.error(t(errorKey(e))))
        }
      />
      {t('plugins.offline.setting')}
    </label>
  );
}

export function PluginPrefRow({ pref }: { pref: PluginNotificationPref }) {
  const { t, locale } = useI18n();
  const update = usePluginPrefUpdate();
  const name = localize(pref.name, locale);
  const channels = pref.channels ?? ALL_ON;
  // Tabs the manifest puts elsewhere can also go in the left rail; rail tabs are there anyway.
  const surface = usePluginSurfaces().find((s) => s.installationId === pref.installationId);
  const pinnable = surface?.tabs.filter((x) => x.placement !== 'rail') ?? [];
  const pinned = pref.pinnedTabs ?? [];
  return (
    <li className="flex flex-col gap-2 border-t border-line py-2.5 first:border-t-0">
      <span className="flex items-center gap-2.5">
        {pref.icon ? (
          <img
            src={pref.icon}
            alt=""
            referrerPolicy="no-referrer"
            className="size-6 rounded-md bg-bg2 object-cover"
          />
        ) : (
          <Icon name="plug" size={16} className="text-fg2" />
        )}
        <span className="flex-1 text-cap font-semibold">{name}</span>
        <label className="flex items-center gap-2 text-xs text-fg2">
          {t('plugins.prefs.showOnMobile')}
          <Switch
            checked={pref.showOnMobile ?? true}
            aria-label={t('plugins.prefs.showOnMobileOf', { name })}
            onCheckedChange={(v) => void update(pref.installationId, { showOnMobile: v })}
          />
        </label>
      </span>
      {pref.canNotify ? (
        <span
          className="flex flex-wrap items-center gap-x-4 gap-y-1.5 pl-8"
          role="group"
          aria-label={t('plugins.prefs.channelsOf', { name })}
        >
          {CHANNELS.map((c) => (
            <label key={c} className="flex cursor-pointer items-center gap-2 text-xs">
              <Checkbox
                checked={channels[c] && (c !== 'desktop' || channels.bell)}
                // The desktop toast is the bell's live event: no bell, no toast.
                disabled={c === 'desktop' && !channels.bell}
                onCheckedChange={(v) =>
                  void update(pref.installationId, { channels: { [c]: v === true } })
                }
              />
              {t(`plugins.prefs.channels.${c}`)}
            </label>
          ))}
        </span>
      ) : (
        <span className="pl-8 text-xs text-fg3">{t('plugins.prefs.noNotifications')}</span>
      )}
      {surface?.permissions?.includes('offline:access') ? (
        <OfflineAccessToggle installationId={pref.installationId} />
      ) : null}
      {pinnable.map((tab) => (
        <label key={tab.id} className="flex items-center gap-2 pl-8 text-xs text-fg2">
          <Switch
            checked={pinned.includes(tab.id)}
            onCheckedChange={(v) =>
              void update(pref.installationId, {
                pinnedTabs: v ? [...pinned, tab.id] : pinned.filter((x) => x !== tab.id),
              })
            }
          />
          {t('plugins.prefs.pinTab', { tab: localize(tab.title, locale) })}
        </label>
      ))}
    </li>
  );
}

/** "Bu eklentinin ayarları": the same row, for one plugin. */
export function PluginSettingsButton({ installationId }: { installationId: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton
        size="sm"
        aria-label={t('plugins.prefs.open')}
        title={t('plugins.prefs.open')}
        onClick={() => setOpen(true)}
      >
        <Icon name="settings" size={16} />
      </IconButton>
      <Dialog open={open} onOpenChange={setOpen}>
        {open ? (
          <DialogContent width={460}>
            <DialogHeader title={t('plugins.prefs.open')} description={t('plugins.prefs.hint')} />
            <OnePlugin installationId={installationId} />
            <DialogFooter>
              <Button variant="inv" onClick={() => setOpen(false)}>
                {t('common.actions.close')}
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}

function OnePlugin({ installationId }: { installationId: string }) {
  const { data } = useQuery(pluginNotificationPrefsQuery);
  if (!data) return <Skeleton className="h-16 w-full" />;
  const pref = data.find((p) => p.installationId === installationId);
  return pref ? (
    <ul className="m-0 list-none p-0">
      <PluginPrefRow pref={pref} />
    </ul>
  ) : null;
}
