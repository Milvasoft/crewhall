// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/case-converter/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import { SplitGrid } from '@/features/tools/components/tool/SplitGrid';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { ToolEditor } from '@/features/tools/components/tool/ToolEditor';
import { Button } from '@/features/tools/components/ui/Button';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { SendToMenu } from '@/features/tools/components/tool/SendToMenu';
import { useI18n } from '@/lib/i18n/I18nContext';
import { CASE_MODES, convertCase, type CaseMode } from './logic';

// Modes whose label is prose; the rest (camelCase, snake_case…) are identifiers and stay as is.
const TRANSLATED_MODES = ['title', 'sentence', 'lower', 'upper'] as const;
type TranslatedMode = (typeof TRANSLATED_MODES)[number];
const isTranslated = (mode: CaseMode): mode is TranslatedMode =>
  (TRANSLATED_MODES as readonly string[]).includes(mode);

export default function CaseConverterTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [input, setInput] = useState(initialInput ?? 'helloWorld example_text');
  const definition = getDefinition('case-converter')!;

  const results = useMemo(
    () => CASE_MODES.map((m) => ({ ...m, value: convertCase(input, m.mode) })),
    [input],
  );

  return (
    <SplitGrid leftLabel={t('tools.common.text')} rightLabel={t('tools.common.result')}>
      <ToolEditor
        label={t('tools.common.text')}
        value={input}
        onChange={setInput}
        minRows={8}
        actions={
          <Button size="sm" variant="ghost" onClick={() => setInput('')}>
            {t('tools.common.clear')}
          </Button>
        }
      />

      <div className="self-start overflow-hidden rounded-lg border border-line bg-surface">
        {results.map((r) => (
          <div
            key={r.mode}
            className="group flex items-center gap-3 border-b border-line/60 px-3 py-2 last:border-0"
          >
            <span className="w-32 shrink-0 text-xs text-fg3">
              {isTranslated(r.mode) ? t(`tools.items.case-converter.modes.${r.mode}`) : r.label}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-sm text-fg">
              {r.value || '—'}
            </span>
            <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
              <CopyButton size="sm" variant="ghost" value={r.value} />
              <SendToMenu source={definition} value={r.value} />
            </div>
          </div>
        ))}
      </div>
    </SplitGrid>
  );
}
