// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/code-formatter/component.tsx. See THIRD_PARTY.md.
import { useEffect, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { ToolEditor } from '@/features/tools/components/tool/ToolEditor';
import { SplitGrid } from '@/features/tools/components/tool/SplitGrid';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { SendToMenu } from '@/features/tools/components/tool/SendToMenu';
import { useI18n } from '@/lib/i18n/I18nContext';
import { formatCode, FORMATTER_LANGS, type FormatterLang } from './logic';

const EXAMPLES: Partial<Record<FormatterLang, string>> = {
  javascript: 'const x={a:1,b:[1,2,3]};function f(y){return y*2}',
  css: 'body{margin:0;color:red;font-size:14px}.a,.b{display:flex}',
  json: '{"a":1,"b":[1,2,3],"c":{"d":true}}',
};

interface FormatResult {
  output: string;
  /** Prettier's message, or null for a fallback text chosen at render. */
  error: string | null;
  failed: boolean;
}

export default function CodeFormatterTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [lang, setLang] = useState<FormatterLang>('javascript');
  const [input, setInput] = useState(initialInput ?? EXAMPLES.javascript ?? '');
  const [result, setResult] = useState<FormatResult>({ output: '', error: null, failed: false });
  const definition = getDefinition('code-formatter')!;

  useEffect(() => {
    if (!input.trim()) return;
    let cancelled = false;
    formatCode(input, lang)
      .then((r) => {
        if (!cancelled) setResult({ output: r, error: null, failed: false });
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setResult({
            output: '',
            error: e instanceof Error ? e.message : null,
            failed: true,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [input, lang]);

  // Empty input shows nothing, whatever the last async result was.
  const empty = !input.trim();
  const output = empty ? '' : result.output;
  const error =
    empty || !result.failed ? null : (result.error ?? t('tools.items.code-formatter.failed'));

  const editorLang = FORMATTER_LANGS[lang].editor;

  return (
    <div>
      <div className="mb-3 flex items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs text-fg2">
          {t('tools.items.code-formatter.language')}
          <select
            value={lang}
            onChange={(e) => {
              const l = e.target.value as FormatterLang;
              setLang(l);
              const example = EXAMPLES[l];
              if (example) setInput(example);
            }}
            className="h-8 rounded-md border border-line bg-surface px-2 text-sm outline-none"
          >
            {(Object.keys(FORMATTER_LANGS) as FormatterLang[]).map((l) => (
              <option key={l} value={l}>
                {FORMATTER_LANGS[l].label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <SplitGrid rightLabel={t('tools.items.code-formatter.formatted')}>
        <ToolEditor
          label={t('tools.common.input')}
          value={input}
          onChange={setInput}
          language={editorLang}
          lineNumbers
          minRows={20}
          footer={error ? <span className="text-danger">{error}</span> : undefined}
        />
        <ToolEditor
          label={t('tools.items.code-formatter.formatted')}
          value={error ? '' : output}
          readOnly
          language={editorLang}
          lineNumbers
          minRows={20}
          actions={
            <>
              <CopyButton size="sm" variant="ghost" value={output} />
              <SendToMenu source={definition} value={output} />
            </>
          }
        />
      </SplitGrid>
    </div>
  );
}
