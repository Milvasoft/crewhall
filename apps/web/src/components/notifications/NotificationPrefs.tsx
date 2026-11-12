import {
  type BodyOf,
  type NotificationCategory,
  type NotificationChannel,
  type NotificationGroupKey,
  type NotificationGroupPref,
  type NotificationPrefs,
} from '@crewhall/shared';
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Segmented,
  Skeleton,
  Switch,
  TimePicker,
  toast,
} from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { api } from '@/lib/api';
import { chatKeys, chatSettingsQuery, notificationPrefsQuery } from '@/lib/chat/queries';
import { playTone, setMessageSoundOn, useMessageSoundOn } from '@/lib/chat/sound';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { PluginPrefRow } from '@/components/plugins/PluginSettings';
import { pluginNotificationPrefsQuery } from '@/lib/plugins/queries';

type Channel = 'inApp' | 'push' | 'email';
const CHANNELS: Channel[] = ['inApp', 'push', 'email'];
const GROUP_CHANNELS: NotificationChannel[] = ['inApp', 'desktop', 'push', 'email'];

/** Rows of the page by section; a row the server does not send (module off) is left out. */
const SECTIONS: {
  key: 'chat' | 'meet' | 'work' | 'org' | 'security';
  rows: NotificationGroupKey[];
}[] = [
  {
    key: 'chat',
    rows: [
      'chat_direct',
      'chat_mention',
      'chat_reply',
      'chat_messages',
      'chat_alerts',
      'chat_reminders',
    ],
  },
  { key: 'meet', rows: ['calls', 'meetings', 'calendar'] },
  { key: 'work', rows: ['mail', 'boards', 'pages', 'drive', 'approvals', 'forms', 'automations'] },
  { key: 'org', rows: ['announcements', 'integrations', 'portal', 'plugins'] },
  { key: 'security', rows: ['vault', 'security'] },
];

/** Doc 17 §10 matrix, e-mail digest, quiet hours and read receipts (4.5). */
export function NotificationPrefsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent width={720}>
          <DialogHeader title={t('chat.prefs.title')} description={t('chat.prefs.hint')} />
          <NotificationPrefsBody />
          <DialogFooter>
            <Link
              to="/account/notifications"
              onClick={() => onOpenChange(false)}
              className="mr-auto self-center text-cap font-semibold text-fg2 underline-offset-2 hover:text-fg hover:underline"
            >
              {t('chat.prefs.openPage')}
            </Link>
            <Button variant="inv" onClick={() => onOpenChange(false)}>
              {t('common.actions.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

/** The matrix, digest, quiet hours, sound and time zone (the dialog and Hesabım › Bildirimler). */
export function NotificationPrefsBody() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { data: prefs } = useQuery(notificationPrefsQuery);
  const { data: settings } = useQuery(chatSettingsQuery);
  const fail = (e: unknown) => toast.error(t(errorKey(e)));
  const soundOn = useMessageSoundOn();

  const update = async (body: BodyOf<'updateNotificationPrefs'>) => {
    try {
      qc.setQueryData(
        chatKeys.notificationPrefs,
        await api.call('updateNotificationPrefs', { body }),
      );
    } catch (e) {
      fail(e);
    }
  };
  const updateSettings = async (body: { timezone?: string | null }) => {
    try {
      qc.setQueryData(chatKeys.settings, await api.call('updateChatSettings', { body }));
    } catch (e) {
      fail(e);
    }
  };

  if (!prefs || !settings) return <Skeleton className="h-60 w-full" />;
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <div className="flex flex-col gap-5">
      {prefs.groups ? (
        <GroupTable groups={prefs.groups} update={update} />
      ) : (
        <CategoryTable prefs={prefs} update={update} />
      )}
      <PluginPrefs />
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-cap font-semibold">{t('chat.prefs.digest')}</span>
        <Segmented
          size="sm"
          value={prefs.digest}
          onValueChange={(digest) => void update({ digest })}
          options={(['off', 'hourly', 'daily'] as const).map((v) => ({
            value: v,
            label: t(`chat.prefs.digests.${v}`),
          }))}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-cap font-semibold">
          <Switch
            checked={prefs.quietHours !== null}
            onCheckedChange={(v) =>
              void update({ quietHours: v ? { from: '22:00', to: '08:00' } : null })
            }
            aria-label={t('chat.prefs.quiet')}
          />
          {t('chat.prefs.quiet')}
        </label>
        {prefs.quietHours ? (
          <span className="flex items-center gap-2 text-cap">
            <TimePicker
              className="w-[116px]"
              value={prefs.quietHours.from}
              aria-label={t('chat.prefs.quietFrom')}
              onChange={(v) =>
                v &&
                void update({
                  quietHours: { from: v, to: prefs.quietHours?.to ?? '08:00' },
                })
              }
            />
            –
            <TimePicker
              className="w-[116px]"
              value={prefs.quietHours.to}
              aria-label={t('chat.prefs.quietTo')}
              onChange={(v) =>
                v &&
                void update({
                  quietHours: { from: prefs.quietHours?.from ?? '22:00', to: v },
                })
              }
            />
          </span>
        ) : null}
      </div>
      <div className="flex flex-col gap-2 border-t border-line pt-4">
        <div className="flex items-center justify-between gap-3 text-cap font-semibold">
          <span className="flex flex-col">
            {t('chat.prefs.sound')}
            <span className="text-xs font-normal text-fg2">{t('chat.prefs.soundHint')}</span>
          </span>
          <span className="flex items-center gap-2">
            <Button
              size="xs"
              variant="gh"
              disabled={!soundOn}
              onClick={() => playTone('message', { force: true })}
            >
              {t('chat.prefs.soundTry')}
            </Button>
            <Switch
              checked={soundOn}
              onCheckedChange={setMessageSoundOn}
              aria-label={t('chat.prefs.sound')}
            />
          </span>
        </div>
        <div className="flex items-center justify-between gap-3 text-cap">
          <span className="flex flex-col font-semibold">
            {t('chat.prefs.timezone')}
            <span className="text-xs font-normal text-fg2">
              {settings.timezone ?? t('chat.prefs.noTimezone')}
            </span>
          </span>
          {browserZone && browserZone !== settings.timezone ? (
            <Button
              size="xs"
              variant="out"
              onClick={() => void updateSettings({ timezone: browserZone })}
            >
              {t('chat.prefs.useBrowserZone', { zone: browserZone })}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

type Update = (body: BodyOf<'updateNotificationPrefs'>) => Promise<void>;

/** Older servers: one row per category, three channels. */
function CategoryTable({ prefs, update }: { prefs: NotificationPrefs; update: Update }) {
  const { t } = useI18n();
  return (
    <table className="w-full border-collapse text-cap">
      <thead>
        <tr className="text-left text-xs text-fg3">
          <th className="py-1.5 font-semibold">{t('chat.prefs.category')}</th>
          {CHANNELS.map((c) => (
            <th key={c} className="w-[90px] py-1.5 text-center font-semibold">
              {t(`chat.prefs.channels.${c}`)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {prefs.categories.map((row) => (
          <tr key={row.category} className="border-t border-line">
            <td className="py-2">
              {t(`chat.prefs.categories.${row.category as NotificationCategory}`)}
              {row.category === 'alert' ? (
                <span className="block text-xs text-fg2">{t('chat.prefs.alertPlugins')}</span>
              ) : null}
            </td>
            {CHANNELS.map((c) => (
              <td key={c} className="py-2 text-center">
                <Checkbox
                  checked={row[c]}
                  disabled={row.locked.includes(c)}
                  aria-label={`${t(`chat.prefs.categories.${row.category as NotificationCategory}`)} · ${t(`chat.prefs.channels.${c}`)}`}
                  onCheckedChange={(v) =>
                    void update({ categories: [{ category: row.category, [c]: v === true }] })
                  }
                />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** One row per kind of notification × bell, desktop, push and e-mail, by section. */
function GroupTable({ groups, update }: { groups: NotificationGroupPref[]; update: Update }) {
  const { t } = useI18n();
  const byKey = new Map(groups.map((g) => [g.group, g]));
  const anyLocked = groups.some((g) => g.locked.length > 0);
  return (
    <div className="flex flex-col gap-1 overflow-x-auto">
      <table className="w-full min-w-[520px] border-collapse text-cap">
        <thead>
          <tr className="text-left text-xs text-fg3">
            <th className="py-1.5 font-semibold">{t('chat.prefs.category')}</th>
            {GROUP_CHANNELS.map((c) => (
              <th key={c} className="w-[76px] py-1.5 text-center font-semibold">
                {t(`chat.prefs.channels.${c}`)}
              </th>
            ))}
          </tr>
        </thead>
        {SECTIONS.map((section) => {
          const rows = section.rows
            .map((k) => byKey.get(k))
            .filter((g): g is NotificationGroupPref => g !== undefined);
          if (!rows.length) return null;
          return (
            <tbody key={section.key}>
              <tr>
                <th
                  colSpan={GROUP_CHANNELS.length + 1}
                  scope="colgroup"
                  className="pt-4 pb-1 text-left text-[11px] font-bold tracking-[.06em] text-fg3 uppercase"
                >
                  {t(`chat.prefs.sections.${section.key}`)}
                </th>
              </tr>
              {rows.map((row) => {
                const title = t(`chat.prefs.groups.${row.group}.title`);
                return (
                  <tr key={row.group} className="border-t border-line">
                    <td className="py-2 pr-3">
                      <span className="font-semibold">{title}</span>
                      <span className="block text-xs text-fg2">
                        {t(`chat.prefs.groups.${row.group}.hint`)}
                      </span>
                    </td>
                    {GROUP_CHANNELS.map((c) => (
                      <td key={c} className="py-2 text-center">
                        {row.channels.includes(c) ? (
                          <Checkbox
                            // The OS notification comes from the bell: none without it.
                            checked={row[c] && (c !== 'desktop' || row.inApp)}
                            disabled={row.locked.includes(c) || (c === 'desktop' && !row.inApp)}
                            aria-label={`${title} · ${t(`chat.prefs.channels.${c}`)}`}
                            onCheckedChange={(v) =>
                              void update({ groups: [{ group: row.group, [c]: v === true }] })
                            }
                          />
                        ) : (
                          <span aria-hidden className="text-fg3">
                            –
                          </span>
                        )}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          );
        })}
      </table>
      {anyLocked ? <p className="m-0 text-xs text-fg2">{t('chat.prefs.lockedNote')}</p> : null}
    </div>
  );
}

/**
 * Every active plugin I see: where its notifications reach me (when it may notify me) and
 * whether it shows in the mobile app. Hidden while there are none.
 */
function PluginPrefs() {
  const { t } = useI18n();
  const { data: plugins } = useQuery(pluginNotificationPrefsQuery);
  if (!plugins?.length) return null;
  return (
    <section className="flex flex-col gap-2" aria-labelledby="plugin-prefs">
      <span id="plugin-prefs" className="text-cap font-semibold">
        {t('chat.prefs.plugins.title')}
      </span>
      <span className="text-xs text-fg2">{t('chat.prefs.plugins.hint')}</span>
      <ul className="m-0 flex list-none flex-col p-0">
        {plugins.map((p) => (
          <PluginPrefRow key={p.installationId} pref={p} />
        ))}
      </ul>
    </section>
  );
}
