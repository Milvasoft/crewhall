// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/base64/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { ToolEditor } from '@/features/tools/components/tool/ToolEditor';
import { ConverterLayout } from '@/features/tools/components/tool/ConverterLayout';
import { Button } from '@/features/tools/components/ui/Button';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { SendToMenu } from '@/features/tools/components/tool/SendToMenu';
import { useI18n } from '@/lib/i18n/I18nContext';
import { decodeBase64, encodeBase64 } from './logic';

type Mode = 'encode' | 'decode';

export default function Base64Tool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>('encode');
  const [input, setInput] = useState(initialInput ?? '');
  const [urlSafe, setUrlSafe] = useState(false);
  const definition = getDefinition('base64')!;

  const { output, error } = useMemo(() => {
    if (!input) return { output: '', error: null as string | null };
    try {
      return {
        output: mode === 'encode' ? encodeBase64(input, { urlSafe }) : decodeBase64(input),
        error: null,
      };
    } catch (e) {
      return { output: '', error: e instanceof Error ? e.message : 'Failed.' };
    }
  }, [input, mode, urlSafe]);

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
              {t(`tools.items.base64.${m}`)}
            </button>
          ))}
        </div>

        {mode === 'encode' && (
          <label className="flex items-center gap-1.5 text-xs text-fg2">
            <input
              type="checkbox"
              checked={urlSafe}
              onChange={(e) => setUrlSafe(e.target.checked)}
            />
            {t('tools.items.base64.urlSafe')}
          </label>
        )}
      </div>

      <ConverterLayout
        input={
          <ToolEditor
            label={mode === 'encode' ? t('tools.common.text') : 'Base64'}
            value={input}
            onChange={setInput}
            placeholder={
              mode === 'encode'
                ? t('tools.items.base64.encodePlaceholder')
                : t('tools.items.base64.decodePlaceholder')
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
            label={mode === 'encode' ? 'Base64' : t('tools.common.text')}
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
