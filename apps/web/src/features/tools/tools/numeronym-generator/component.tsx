// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/numeronym-generator/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { SendToMenu } from '@/features/tools/components/tool/SendToMenu';
import { useI18n } from '@/lib/i18n/I18nContext';
import { numeronymText } from './logic';

export default function NumeronymGeneratorTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [input, setInput] = useState(initialInput ?? 'internationalization');
  const definition = getDefinition('numeronym-generator')!;

  const output = useMemo(() => numeronymText(input), [input]);

  return (
    <div className="max-w-2xl space-y-4">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-fg2">{t('tools.common.text')}</span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          spellCheck={false}
          className="h-11 w-full rounded-lg border border-line bg-surface px-3 text-sm text-fg focus:border-accent focus:outline-none"
        />
      </label>

      <div className="flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-3">
        <span className="min-w-0 flex-1 break-all font-mono text-lg text-fg">
          {output || <span className="text-fg3">—</span>}
        </span>
        <CopyButton size="sm" variant="ghost" value={output} />
        <SendToMenu source={definition} value={output} />
      </div>
    </div>
  );
}
