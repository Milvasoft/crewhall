import { useQuery } from '@tanstack/react-query';
import { copyText } from '@/components/identity/parts';
import { readBuildInfo, shortCommit } from '@/lib/buildInfo';
import { desktopBridge } from '@/lib/desktop';
import { formatDate, formatTime } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { compatQuery } from '@/lib/queries';

const SEP = ' · ';

/**
 * Which version is running, for "did the deploy arrive?": this page's build, the server's and the
 * desktop app's. The lines are short; what gets copied carries the full commit and exact time.
 */
export function useVersion(): { lines: string[]; copy: () => void } {
  const { t, locale } = useI18n();
  const server = useQuery(compatQuery).data;
  const build = readBuildInfo();
  const desktop = desktopBridge()?.version;

  const text = (full: boolean): string[] => {
    const at = build?.builtAt;
    const web = [
      t('shell.version.web', { version: build?.id ?? t('shell.version.dev') }),
      build?.commit ? (full ? build.commit : shortCommit(build.commit)) : null,
      at ? (full ? at : `${formatDate(at, locale)} ${formatTime(at, locale)}`) : null,
    ];
    const lines = [web.filter(Boolean).join(SEP)];
    if (server) {
      const commit = server.commit ? (full ? server.commit : shortCommit(server.commit)) : null;
      lines.push(
        [
          t('shell.version.server', { version: commit ?? server.version }),
          full ? server.build : null,
          t('shell.version.api', { level: server.apiLevel }),
        ]
          .filter(Boolean)
          .join(SEP),
      );
    }
    if (desktop) lines.push(t('shell.version.desktop', { version: desktop }));
    return lines;
  };

  return {
    lines: text(false),
    copy: () => void copyText(text(true).join('\n'), t('shell.version.copied')),
  };
}
