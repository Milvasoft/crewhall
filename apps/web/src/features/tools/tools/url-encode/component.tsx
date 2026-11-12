// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/url-encode/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { ToolEditor } from '@/features/tools/components/tool/ToolEditor';
import { ConverterLayout } from '@/features/tools/components/tool/ConverterLayout';
import { Button } from '@/features/tools/components/ui/Button';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { SendToMenu } from '@/features/tools/components/tool/SendToMenu';
import { useI18n } from '@/lib/i18n/I18nContext';
import { decodeUrl, encodeUrl, type UrlEncodeScope } from './logic';

type Mode = 'encode' | 'decode';
type EncodeError = 'malformed' | 'failed';

export default function UrlEncodeTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>('encode');
  const [scope, setScope] = useState<UrlEncodeScope>('component');
  const [input, setInput] = useState(initialInput ?? '');
  const definition = getDefinition('url-encode')!;

  const { output, error } = useMemo((): { output: string; error: EncodeError | null } => {
    if (!input) return { output: '', error: null };
    try {
      return {
        output: mode === 'encode' ? encodeUrl(input, scope) : decodeUrl(input, scope),
        error: null,
      };
    } catch (e) {
      // decodeURI(Component) throws URIError for a broken %-sequence.
      return { output: '', error: e instanceof URIError ? 'malformed' : 'failed' };
    }
  }, [input, mode, scope]);

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
              {t(`tools.items.url-encode.${m}`)}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-fg2">
          {t('tools.items.url-encode.scope')}
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as UrlEncodeScope)}
            className="h-8 rounded-md border border-line bg-surface px-2 text-sm outline-none"
          >
            <option value="component">{t('tools.items.url-encode.component')}</option>
            <option value="full">{t('tools.items.url-encode.full')}</option>
          </select>
        </label>
      </div>

      <ConverterLayout
        input={
          <ToolEditor
            label={mode === 'encode' ? t('tools.common.text') : t('tools.items.url-encode.encoded')}
            value={input}
            onChange={setInput}
            minRows={12}
            actions={
              <Button size="sm" variant="ghost" onClick={() => setInput('')}>
                {t('tools.common.clear')}
              </Button>
            }
          />
        }
        output={
          <ToolEditor
            label={mode === 'encode' ? t('tools.items.url-encode.encoded') : t('tools.common.text')}
            value={error ? '' : output}
            readOnly
            minRows={12}
            footer={
              error ? (
                <span className="text-danger">{t(`tools.items.url-encode.${error}`)}</span>
              ) : undefined
            }
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
