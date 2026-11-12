// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/unicode-inspector/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { ToolEditor } from '@/features/tools/components/tool/ToolEditor';
import { useI18n } from '@/lib/i18n/I18nContext';
import { inspect } from './logic';

export default function UnicodeInspectorTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [text, setText] = useState(initialInput ?? 'Aé😀');
  const chars = useMemo(() => inspect(text), [text]);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_1.4fr]">
      <ToolEditor label={t('tools.common.text')} value={text} onChange={setText} minRows={8} />

      <div className="self-start overflow-hidden rounded-lg border border-line bg-surface">
        <div className="grid grid-cols-[2rem_1fr_1fr_1.4fr_1fr] gap-2 border-b border-line bg-bg2 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg2">
          <span>{t('tools.items.unicode-inspector.colChar')}</span>
          <span>{t('tools.items.unicode-inspector.colCode')}</span>
          <span>Dec</span>
          <span>UTF-8</span>
          <span>{t('tools.items.unicode-inspector.colEntity')}</span>
        </div>
        <div className="max-h-[60vh] overflow-auto">
          {chars.length === 0 ? (
            <div className="px-3 py-3 text-sm text-fg3">
              {t('tools.items.unicode-inspector.empty')}
            </div>
          ) : (
            chars.map((c, i) => (
              <div
                key={i}
                className="grid grid-cols-[2rem_1fr_1fr_1.4fr_1fr] gap-2 border-b border-line/50 px-3 py-1 font-mono text-xs last:border-0"
              >
                <span className="text-fg">{/\s/.test(c.char) ? '␣' : c.char}</span>
                <span className="text-[var(--syntax-key)]">{c.hex}</span>
                <span className="text-fg2">{c.decimal}</span>
                <span className="text-fg2">{c.utf8}</span>
                <span className="text-fg2">{c.htmlEntity}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
