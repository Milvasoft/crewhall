// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/color-converter/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { useI18n } from '@/lib/i18n/I18nContext';
import { convertColor } from './logic';

type ColorError = 'empty' | 'unrecognized' | 'invalid';

/** Map the English messages thrown by logic.ts to dictionary keys. */
function errorKind(e: unknown): ColorError {
  const message = e instanceof Error ? e.message : '';
  if (/^enter a color/i.test(message)) return 'empty';
  if (/^unrecognized color/i.test(message)) return 'unrecognized';
  return 'invalid';
}

export default function ColorConverterTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [input, setInput] = useState(initialInput ?? '#1f6feb');

  const { forms, error } = useMemo(() => {
    if (!input.trim()) return { forms: null, error: null as ColorError | null };
    try {
      return { forms: convertColor(input), error: null };
    } catch (e) {
      return { forms: null, error: errorKind(e) };
    }
  }, [input]);

  const rows: [string, string][] = forms
    ? [
        ['HEX', forms.hex],
        ['RGB', forms.rgb],
        ['HSL', forms.hsl],
      ]
    : [];

  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex items-center gap-3">
        <input
          type="color"
          value={forms ? forms.hex.slice(0, 7) : '#000000'}
          onChange={(e) => setInput(e.target.value)}
          className="h-11 w-14 shrink-0 cursor-pointer rounded-md border border-line bg-surface"
          aria-label={t('tools.items.color-converter.picker')}
        />
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          spellCheck={false}
          placeholder="#1f6feb, rgb(31,111,235), hsl(215,83%,52%)"
          className="h-11 w-full rounded-lg border border-line bg-surface px-3 font-mono text-sm text-fg focus:border-accent focus:outline-none"
        />
      </div>

      {error ? (
        <p className="text-sm text-danger">{t(`tools.items.color-converter.${error}`)}</p>
      ) : forms ? (
        <div className="flex items-stretch gap-4">
          <div
            className="w-24 shrink-0 rounded-lg border border-line"
            style={{ backgroundColor: forms.hex }}
            aria-label={t('tools.items.color-converter.preview')}
          />
          <div className="flex-1 overflow-hidden rounded-lg border border-line bg-surface">
            {rows.map(([label, value]) => (
              <div
                key={label}
                className="group flex items-center gap-3 border-b border-line/60 px-3 py-2.5 last:border-0"
              >
                <span className="w-12 shrink-0 text-xs text-fg3">{label}</span>
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
        </div>
      ) : null}
    </div>
  );
}
