// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/escape/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { ToolEditor } from '@/features/tools/components/tool/ToolEditor';
import { ConverterLayout } from '@/features/tools/components/tool/ConverterLayout';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { SendToMenu } from '@/features/tools/components/tool/SendToMenu';
import { useI18n } from '@/lib/i18n/I18nContext';
import { escapeText, ESCAPE_TARGETS, unescapeText, type EscapeTarget } from './logic';

type Mode = 'escape' | 'unescape';

export default function EscapeTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [target, setTarget] = useState<EscapeTarget>('csharp');
  const [mode, setMode] = useState<Mode>('escape');
  const [input, setInput] = useState(initialInput ?? '');
  const definition = getDefinition('escape')!;

  const { output, error } = useMemo(() => {
    if (!input) return { output: '', error: null as string | null };
    try {
      return {
        output: mode === 'escape' ? escapeText(input, target) : unescapeText(input, target),
        error: null,
      };
    } catch (e) {
      return { output: '', error: e instanceof Error ? e.message : t('tools.common.error') };
    }
  }, [input, mode, target, t]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="inline-flex overflow-hidden rounded-md border border-line">
          {(['escape', 'unescape'] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`h-8 px-3 text-sm font-medium transition-colors ${
                mode === m ? 'bg-accent text-accent-fg' : 'bg-surface text-fg2 hover:bg-bg2'
              }`}
            >
              {t(`tools.items.escape.${m}`)}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-fg2">
          {t('tools.items.escape.target')}
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value as EscapeTarget)}
            className="h-8 rounded-md border border-line bg-surface px-2 text-sm outline-none"
          >
            {ESCAPE_TARGETS.map((x) => (
              <option key={x.id} value={x.id}>
                {t(`tools.items.escape.targets.${x.id}`)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <ConverterLayout
        input={
          <ToolEditor
            label={t('tools.common.input')}
            value={input}
            onChange={setInput}
            minRows={14}
          />
        }
        output={
          <ToolEditor
            label={t('tools.common.output')}
            value={error ? '' : output}
            readOnly
            minRows={14}
            footer={error ? <span className="text-danger">{error}</span> : undefined}
            actions={
              <>
                <CopyButton size="sm" variant="ghost" value={output} />
                <SendToMenu source={definition} value={output} />
              </>
            }
          />
        }
      />
    </div>
  );
}
