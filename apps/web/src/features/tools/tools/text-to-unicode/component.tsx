// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/text-to-unicode/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { ToolEditor } from '@/features/tools/components/tool/ToolEditor';
import { ConverterLayout } from '@/features/tools/components/tool/ConverterLayout';
import { Button } from '@/features/tools/components/ui/Button';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { SendToMenu } from '@/features/tools/components/tool/SendToMenu';
import { useI18n } from '@/lib/i18n/I18nContext';
import { UNICODE_FORMATS, decodeUnicode, encodeUnicode, type UnicodeFormat } from './logic';

type Mode = 'encode' | 'decode';

export default function TextToUnicodeTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>('encode');
  const [format, setFormat] = useState<UnicodeFormat>('js');
  const [input, setInput] = useState(initialInput ?? 'Hello 😀');
  const definition = getDefinition('text-to-unicode')!;

  const { output, error } = useMemo(() => {
    if (!input.trim()) return { output: '', error: null as string | null };
    try {
      return {
        output: mode === 'encode' ? encodeUnicode(input, format) : decodeUnicode(input),
        error: null,
      };
    } catch (e) {
      return { output: '', error: e instanceof Error ? e.message : t('tools.common.error') };
    }
  }, [input, mode, format, t]);

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
                ? t('tools.items.text-to-unicode.textToUnicode')
                : t('tools.items.text-to-unicode.unicodeToText')}
            </button>
          ))}
        </div>
        {mode === 'encode' && (
          <label className="flex items-center gap-1.5 text-xs text-fg2">
            {t('tools.items.text-to-unicode.formatLabel')}
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value as UnicodeFormat)}
              className="h-8 rounded-md border border-line bg-surface px-2 text-sm text-fg focus:border-accent focus:outline-none"
            >
              {UNICODE_FORMATS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <ConverterLayout
        input={
          <ToolEditor
            label={
              mode === 'encode' ? t('tools.common.text') : t('tools.items.text-to-unicode.escapes')
            }
            value={input}
            onChange={setInput}
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
            label={
              mode === 'encode' ? t('tools.items.text-to-unicode.escapes') : t('tools.common.text')
            }
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
