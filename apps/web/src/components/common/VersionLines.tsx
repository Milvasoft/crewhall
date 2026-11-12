import { Icon } from '@crewhall/ui';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useVersion } from '@/lib/useVersion';

/** The running versions (lib/useVersion); a click copies the details for a bug report. */
export function VersionLines() {
  const { t } = useI18n();
  const { lines, copy } = useVersion();
  const [first, ...rest] = lines;
  return (
    <button
      type="button"
      onClick={copy}
      className="group -mx-2 flex items-start justify-between gap-3 rounded-md px-2 py-1.5 text-left hover:bg-bg2"
    >
      {/* Selectable: where the browser refuses the clipboard (plain http), this is the way out. */}
      <span className="flex min-w-0 flex-col gap-0.5 select-text">
        <span className="text-sm font-medium tn">{first}</span>
        {rest.map((line) => (
          <span key={line} className="text-cap text-fg2 tn">
            {line}
          </span>
        ))}
      </span>
      <span className="sr-only">{t('shell.version.copy')}</span>
      <Icon name="copy" size={15} className="mt-0.5 shrink-0 text-fg3 group-hover:text-fg" />
    </button>
  );
}
