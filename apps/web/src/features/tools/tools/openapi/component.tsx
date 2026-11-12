// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/openapi/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import { SplitGrid } from '@/features/tools/components/tool/SplitGrid';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { ToolEditor } from '@/features/tools/components/tool/ToolEditor';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { SendToMenu } from '@/features/tools/components/tool/SendToMenu';
import { useI18n } from '@/lib/i18n/I18nContext';
import { overview, parseSpec, schemasToCsharp } from './logic';

const EXAMPLE = JSON.stringify(
  {
    openapi: '3.0.0',
    info: { title: 'Sample API', version: '1.0.0' },
    paths: {
      '/users': { get: { summary: 'List users' }, post: { summary: 'Create user' } },
      '/users/{id}': { get: { summary: 'Get user' }, delete: { summary: 'Delete user' } },
    },
    components: {
      schemas: {
        User: {
          type: 'object',
          properties: {
            id: { type: 'integer', format: 'int64' },
            name: { type: 'string' },
            email: { type: 'string' },
          },
        },
      },
    },
  },
  null,
  2,
);

const METHOD_COLOR: Record<string, string> = {
  GET: 'text-success',
  POST: 'text-accent-text',
  PUT: 'text-warning',
  PATCH: 'text-warning',
  DELETE: 'text-danger',
};

export default function OpenApiTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [input, setInput] = useState(initialInput ?? EXAMPLE);
  const [tab, setTab] = useState<'overview' | 'csharp'>('overview');
  const definition = getDefinition('openapi')!;

  const { data, csharp, error } = useMemo(() => {
    if (!input.trim()) return { data: null, csharp: '', error: null as string | null };
    try {
      const spec = parseSpec(input);
      let cs = '';
      try {
        cs = schemasToCsharp(spec);
      } catch {
        cs = `// ${t('tools.items.openapi.noSchemas')}`;
      }
      return { data: overview(spec), csharp: cs, error: null };
    } catch (e) {
      // logic.ts throws English; its own message gets a key, parser messages stay as they are.
      const message = e instanceof Error ? e.message : '';
      return {
        data: null,
        csharp: '',
        error:
          message === 'Not a valid JSON/YAML spec.'
            ? t('tools.items.openapi.notSpec')
            : message || t('tools.items.openapi.invalid'),
      };
    }
  }, [input, t]);

  return (
    <SplitGrid>
      <ToolEditor
        label={t('tools.items.openapi.editorLabel')}
        value={input}
        onChange={setInput}
        language="json"
        lineNumbers
        minRows={22}
        footer={error ? <span className="text-danger">{error}</span> : undefined}
      />

      <div className="flex min-h-0 flex-col gap-2">
        <div className="inline-flex overflow-hidden rounded-md border border-line">
          {(['overview', 'csharp'] as const).map((id) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`h-8 px-3 text-sm font-medium transition-colors ${
                tab === id ? 'bg-accent text-accent-fg' : 'bg-surface text-fg2 hover:bg-bg2'
              }`}
            >
              {t(`tools.items.openapi.${id}`)}
            </button>
          ))}
        </div>

        {tab === 'overview' ? (
          data && (
            <div className="overflow-auto rounded-lg border border-line bg-surface">
              <div className="border-b border-line px-3 py-2">
                <div className="text-sm font-semibold text-fg">
                  {data.title === 'Untitled API' ? t('tools.items.openapi.untitled') : data.title}{' '}
                  <span className="text-fg3">v{data.version}</span>
                </div>
                <div className="text-xs text-fg3">
                  {t('tools.items.openapi.summary', {
                    value: data.specVersion,
                    count: data.operations.length,
                    total: data.schemaNames.length,
                  })}
                </div>
              </div>
              <div className="max-h-[50vh] overflow-auto">
                {data.operations.map((op, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-3 border-b border-line/50 px-3 py-1.5 text-sm last:border-0"
                  >
                    <span
                      className={`w-16 shrink-0 font-mono text-xs font-semibold ${METHOD_COLOR[op.method] ?? 'text-fg2'}`}
                    >
                      {op.method}
                    </span>
                    <span className="shrink-0 font-mono text-xs text-fg">{op.path}</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-fg3">{op.summary}</span>
                  </div>
                ))}
              </div>
              {data.schemaNames.length > 0 && (
                <div className="flex flex-wrap gap-1.5 border-t border-line px-3 py-2">
                  {data.schemaNames.map((s) => (
                    <span
                      key={s}
                      className="rounded border border-line px-1.5 py-0.5 font-mono text-[11px] text-fg2"
                    >
                      {s}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )
        ) : (
          <ToolEditor
            label={t('tools.items.openapi.csharp')}
            value={csharp}
            readOnly
            minRows={20}
            actions={
              <>
                <CopyButton size="sm" variant="ghost" value={csharp} />
                <SendToMenu source={definition} value={csharp} />
              </>
            }
          />
        )}
      </div>
    </SplitGrid>
  );
}
