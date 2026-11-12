// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/yaml-viewer/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { ToolEditor } from '@/features/tools/components/tool/ToolEditor';
import { SplitGrid } from '@/features/tools/components/tool/SplitGrid';
import { Button } from '@/features/tools/components/ui/Button';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { SendToMenu } from '@/features/tools/components/tool/SendToMenu';
import { useI18n } from '@/lib/i18n/I18nContext';
import { formatYaml, yamlToJson } from './logic';

const EXAMPLE = `name:    Ada Lovelace
roles: [admin, user]
active: true
meta:
    since: 2024
    tags:
        - pioneer
        - mathematician
`;

type View = 'formatted' | 'json';

export default function YamlViewerTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [input, setInput] = useState(initialInput ?? EXAMPLE);
  const [view, setView] = useState<View>('formatted');
  const [sortKeys, setSortKeys] = useState(false);
  const definition = getDefinition('yaml-viewer')!;

  const { output, error } = useMemo(() => {
    if (!input.trim()) return { output: '', error: null as string | null };
    try {
      return {
        output: view === 'json' ? yamlToJson(input) : formatYaml(input, sortKeys),
        error: null,
      };
    } catch (e) {
      return {
        output: '',
        error: e instanceof Error ? e.message : t('tools.items.yaml-viewer.invalid'),
      };
    }
  }, [input, view, sortKeys, t]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="inline-flex overflow-hidden rounded-md border border-line">
          {(['formatted', 'json'] as View[]).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`h-8 px-3 text-sm font-medium transition-colors ${
                view === v ? 'bg-accent text-accent-fg' : 'bg-surface text-fg2 hover:bg-bg2'
              }`}
            >
              {v === 'json'
                ? t('tools.items.yaml-viewer.asJson')
                : t('tools.items.yaml-viewer.formatted')}
            </button>
          ))}
        </div>
        {view === 'formatted' && (
          <label className="flex items-center gap-1.5 text-xs text-fg2">
            <input
              type="checkbox"
              checked={sortKeys}
              onChange={(e) => setSortKeys(e.target.checked)}
            />
            {t('tools.items.yaml-viewer.sortKeys')}
          </label>
        )}
        <Button size="sm" variant="ghost" onClick={() => setInput(EXAMPLE)}>
          {t('tools.common.sample')}
        </Button>
      </div>

      <SplitGrid
        leftLabel="YAML"
        rightLabel={view === 'json' ? 'JSON' : t('tools.items.yaml-viewer.formattedYaml')}
      >
        <ToolEditor
          label="YAML"
          value={input}
          onChange={setInput}
          language="yaml"
          lineNumbers
          minRows={18}
          footer={error ? <span className="text-danger">{error}</span> : undefined}
        />
        <ToolEditor
          label={view === 'json' ? 'JSON' : t('tools.items.yaml-viewer.formattedYaml')}
          value={error ? '' : output}
          readOnly
          language={view === 'json' ? 'json' : 'yaml'}
          lineNumbers
          minRows={18}
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
