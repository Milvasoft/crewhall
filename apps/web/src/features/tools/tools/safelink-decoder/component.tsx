// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/safelink-decoder/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { SendToMenu } from '@/features/tools/components/tool/SendToMenu';
import { useI18n } from '@/lib/i18n/I18nContext';
import { decodeSafelink } from './logic';

type DecodeError = 'empty' | 'notUrl' | 'notFound' | 'failed';

/** Map the English messages thrown by logic.ts to dictionary keys. */
function errorKind(e: unknown): DecodeError {
  const message = e instanceof Error ? e.message : '';
  if (/^paste a wrapped link/i.test(message)) return 'empty';
  if (/doesn't look like a url/i.test(message)) return 'notUrl';
  if (/^no wrapped url found/i.test(message)) return 'notFound';
  return 'failed';
}

export default function SafelinkDecoderTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [input, setInput] = useState(initialInput ?? '');
  const definition = getDefinition('safelink-decoder')!;

  const { output, error } = useMemo(() => {
    if (!input.trim()) return { output: '', error: null as DecodeError | null };
    try {
      return { output: decodeSafelink(input), error: null };
    } catch (e) {
      return { output: '', error: errorKind(e) };
    }
  }, [input]);

  return (
    <div className="max-w-2xl space-y-4">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-fg2">
          {t('tools.items.safelink-decoder.wrapped')}
        </span>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          spellCheck={false}
          rows={3}
          placeholder="https://…safelinks.protection.outlook.com/?url=…"
          className="w-full resize-y rounded-lg border border-line bg-surface px-3 py-2 font-mono text-sm text-fg focus:border-accent focus:outline-none"
        />
      </label>

      {error ? (
        <p className="text-sm text-danger">{t(`tools.items.safelink-decoder.errors.${error}`)}</p>
      ) : output ? (
        <div className="flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-3">
          <span className="w-24 shrink-0 text-xs text-fg3">
            {t('tools.items.safelink-decoder.destination')}
          </span>
          <span className="min-w-0 flex-1 break-all font-mono text-sm text-fg">{output}</span>
          <CopyButton size="sm" variant="ghost" value={output} />
          <SendToMenu source={definition} value={output} />
        </div>
      ) : null}

      <p className="text-xs text-fg3">{t('tools.items.safelink-decoder.warning')}</p>
    </div>
  );
}
