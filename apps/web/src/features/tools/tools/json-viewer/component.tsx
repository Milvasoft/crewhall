// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/json-viewer/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { ToolEditor } from '@/features/tools/components/tool/ToolEditor';
import { SplitGrid } from '@/features/tools/components/tool/SplitGrid';
import { Button } from '@/features/tools/components/ui/Button';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { SendToMenu } from '@/features/tools/components/tool/SendToMenu';
import { useI18n } from '@/lib/i18n/I18nContext';
import { JsonTree } from './JsonTree';
import { computeStats, formatJson, minifyJson, parseJson, type JsonError } from './logic';

const EXAMPLE =
  '{"id":123,"name":"Ada","active":true,"roles":["admin","user"],"meta":{"created":"2024-01-01","tags":[]}}';

export default function JsonViewerTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [input, setInputRaw] = useState(initialInput ?? '');
  const [indent, setIndentRaw] = useState<number>(2);
  const [sortKeys, setSortKeysRaw] = useState(false);
  // The output is derived from the input; Minify switches it to the one-line form until the
  // input or the format options change again (then it auto-formats, as before).
  const [minified, setMinified] = useState(false);
  const [view, setView] = useState<'formatted' | 'tree'>('formatted');
  const definition = getDefinition('json-viewer')!;

  const setInput = (v: string) => {
    setInputRaw(v);
    setMinified(false);
  };
  const setIndent = (v: number) => {
    setIndentRaw(v);
    setMinified(false);
  };
  const setSortKeys = (v: boolean) => {
    setSortKeysRaw(v);
    setMinified(false);
  };

  const parsed = useMemo(() => parseJson(input), [input]);
  const stats = useMemo(() => (parsed.ok ? computeStats(parsed.value) : null), [parsed]);

  const { output, error } = useMemo(() => {
    if (!input.trim()) return { output: '', error: null as string | null };
    if (!parsed.ok) {
      const e: JsonError = parsed.error;
      return {
        output: '',
        error:
          e.line !== undefined
            ? t('tools.items.json-viewer.errorAt', {
                error: e.message,
                n: e.line,
                column: e.column,
              })
            : e.message,
      };
    }
    return {
      output: minified ? minifyJson(input) : formatJson(input, { indent, sortKeys }),
      error: null,
    };
  }, [input, parsed, minified, indent, sortKeys, t]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Button variant="primary" size="sm" onClick={() => setMinified(false)}>
          {t('tools.items.json-viewer.beautify')}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setMinified(true)}>
          {t('tools.common.minify')}
        </Button>
        <label className="flex items-center gap-1.5 text-xs text-fg2">
          {t('tools.items.json-viewer.indent')}
          <select
            value={indent}
            onChange={(e) => setIndent(Number(e.target.value))}
            className="h-7 rounded-md border border-line bg-surface px-1.5 text-sm outline-none"
          >
            <option value={2}>{t('tools.items.json-viewer.spaces', { count: 2 })}</option>
            <option value={4}>{t('tools.items.json-viewer.spaces', { count: 4 })}</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-fg2">
          <input
            type="checkbox"
            checked={sortKeys}
            onChange={(e) => setSortKeys(e.target.checked)}
          />
          {t('tools.items.json-viewer.sortKeys')}
        </label>

        <div className="inline-flex overflow-hidden rounded-md border border-line">
          {(['formatted', 'tree'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`h-7 px-2.5 text-xs font-medium capitalize transition-colors ${
                view === v ? 'bg-accent text-accent-fg' : 'bg-surface text-fg2 hover:bg-bg2'
              }`}
            >
              {t(`tools.items.json-viewer.${v}`)}
            </button>
          ))}
        </div>

        {stats && (
          <span className="ml-auto text-xs text-fg3">
            {[
              t('tools.items.json-viewer.stats.objects', { count: stats.objects }),
              t('tools.items.json-viewer.stats.arrays', { count: stats.arrays }),
              t('tools.items.json-viewer.stats.keys', { count: stats.keys }),
              t('tools.items.json-viewer.stats.depth', { n: stats.depth }),
            ].join(' · ')}
          </span>
        )}
      </div>

      <SplitGrid
        leftLabel={t('tools.common.input')}
        rightLabel={
          view === 'tree'
            ? t('tools.items.json-viewer.tree')
            : t('tools.items.json-viewer.formatted')
        }
      >
        <ToolEditor
          label={t('tools.common.input')}
          value={input}
          onChange={setInput}
          placeholder={t('tools.items.json-viewer.placeholder')}
          language="json"
          lineNumbers
          minRows={20}
          footer={error ? <span className="text-danger">{error}</span> : undefined}
          actions={
            <>
              <Button size="sm" variant="ghost" onClick={() => setInput(EXAMPLE)}>
                {t('tools.common.sample')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setInput('')}>
                {t('tools.common.clear')}
              </Button>
            </>
          }
        />
        {view === 'tree' && parsed.ok ? (
          <JsonTree value={parsed.value} />
        ) : view === 'tree' ? (
          <div className="flex items-center justify-center rounded-lg border border-line bg-surface p-6 text-sm text-fg3">
            {t('tools.items.json-viewer.treeEmpty')}
          </div>
        ) : (
          <ToolEditor
            label={t('tools.items.json-viewer.formatted')}
            value={output}
            readOnly
            language="json"
            lineNumbers
            minRows={20}
            actions={
              <>
                <CopyButton size="sm" variant="ghost" value={output} />
                <SendToMenu source={definition} value={output} />
              </>
            }
          />
        )}
      </SplitGrid>
    </div>
  );
}
