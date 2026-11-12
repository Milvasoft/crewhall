// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/ascii-text-drawer/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { useI18n } from '@/lib/i18n/I18nContext';
import { FONTS, renderAscii } from './logic';

export default function AsciiTextDrawerTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [input, setInput] = useState(initialInput ?? 'Crewhall');
  const [font, setFont] = useState('Standard');
  const [width, setWidth] = useState(80);

  const { output, failed } = useMemo(() => {
    if (!input) return { output: '', failed: false };
    try {
      return { output: renderAscii(input, font, width), failed: false };
    } catch {
      return { output: '', failed: true };
    }
  }, [input, font, width]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs font-medium text-fg2">
            {t('tools.items.ascii-text-drawer.yourText')}
          </span>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            spellCheck={false}
            className="h-10 w-full rounded-lg border border-line bg-surface px-3 text-sm text-fg focus:border-accent focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg2">
            {t('tools.items.ascii-text-drawer.font')}
          </span>
          <select
            value={font}
            onChange={(e) => setFont(e.target.value)}
            className="h-10 w-40 rounded-lg border border-line bg-surface px-2 text-sm text-fg focus:border-accent focus:outline-none"
          >
            {FONTS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg2">
            {t('tools.items.ascii-text-drawer.width')}
          </span>
          <input
            type="number"
            min={20}
            max={300}
            value={width}
            onChange={(e) => setWidth(Math.max(20, Math.min(300, Number(e.target.value) || 80)))}
            className="h-10 w-24 rounded-lg border border-line bg-surface px-3 font-mono text-sm text-fg focus:border-accent focus:outline-none"
          />
        </label>
      </div>

      {failed ? (
        <p className="text-sm text-danger">{t('tools.items.ascii-text-drawer.renderFailed')}</p>
      ) : (
        <div className="relative overflow-hidden rounded-lg border border-line bg-surface">
          <div className="absolute right-2 top-2 z-10">
            <CopyButton size="sm" variant="secondary" value={output} />
          </div>
          <pre className="overflow-auto px-4 py-3 font-mono text-xs leading-tight text-fg">
            {output || ' '}
          </pre>
        </div>
      )}
    </div>
  );
}
