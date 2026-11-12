// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/binary-text/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { ToolEditor } from '@/features/tools/components/tool/ToolEditor';
import { ConverterLayout } from '@/features/tools/components/tool/ConverterLayout';
import { Button } from '@/features/tools/components/ui/Button';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { SendToMenu } from '@/features/tools/components/tool/SendToMenu';
import { useI18n } from '@/lib/i18n/I18nContext';
import { binaryToText, textToBinary } from './logic';

type Mode = 'encode' | 'decode';
type ErrorKind = 'invalidChars' | 'bitCount' | 'other';

// logic.ts throws English messages (its tests read them); map them to dictionary keys here.
function errorKind(e: unknown): ErrorKind {
  const message = e instanceof Error ? e.message : '';
  if (message.includes('multiple of 8')) return 'bitCount';
  if (message.includes('only contain')) return 'invalidChars';
  return 'other';
}

export default function BinaryTextTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>('encode');
  const [input, setInput] = useState(initialInput ?? 'Hi');
  const definition = getDefinition('binary-text')!;

  const { output, error } = useMemo(() => {
    if (!input.trim()) return { output: '', error: null as ErrorKind | null };
    try {
      return {
        output: mode === 'encode' ? textToBinary(input) : binaryToText(input),
        error: null,
      };
    } catch (e) {
      return { output: '', error: errorKind(e) };
    }
  }, [input, mode]);

  const errorText =
    error === null
      ? null
      : error === 'other'
        ? t('tools.common.error')
        : t(`tools.items.binary-text.${error}`);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="inline-flex overflow-hidden rounded-md border border-line">
          {(['encode', 'decode'] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`h-8 px-3 text-sm font-medium transition-colors ${
                mode === m ? 'bg-accent text-accent-fg' : 'bg-surface text-fg2 hover:bg-bg2'
              }`}
            >
              {m === 'encode'
                ? t('tools.items.binary-text.textToBinary')
                : t('tools.items.binary-text.binaryToText')}
            </button>
          ))}
        </div>
      </div>

      <ConverterLayout
        input={
          <ToolEditor
            label={mode === 'encode' ? t('tools.common.text') : t('tools.items.binary-text.binary')}
            value={input}
            onChange={setInput}
            placeholder={
              mode === 'encode'
                ? t('tools.items.binary-text.encodePlaceholder')
                : '01001000 01101001…'
            }
            minRows={14}
            actions={
              <Button size="sm" variant="ghost" onClick={() => setInput('')}>
                {t('tools.common.clear')}
              </Button>
            }
          />
        }
        output={
          <ToolEditor
            label={mode === 'encode' ? t('tools.items.binary-text.binary') : t('tools.common.text')}
            value={errorText ? '' : output}
            readOnly
            minRows={14}
            footer={errorText ? <span className="text-danger">{errorText}</span> : undefined}
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
