// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/device-information/component.tsx. See THIRD_PARTY.md.
import { useEffect, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { useI18n } from '@/lib/i18n/I18nContext';

type FieldId =
  | 'screen'
  | 'availableScreen'
  | 'viewport'
  | 'pixelRatio'
  | 'colorDepth'
  | 'orientation'
  | 'platform'
  | 'languages'
  | 'cpuCores'
  | 'deviceMemory'
  | 'online'
  | 'cookies'
  | 'timeZone'
  | 'userAgent';

type Word = 'unknown' | 'unavailable' | 'yes' | 'no';

/** A raw value, a word translated at render, or a color depth in bits. */
type Value = { text: string } | { word: Word } | { bits: number };

interface Info {
  id: FieldId;
  value: Value;
}

const yesNo = (b: boolean): Value => ({ word: b ? 'yes' : 'no' });

function collect(): Info[] {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const dpr = window.devicePixelRatio || 1;
  const languages = nav.languages?.join(', ') || nav.language;
  return [
    { id: 'screen', value: { text: `${screen.width} × ${screen.height}` } },
    { id: 'availableScreen', value: { text: `${screen.availWidth} × ${screen.availHeight}` } },
    { id: 'viewport', value: { text: `${window.innerWidth} × ${window.innerHeight}` } },
    { id: 'pixelRatio', value: { text: `${dpr}` } },
    { id: 'colorDepth', value: { bits: screen.colorDepth } },
    {
      id: 'orientation',
      value: screen.orientation?.type ? { text: screen.orientation.type } : { word: 'unknown' },
    },
    { id: 'platform', value: nav.platform ? { text: nav.platform } : { word: 'unknown' } },
    { id: 'languages', value: { text: languages } },
    { id: 'cpuCores', value: { text: `${nav.hardwareConcurrency ?? '?'}` } },
    {
      id: 'deviceMemory',
      value: nav.deviceMemory ? { text: `${nav.deviceMemory} GB` } : { word: 'unavailable' },
    },
    { id: 'online', value: yesNo(nav.onLine) },
    { id: 'cookies', value: yesNo(nav.cookieEnabled) },
    { id: 'timeZone', value: { text: Intl.DateTimeFormat().resolvedOptions().timeZone } },
    { id: 'userAgent', value: { text: nav.userAgent } },
  ];
}

export default function DeviceInformationTool(_: ToolComponentProps) {
  void _;
  const { t } = useI18n();
  const [info, setInfo] = useState<Info[]>(() => collect());

  useEffect(() => {
    const update = () => setInfo(collect());
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  const k = 'tools.items.device-information';
  const show = (v: Value): string =>
    'text' in v
      ? v.text
      : 'word' in v
        ? t(`${k}.values.${v.word}`)
        : t(`${k}.bits`, { bits: v.bits });

  return (
    <div className="max-w-2xl overflow-hidden rounded-lg border border-line bg-surface">
      {info.map((f) => {
        const value = show(f.value);
        return (
          <div
            key={f.id}
            className="group flex items-center gap-3 border-b border-line/60 px-3 py-2 last:border-0"
          >
            <span className="w-40 shrink-0 text-xs text-fg3">{t(`${k}.fields.${f.id}`)}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-sm text-fg">{value}</span>
            <CopyButton
              size="sm"
              variant="ghost"
              value={value}
              className="opacity-0 transition-opacity group-hover:opacity-100"
            />
          </div>
        );
      })}
    </div>
  );
}
