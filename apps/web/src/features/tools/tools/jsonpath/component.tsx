// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/jsonpath/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { ToolEditor } from '@/features/tools/components/tool/ToolEditor';
import { SplitGrid } from '@/features/tools/components/tool/SplitGrid';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { SendToMenu } from '@/features/tools/components/tool/SendToMenu';
import { useI18n } from '@/lib/i18n/I18nContext';
import { queryJsonPath } from './logic';

const EXAMPLE = JSON.stringify(
  {
    store: {
      book: [
        { title: 'T1', author: 'Ada', price: 10 },
        { title: 'T2', author: 'Grace', price: 20 },
      ],
      bicycle: { color: 'red', price: 100 },
    },
  },
  null,
  2,
);

export default function JsonPathTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [json, setJson] = useState(initialInput ?? EXAMPLE);
  const [path, setPath] = useState('$.store.book[*].author');
  const definition = getDefinition('jsonpath')!;

  const { result, error } = useMemo(() => {
    if (!json.trim()) return { result: null, error: null as string | null };
    try {
      return { result: queryJsonPath(json, path), error: null };
    } catch (e) {
      return {
        result: null,
        error: e instanceof Error ? e.message : t('tools.items.jsonpath.invalid'),
      };
    }
  }, [json, path, t]);

  const outputJson = result ? JSON.stringify(result.values, null, 2) : '';

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <span className="font-mono text-sm text-fg3">JSONPath</span>
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          spellCheck={false}
          placeholder="$.store.book[*].author"
          aria-label={t('tools.items.jsonpath.queryLabel')}
          className="h-9 flex-1 rounded-md border border-line bg-surface px-3 font-mono text-sm text-fg outline-none focus:border-accent"
        />
        {result && (
          <span className="text-xs text-fg3">
            {t('tools.items.jsonpath.matchCount', { count: result.values.length })}
          </span>
        )}
      </div>

      <SplitGrid leftLabel="JSON" rightLabel={t('tools.items.jsonpath.matches')}>
        <ToolEditor
          label="JSON"
          value={json}
          onChange={setJson}
          language="json"
          lineNumbers
          minRows={20}
          footer={error ? <span className="text-danger">{error}</span> : undefined}
        />
        <ToolEditor
          label={t('tools.items.jsonpath.matches')}
          value={outputJson}
          readOnly
          language="json"
          lineNumbers
          minRows={20}
          actions={
            <>
              <CopyButton size="sm" variant="ghost" value={outputJson} />
              <SendToMenu source={definition} value={outputJson} />
            </>
          }
        />
      </SplitGrid>

      {result && result.paths.length > 0 && (
        <div className="mt-3 overflow-hidden rounded-lg border border-line bg-surface">
          <div className="border-b border-line bg-bg2 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-fg2">
            {t('tools.items.jsonpath.paths')}
          </div>
          <div className="max-h-40 overflow-auto">
            {result.paths.map((p, i) => (
              <div
                key={i}
                className="border-b border-line/50 px-3 py-1 font-mono text-xs text-fg2 last:border-0"
              >
                {p}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
