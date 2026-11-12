// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/sql-to-json/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { ToolEditor } from '@/features/tools/components/tool/ToolEditor';
import { ConverterLayout } from '@/features/tools/components/tool/ConverterLayout';
import { Button } from '@/features/tools/components/ui/Button';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { SendToMenu } from '@/features/tools/components/tool/SendToMenu';
import { useI18n } from '@/lib/i18n/I18nContext';
import { sqlToJson } from './logic';

const EXAMPLE =
  "INSERT INTO users (id, name, active) VALUES\n  (1, 'Ada', true),\n  (2, 'Grace', false);";

export default function SqlToJsonTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [input, setInput] = useState(initialInput ?? EXAMPLE);
  const definition = getDefinition('sql-to-json')!;

  const { output, error } = useMemo(() => {
    if (!input.trim()) return { output: '', error: null as string | null };
    try {
      return { output: sqlToJson(input), error: null };
    } catch (e) {
      const message = e instanceof Error ? e.message : '';
      return {
        output: '',
        error:
          message === 'No INSERT statements found.'
            ? t('tools.items.sql-to-json.noInserts')
            : message || t('tools.common.error'),
      };
    }
  }, [input, t]);

  return (
    <ConverterLayout
      input={
        <ToolEditor
          label={t('tools.items.sql-to-json.inputLabel')}
          value={input}
          onChange={setInput}
          language="sql"
          lineNumbers
          minRows={20}
          footer={error ? <span className="text-danger">{error}</span> : undefined}
          actions={
            <Button size="sm" variant="ghost" onClick={() => setInput(EXAMPLE)}>
              {t('tools.common.sample')}
            </Button>
          }
        />
      }
      output={
        <ToolEditor
          label="JSON"
          value={error ? '' : output}
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
      }
    />
  );
}
