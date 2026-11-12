// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/sql-formatter/component.tsx. See THIRD_PARTY.md.
import { useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { ToolEditor } from '@/features/tools/components/tool/ToolEditor';
import { SplitGrid } from '@/features/tools/components/tool/SplitGrid';
import { Button } from '@/features/tools/components/ui/Button';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { SendToMenu } from '@/features/tools/components/tool/SendToMenu';
import { useWorkerTransform } from '@/features/tools/lib/worker/useWorkerTransform';
import { useI18n } from '@/lib/i18n/I18nContext';
import { formatSql, SQL_DIALECTS, type SqlDialect, type SqlFormatOptions } from './logic';

const EXAMPLE =
  'select u.id, u.name, count(o.id) as orders from users u left join orders o on o.user_id=u.id where u.active=1 group by u.id, u.name having count(o.id)>0 order by orders desc;';

export default function SqlFormatterTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [input, setInput] = useState(initialInput ?? EXAMPLE);
  const [dialect, setDialect] = useState<SqlDialect>('sql');
  const [keywordCase, setKeywordCase] = useState<'upper' | 'lower' | 'preserve'>('upper');
  const definition = getDefinition('sql-formatter')!;

  const { result, error } = useWorkerTransform<{ sql: string; options: SqlFormatOptions }, string>({
    createWorker: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
    buildRequest: () => ({ sql: input, options: { dialect, keywordCase, tabWidth: 2 } }),
    compute: (r) => (r.sql.trim() ? formatSql(r.sql, r.options) : ''),
    size: input.length,
    deps: [input, dialect, keywordCase],
    threshold: 20_000,
  });
  const output = result ?? '';

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs text-fg2">
          {t('tools.items.sql-formatter.dialect')}
          <select
            value={dialect}
            onChange={(e) => setDialect(e.target.value as SqlDialect)}
            className="h-8 rounded-md border border-line bg-surface px-2 text-sm outline-none"
          >
            {SQL_DIALECTS.map((d) => (
              <option key={d.id} value={d.id}>
                {d.id === 'sql' ? t('tools.items.sql-formatter.standardSql') : d.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-fg2">
          {t('tools.items.sql-formatter.keywordCase')}
          <select
            value={keywordCase}
            onChange={(e) => setKeywordCase(e.target.value as 'upper' | 'lower' | 'preserve')}
            className="h-8 rounded-md border border-line bg-surface px-2 text-sm outline-none"
          >
            <option value="upper">{t('tools.items.sql-formatter.case.upper')}</option>
            <option value="lower">{t('tools.items.sql-formatter.case.lower')}</option>
            <option value="preserve">{t('tools.items.sql-formatter.case.preserve')}</option>
          </select>
        </label>
      </div>

      <SplitGrid leftLabel="SQL" rightLabel={t('tools.items.sql-formatter.formatted')}>
        <ToolEditor
          label="SQL"
          value={input}
          onChange={setInput}
          language="sql"
          lineNumbers
          minRows={18}
          placeholder={t('tools.items.sql-formatter.placeholder')}
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
        <ToolEditor
          label={t('tools.items.sql-formatter.formatted')}
          value={error ? '' : output}
          readOnly
          language="sql"
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
