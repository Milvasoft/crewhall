// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/components/tool/BiConverter.tsx. See THIRD_PARTY.md.
import { useI18n } from '@/lib/i18n/I18nContext';
import { useState } from 'react';
import type { ToolDefinition } from '@/features/tools/lib/tool-sdk';
import { ToolEditor } from '@/features/tools/components/tool/ToolEditor';
import { ConverterLayout } from '@/features/tools/components/tool/ConverterLayout';
import { Button } from '@/features/tools/components/ui/Button';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { SendToMenu } from '@/features/tools/components/tool/SendToMenu';
import { useWorkerTransform } from '@/features/tools/lib/worker/useWorkerTransform';
import type { EditorLanguage } from '@/features/tools/components/tool/editor/cmLanguages';

/** Request shape the optional converter worker receives. */
export interface BiConverterRequest {
  dir: 'forward' | 'backward';
  input: string;
}

export interface BiConverterProps {
  definition: ToolDefinition;
  leftLabel: string;
  rightLabel: string;
  leftLanguage?: EditorLanguage;
  rightLanguage?: EditorLanguage;
  /** left → right */
  forward: (text: string) => string;
  /** right → left */
  backward: (text: string) => string;
  example?: string;
  initialInput?: string;
  /**
   * Optional dedicated worker; when provided, large inputs are converted off
   * the main thread. The worker must handle a `BiConverterRequest`.
   */
  createWorker?: () => Worker;
}

/**
 * Generic two-way converter UI shared by JSON↔YAML/XML/CSV and similar tools.
 * Handles direction toggle, live conversion with error capture, swap, copy and
 * Send-To, so each converter tool only supplies its pure forward/backward
 * functions and labels.
 */
export function BiConverter({
  definition,
  leftLabel,
  rightLabel,
  leftLanguage,
  rightLanguage,
  forward,
  backward,
  example,
  initialInput,
  createWorker,
}: BiConverterProps) {
  const { t } = useI18n();
  const [dir, setDir] = useState<'forward' | 'backward'>('forward');
  const [input, setInput] = useState(initialInput ?? example ?? '');

  const inLabel = dir === 'forward' ? leftLabel : rightLabel;
  const outLabel = dir === 'forward' ? rightLabel : leftLabel;
  const inLang = dir === 'forward' ? leftLanguage : rightLanguage;
  const outLang = dir === 'forward' ? rightLanguage : leftLanguage;

  const { result, error } = useWorkerTransform<BiConverterRequest, string>({
    createWorker,
    buildRequest: () => ({ dir, input }),
    compute: (r) =>
      !r.input.trim() ? '' : r.dir === 'forward' ? forward(r.input) : backward(r.input),
    size: input.length,
    deps: [input, dir],
  });
  const output = result ?? '';

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="inline-flex overflow-hidden rounded-md border border-line">
          <button
            onClick={() => setDir('forward')}
            className={`h-8 px-3 text-sm font-medium transition-colors ${
              dir === 'forward' ? 'bg-accent text-accent-fg' : 'bg-surface text-fg2 hover:bg-bg2'
            }`}
          >
            {leftLabel} → {rightLabel}
          </button>
          <button
            onClick={() => setDir('backward')}
            className={`h-8 px-3 text-sm font-medium transition-colors ${
              dir === 'backward' ? 'bg-accent text-accent-fg' : 'bg-surface text-fg2 hover:bg-bg2'
            }`}
          >
            {rightLabel} → {leftLabel}
          </button>
        </div>
        {example && (
          <Button size="sm" variant="ghost" onClick={() => setInput(example)}>
            {t('tools.common.sample')}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => setInput('')}>
          {t('tools.common.clear')}
        </Button>
      </div>

      <ConverterLayout
        leftLabel={inLabel}
        rightLabel={outLabel}
        input={
          <ToolEditor
            label={inLabel}
            value={input}
            onChange={setInput}
            language={inLang}
            lineNumbers
            minRows={18}
            footer={error ? <span className="text-danger">{error}</span> : undefined}
          />
        }
        output={
          <ToolEditor
            label={outLabel}
            value={error ? '' : output}
            readOnly
            language={outLang}
            lineNumbers
            minRows={18}
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
