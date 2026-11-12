// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/string-obfuscator/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { SendToMenu } from '@/features/tools/components/tool/SendToMenu';
import { useI18n } from '@/lib/i18n/I18nContext';
import { DEFAULT_OBFUSCATE, obfuscate, type ObfuscateOptions } from './logic';

export default function StringObfuscatorTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [input, setInput] = useState(initialInput ?? 'my-secret-token-1234');
  const [opts, setOpts] = useState<ObfuscateOptions>(DEFAULT_OBFUSCATE);
  const definition = getDefinition('string-obfuscator')!;

  const output = useMemo(() => obfuscate(input, opts), [input, opts]);
  const set = <K extends keyof ObfuscateOptions>(k: K, v: ObfuscateOptions[K]) =>
    setOpts((o) => ({ ...o, [k]: v }));

  return (
    <div className="max-w-2xl space-y-4">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-fg2">{t('tools.common.text')}</span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          spellCheck={false}
          className="h-11 w-full rounded-lg border border-line bg-surface px-3 font-mono text-sm text-fg focus:border-accent focus:outline-none"
        />
      </label>

      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg2">
            {t('tools.items.string-obfuscator.keepFirst')}
          </span>
          <input
            type="number"
            min={0}
            value={opts.keepFirst}
            onChange={(e) => set('keepFirst', Math.max(0, Number(e.target.value) || 0))}
            className="h-9 w-20 rounded-md border border-line bg-surface px-2 font-mono text-sm text-fg focus:border-accent focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg2">
            {t('tools.items.string-obfuscator.keepLast')}
          </span>
          <input
            type="number"
            min={0}
            value={opts.keepLast}
            onChange={(e) => set('keepLast', Math.max(0, Number(e.target.value) || 0))}
            className="h-9 w-20 rounded-md border border-line bg-surface px-2 font-mono text-sm text-fg focus:border-accent focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg2">
            {t('tools.items.string-obfuscator.maskChar')}
          </span>
          <input
            value={opts.maskChar}
            onChange={(e) => set('maskChar', e.target.value.slice(0, 1) || '*')}
            className="h-9 w-16 rounded-md border border-line bg-surface px-2 text-center font-mono text-sm text-fg focus:border-accent focus:outline-none"
          />
        </label>
        <label className="flex h-9 items-center gap-1.5 text-sm text-fg2">
          <input
            type="checkbox"
            checked={opts.keepSpaces}
            onChange={(e) => set('keepSpaces', e.target.checked)}
          />
          {t('tools.items.string-obfuscator.keepSpaces')}
        </label>
      </div>

      <div className="flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-3">
        <span className="min-w-0 flex-1 break-all font-mono text-base text-fg">
          {output || <span className="text-fg3">—</span>}
        </span>
        <CopyButton size="sm" variant="ghost" value={output} />
        <SendToMenu source={definition} value={output} />
      </div>
    </div>
  );
}
