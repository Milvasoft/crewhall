// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/email-normalizer/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState, type ReactNode } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { useI18n } from '@/lib/i18n/I18nContext';
import { normalizeEmail } from './logic';

export default function EmailNormalizerTool({ initialInput }: ToolComponentProps) {
  const { t, rich } = useI18n();
  const [input, setInput] = useState(initialInput ?? 'John.Doe+newsletter@gmail.com');

  // logic.ts throws a single English message ("Enter a valid email address.").
  const { result, invalid } = useMemo(() => {
    if (!input.trim()) return { result: null, invalid: false };
    try {
      return { result: normalizeEmail(input), invalid: false };
    } catch {
      return { result: null, invalid: true };
    }
  }, [input]);

  return (
    <div className="max-w-2xl space-y-4">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-fg2">
          {t('tools.items.email-normalizer.address')}
        </span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          className="h-11 w-full rounded-lg border border-line bg-surface px-3 font-mono text-sm text-fg focus:border-accent focus:outline-none"
        />
      </label>

      {invalid ? (
        <p className="text-sm text-danger">{t('tools.items.email-normalizer.invalid')}</p>
      ) : result ? (
        <div className="flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-3">
          <span className="w-24 shrink-0 text-xs text-fg3">
            {t('tools.items.email-normalizer.normalized')}
          </span>
          <span className="min-w-0 flex-1 break-all font-mono text-base text-fg">
            {result.normalized}
          </span>
          <CopyButton size="sm" variant="ghost" value={result.normalized} />
        </div>
      ) : null}

      <p className="text-xs text-fg3">
        {rich('tools.items.email-normalizer.help', {
          code: (c: ReactNode[]) => <code>{c}</code>,
        })}
      </p>
    </div>
  );
}
