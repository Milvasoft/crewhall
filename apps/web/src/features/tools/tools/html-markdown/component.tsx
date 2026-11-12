// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/html-markdown/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { ToolEditor } from '@/features/tools/components/tool/ToolEditor';
import { ConverterLayout } from '@/features/tools/components/tool/ConverterLayout';
import { Button } from '@/features/tools/components/ui/Button';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { SendToMenu } from '@/features/tools/components/tool/SendToMenu';
import { useI18n } from '@/lib/i18n/I18nContext';
import { htmlToMarkdown } from './logic';

const EXAMPLE =
  '<h1>Title</h1>\n<p>Some <strong>bold</strong> and <a href="https://example.com">a link</a>.</p>\n<ul><li>one</li><li>two</li></ul>';

export default function HtmlMarkdownTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [input, setInput] = useState(initialInput ?? EXAMPLE);
  const definition = getDefinition('html-markdown')!;

  const { output, error } = useMemo(() => {
    if (!input.trim()) return { output: '', error: null as string | null };
    try {
      return { output: htmlToMarkdown(input), error: null };
    } catch (e) {
      return { output: '', error: e instanceof Error ? e.message : '' };
    }
  }, [input]);

  return (
    <ConverterLayout
      input={
        <ToolEditor
          label="HTML"
          value={input}
          onChange={setInput}
          language="xml"
          lineNumbers
          minRows={18}
          footer={
            error !== null ? (
              <span className="text-danger">{error || t('tools.common.error')}</span>
            ) : undefined
          }
          actions={
            <Button size="sm" variant="ghost" onClick={() => setInput(EXAMPLE)}>
              {t('tools.common.sample')}
            </Button>
          }
        />
      }
      output={
        <ToolEditor
          label="Markdown"
          value={output}
          readOnly
          language="markdown"
          lineNumbers
          minRows={18}
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
