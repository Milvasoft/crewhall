// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/slugify-string/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { SendToMenu } from '@/features/tools/components/tool/SendToMenu';
import { useI18n } from '@/lib/i18n/I18nContext';
import { slugify } from './logic';

export default function SlugifyStringTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [input, setInput] = useState(initialInput ?? 'Hello World! Àéîõü');
  const [separator, setSeparator] = useState('-');
  const [lowercase, setLowercase] = useState(true);
  const definition = getDefinition('slugify-string')!;

  const slug = useMemo(
    () => slugify(input, { separator, lowercase }),
    [input, separator, lowercase],
  );

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

      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm text-fg2">
          {t('tools.items.slugify-string.separator')}
          <select
            value={separator}
            onChange={(e) => setSeparator(e.target.value)}
            className="h-8 rounded-md border border-line bg-surface px-2 text-sm text-fg focus:border-accent focus:outline-none"
          >
            <option value="-">{t('tools.items.slugify-string.hyphen')}</option>
            <option value="_">{t('tools.items.slugify-string.underscore')}</option>
            <option value=".">{t('tools.items.slugify-string.dot')}</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-sm text-fg2">
          <input
            type="checkbox"
            checked={lowercase}
            onChange={(e) => setLowercase(e.target.checked)}
          />
          {t('tools.items.slugify-string.lowercase')}
        </label>
      </div>

      <div className="flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-3">
        <span className="min-w-0 flex-1 break-all font-mono text-base text-fg">
          {slug || <span className="text-fg3">—</span>}
        </span>
        <CopyButton size="sm" variant="ghost" value={slug} />
        <SendToMenu source={definition} value={slug} />
      </div>
    </div>
  );
}
