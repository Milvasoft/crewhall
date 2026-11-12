// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/keycode-info/component.tsx. See THIRD_PARTY.md.
import { useCallback, useEffect, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { useI18n } from '@/lib/i18n/I18nContext';
import { describeKeyEvent, type KeyInfo } from './logic';

const LOCATION_KEYS = ['standard', 'left', 'right', 'numpad'] as const;

export default function KeycodeInfoTool(_: ToolComponentProps) {
  void _;
  const { t } = useI18n();
  const [info, setInfo] = useState<KeyInfo | null>(null);

  const onKeyDown = useCallback((e: KeyboardEvent) => {
    // Don't hijack refresh/devtools/tab etc.
    if (['F5', 'F12', 'Tab'].includes(e.key)) return;
    e.preventDefault();
    setInfo(describeKeyEvent(e));
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onKeyDown]);

  const locationName = (i: KeyInfo): string => {
    const id = LOCATION_KEYS[i.location];
    return id ? t(`tools.items.keycode-info.locations.${id}`) : i.locationName;
  };

  const rows: [string, string][] = info
    ? [
        ['event.key', info.key],
        ['event.code', info.code],
        ['event.keyCode', String(info.keyCode)],
        ['event.which', String(info.which)],
        [t('tools.items.keycode-info.location'), `${info.location} (${locationName(info)})`],
        [
          t('tools.items.keycode-info.modifiers'),
          info.modifiers.length ? info.modifiers.join(' + ') : t('tools.items.keycode-info.none'),
        ],
      ]
    : [];

  return (
    <div className="max-w-xl space-y-4">
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-line bg-bg2 px-6 py-10 text-center">
        {info ? (
          <>
            <span className="font-mono text-5xl font-semibold text-fg">{info.keyCode}</span>
            <span className="mt-2 font-mono text-sm text-fg2">{info.code}</span>
          </>
        ) : (
          <span className="text-sm text-fg2">{t('tools.items.keycode-info.prompt')}</span>
        )}
      </div>

      {info && (
        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          {rows.map(([label, value]) => (
            <div
              key={label}
              className="group flex items-center gap-3 border-b border-line/60 px-3 py-2 last:border-0"
            >
              <span className="w-32 shrink-0 text-xs text-fg3">{label}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-sm text-fg">{value}</span>
              <CopyButton
                size="sm"
                variant="ghost"
                value={value}
                className="opacity-0 transition-opacity group-hover:opacity-100"
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
