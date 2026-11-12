// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/json-schema/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { ToolEditor } from '@/features/tools/components/tool/ToolEditor';
import { SplitGrid } from '@/features/tools/components/tool/SplitGrid';
import { Button } from '@/features/tools/components/ui/Button';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { SendToMenu } from '@/features/tools/components/tool/SendToMenu';
import { useI18n } from '@/lib/i18n/I18nContext';
import { generateSchema, validateJson } from './logic';

type Mode = 'generate' | 'validate';

const EXAMPLE = JSON.stringify({ id: 1, name: 'Ada', active: true, tags: ['admin'] }, null, 2);

export default function JsonSchemaTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>('generate');
  const [data, setData] = useState(initialInput ?? EXAMPLE);
  const [schema, setSchema] = useState('');
  const definition = getDefinition('json-schema')!;

  const generated = useMemo(() => {
    if (mode !== 'generate' || !data.trim()) return { output: '', error: null as string | null };
    try {
      return { output: generateSchema(data), error: null };
    } catch (e) {
      return {
        output: '',
        error: e instanceof Error ? e.message : t('tools.items.json-schema.invalidJson'),
      };
    }
  }, [mode, data, t]);

  const validation = useMemo(() => {
    if (mode !== 'validate' || !data.trim() || !schema.trim()) return null;
    return validateJson(data, schema);
  }, [mode, data, schema]);

  return (
    <div>
      <div className="mb-3 flex items-center gap-3">
        <div className="inline-flex overflow-hidden rounded-md border border-line">
          {(['generate', 'validate'] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`h-8 px-3 text-sm font-medium capitalize transition-colors ${
                mode === m ? 'bg-accent text-accent-fg' : 'bg-surface text-fg2 hover:bg-bg2'
              }`}
            >
              {t(`tools.items.json-schema.${m}`)}
            </button>
          ))}
        </div>
        {mode === 'generate' && (
          <Button size="sm" variant="ghost" onClick={() => setData(EXAMPLE)}>
            {t('tools.common.sample')}
          </Button>
        )}
      </div>

      {mode === 'generate' ? (
        <SplitGrid leftLabel="JSON" rightLabel="JSON Schema">
          <ToolEditor
            label="JSON"
            value={data}
            onChange={setData}
            language="json"
            lineNumbers
            minRows={20}
            footer={
              generated.error ? <span className="text-danger">{generated.error}</span> : undefined
            }
          />
          <ToolEditor
            label="JSON Schema (draft-07)"
            value={generated.output}
            readOnly
            language="json"
            lineNumbers
            minRows={20}
            actions={
              <>
                <CopyButton size="sm" variant="ghost" value={generated.output} />
                <SendToMenu source={definition} value={generated.output} />
              </>
            }
          />
        </SplitGrid>
      ) : (
        <>
          <SplitGrid leftLabel={t('tools.items.json-schema.data')} rightLabel="JSON Schema">
            <ToolEditor
              label={t('tools.items.json-schema.data')}
              value={data}
              onChange={setData}
              language="json"
              lineNumbers
              minRows={18}
            />
            <ToolEditor
              label="JSON Schema"
              value={schema}
              onChange={setSchema}
              language="json"
              lineNumbers
              minRows={18}
            />
          </SplitGrid>
          {validation && (
            <div
              className={`mt-3 rounded-lg border px-3 py-2 text-sm ${
                validation.valid ? 'border-line bg-surface text-success' : 'border-line bg-surface'
              }`}
            >
              {validation.valid ? (
                <span className="font-medium text-success">
                  ✓ {t('tools.items.json-schema.valid')}
                </span>
              ) : (
                <div>
                  <p className="mb-1 font-medium text-danger">
                    ✗ {t('tools.items.json-schema.errorCount', { count: validation.errors.length })}
                  </p>
                  <ul className="space-y-0.5 font-mono text-xs text-fg2">
                    {validation.errors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
