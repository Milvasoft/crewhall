// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/sql-parameterizer/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { ToolEditor } from '@/features/tools/components/tool/ToolEditor';
import { SplitGrid } from '@/features/tools/components/tool/SplitGrid';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { SendToMenu } from '@/features/tools/components/tool/SendToMenu';
import { useI18n } from '@/lib/i18n/I18nContext';
import { parameterize, type ParamStyle } from './logic';

const EXAMPLE =
  "SELECT * FROM orders WHERE customer_id = 42 AND status = 'shipped' AND total > 99.5;";

const STYLES: { id: ParamStyle; label: string }[] = [
  { id: 'at', label: '@p1 (SQL Server)' },
  { id: 'colon', label: ':p1 (Oracle)' },
  { id: 'dollar', label: '$1 (Postgres)' },
  { id: 'question', label: '?' },
];

export default function SqlParameterizerTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [input, setInput] = useState(initialInput ?? EXAMPLE);
  const [style, setStyle] = useState<ParamStyle>('at');
  const definition = getDefinition('sql-parameterizer')!;

  const result = useMemo(
    () => (input.trim() ? parameterize(input, style) : { query: '', params: [] }),
    [input, style],
  );

  const paramsJson = JSON.stringify(
    Object.fromEntries(result.params.map((p) => [p.name, p.value])),
    null,
    2,
  );

  return (
    <div>
      <div className="mb-3 flex items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs text-fg2">
          {t('tools.items.sql-parameterizer.style')}
          <select
            value={style}
            onChange={(e) => setStyle(e.target.value as ParamStyle)}
            className="h-8 rounded-md border border-line bg-surface px-2 text-sm outline-none"
          >
            {STYLES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id === 'question'
                  ? `? (${t('tools.items.sql-parameterizer.positional')})`
                  : s.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <SplitGrid leftLabel="SQL" rightLabel={t('tools.common.result')}>
        <ToolEditor
          label="SQL"
          value={input}
          onChange={setInput}
          language="sql"
          lineNumbers
          minRows={16}
        />
        <div className="flex flex-col gap-3">
          <ToolEditor
            label={t('tools.items.sql-parameterizer.query')}
            value={result.query}
            readOnly
            language="sql"
            minRows={7}
            actions={
              <>
                <CopyButton size="sm" variant="ghost" value={result.query} />
                <SendToMenu source={definition} value={result.query} />
              </>
            }
          />
          <ToolEditor
            label={t('tools.items.sql-parameterizer.params', { count: result.params.length })}
            value={paramsJson}
            readOnly
            language="json"
            minRows={7}
            actions={<CopyButton size="sm" variant="ghost" value={paramsJson} />}
          />
        </div>
      </SplitGrid>
    </div>
  );
}
