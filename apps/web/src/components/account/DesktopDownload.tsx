import type { DesktopInfo, DesktopPlatform, DesktopRelease } from '@crewhall/shared';
import { Button, Icon } from '@crewhall/ui';
import { SettingsCard, SettingsRow } from '@/components/admin/Settings';
import { linkClass } from '@/components/auth/AuthLayout';
import { useI18n } from '@/lib/i18n/I18nContext';
import { formatBytes, formatDate } from '@/lib/i18n/format';
import { desktopBridge } from '@/lib/desktop';
import { useBootstrap } from '@/lib/useBranding';

/**
 * Desktop app downloads: the organization's server hosts the installers (bootstrap `desktop`,
 * DESKTOP_UPDATES_DIR), the same files the app updates itself from.
 */

/** The desktop app's preload marks its pages (apps/desktop/src/preload). */
const inDesktopApp = () => desktopBridge() !== null;

function detectPlatform(): DesktopPlatform {
  return typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent) ? 'mac' : 'win';
}

/** This computer's release first, then the others. */
function ordered(info: DesktopInfo): DesktopRelease[] {
  const mine = detectPlatform();
  return [...info.platforms].sort(
    (a, b) => Number(b.platform === mine) - Number(a.platform === mine),
  );
}

/** Hesabım › Güvenlik: download buttons with version and size. */
export function DesktopDownloadCard() {
  const { t, locale } = useI18n();
  const desktop = useBootstrap().data?.desktop;
  if (!desktop) return null;
  const releases = ordered(desktop);
  return (
    <SettingsCard title={t('desktop.download.title')}>
      <p className="m-0 pb-2 text-cap text-fg2">{t('desktop.download.body')}</p>
      {inDesktopApp() ? (
        <p className="m-0 pb-2.5 text-cap text-fg2">{t('desktop.download.inApp')}</p>
      ) : (
        releases.map((r, i) => (
          <SettingsRow
            key={r.platform}
            label={t(`desktop.download.platforms.${r.platform}`)}
            description={
              <>
                {r.sizeBytes !== null
                  ? t('desktop.download.meta', {
                      version: r.version,
                      size: formatBytes(r.sizeBytes, locale),
                    })
                  : r.version}
                <br />
                {t(
                  r.platform === 'mac'
                    ? 'desktop.download.unsignedMac'
                    : 'desktop.download.unsignedWin',
                )}
              </>
            }
          >
            <Button size="sm" variant={i === 0 ? 'pri' : undefined} asChild>
              <a href={r.url} download>
                <Icon name="download" size={16} />
                {t('desktop.download.button', {
                  name: t(`desktop.download.platforms.${r.platform}`),
                })}
              </a>
            </Button>
          </SettingsRow>
        ))
      )}
    </SettingsCard>
  );
}

/** Login screen: one quiet link to this computer's installer. */
export function DesktopDownloadLink() {
  const { t } = useI18n();
  const desktop = useBootstrap().data?.desktop;
  if (!desktop || inDesktopApp()) return null;
  const release = ordered(desktop)[0];
  if (!release) return null;
  return (
    <a
      href={release.url}
      download
      className={`${linkClass} inline-flex items-center gap-1.5 self-center text-[12.5px] text-fg2`}
    >
      <Icon name="download" size={14} />
      {t('desktop.download.login')}
    </a>
  );
}

/** Yönetim › Genel: which desktop version this server hands out (or that it hosts none). */
export function DesktopReleaseCard() {
  const { t, locale } = useI18n();
  const desktop = useBootstrap().data?.desktop;
  return (
    <SettingsCard title={t('desktop.download.title')}>
      {desktop ? (
        desktop.platforms.map((r) => (
          <SettingsRow
            key={r.platform}
            label={t(`desktop.download.platforms.${r.platform}`)}
            description={t('desktop.download.admin.hosted')}
          >
            <span className="text-cap text-fg2">
              {r.releasedAt
                ? t('desktop.download.admin.line', {
                    version: r.version,
                    date: formatDate(r.releasedAt, locale),
                  })
                : r.version}
            </span>
            <Button size="sm" asChild>
              <a
                href={r.url}
                download
                aria-label={t('desktop.download.button', {
                  name: t(`desktop.download.platforms.${r.platform}`),
                })}
              >
                <Icon name="download" size={16} />
              </a>
            </Button>
          </SettingsRow>
        ))
      ) : (
        <SettingsRow
          label={t('desktop.download.admin.none')}
          description={t('desktop.download.admin.noneHint')}
        />
      )}
    </SettingsCard>
  );
}
