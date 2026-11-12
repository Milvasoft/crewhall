// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/xml-formatter/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { ToolEditor } from '@/features/tools/components/tool/ToolEditor';
import { SplitGrid } from '@/features/tools/components/tool/SplitGrid';
import { Button } from '@/features/tools/components/ui/Button';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { SendToMenu } from '@/features/tools/components/tool/SendToMenu';
import { useI18n } from '@/lib/i18n/I18nContext';
import { formatXml, minifyXml, parseXmlTree, type XmlNode } from './logic';
import { XmlTree } from './XmlTree';

const EXAMPLE = '<note id="1"><to>Ada</to><from>Grace</from><body>Hello there</body></note>';

type View = 'format' | 'minify' | 'tree';

export default function XmlFormatterTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [input, setInput] = useState(initialInput ?? EXAMPLE);
  const [view, setView] = useState<View>('format');
  const definition = getDefinition('xml-formatter')!;

  const { output, tree, error } = useMemo(() => {
    if (!input.trim()) return { output: '', tree: [] as XmlNode[], error: null as string | null };
    try {
      if (view === 'tree') {
        return { output: '', tree: parseXmlTree(input), error: null };
      }
      return {
        output: view === 'format' ? formatXml(input) : minifyXml(input),
        tree: [] as XmlNode[],
        error: null,
      };
    } catch (e) {
      return {
        output: '',
        tree: [] as XmlNode[],
        error: e instanceof Error ? e.message : t('tools.items.xml-formatter.invalid'),
      };
    }
  }, [input, view, t]);

  return (
    <div>
      <div className="mb-3 flex items-center gap-3">
        <div className="inline-flex overflow-hidden rounded-md border border-line">
          {(['format', 'minify', 'tree'] as View[]).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`h-8 px-3 text-sm font-medium transition-colors ${
                view === v ? 'bg-accent text-accent-fg' : 'bg-surface text-fg2 hover:bg-bg2'
              }`}
            >
              {v === 'tree' ? t(`tools.items.xml-formatter.tree`) : t(`tools.common.${v}`)}
            </button>
          ))}
        </div>
        <Button size="sm" variant="ghost" onClick={() => setInput(EXAMPLE)}>
          {t('tools.common.sample')}
        </Button>
      </div>

      <SplitGrid
        leftLabel="XML"
        rightLabel={
          view === 'tree' ? t('tools.items.xml-formatter.tree') : t('tools.common.output')
        }
      >
        <ToolEditor
          label="XML"
          value={input}
          onChange={setInput}
          language="xml"
          lineNumbers
          minRows={20}
          footer={error ? <span className="text-danger">{error}</span> : undefined}
        />

        {view === 'tree' ? (
          <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-surface">
            <div className="flex h-9 shrink-0 items-center border-b border-line bg-bg2 px-3">
              <span className="text-xs font-semibold uppercase tracking-wide text-fg2">
                {t('tools.items.xml-formatter.tree')}
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-2">
              {error ? (
                <p className="px-2 py-1 text-sm text-danger">{error}</p>
              ) : tree.length === 0 ? (
                <p className="px-2 py-1 text-sm text-fg2">
                  {t('tools.items.xml-formatter.noElements')}
                </p>
              ) : (
                <XmlTree nodes={tree} />
              )}
            </div>
          </div>
        ) : (
          <ToolEditor
            label={t('tools.common.output')}
            value={error ? '' : output}
            readOnly
            language="xml"
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
