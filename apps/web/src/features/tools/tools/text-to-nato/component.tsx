// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/text-to-nato/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import { SplitGrid } from '@/features/tools/components/tool/SplitGrid';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { ToolEditor } from '@/features/tools/components/tool/ToolEditor';
import { Button } from '@/features/tools/components/ui/Button';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { SendToMenu } from '@/features/tools/components/tool/SendToMenu';
import { useI18n } from '@/lib/i18n/I18nContext';
import { textToNato } from './logic';

export default function TextToNatoTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [input, setInput] = useState(initialInput ?? 'Crewhall');
  const [newline, setNewline] = useState(false);
  const definition = getDefinition('text-to-nato')!;

  const output = useMemo(() => textToNato(input, newline ? '\n' : ' '), [input, newline]);

  return (
    <SplitGrid leftLabel={t('tools.common.text')} rightLabel="NATO">
      <ToolEditor
        label={t('tools.common.text')}
        value={input}
        onChange={setInput}
        minRows={12}
        actions={
          <Button size="sm" variant="ghost" onClick={() => setInput('')}>
            {t('tools.common.clear')}
          </Button>
        }
      />
      <ToolEditor
        label="NATO"
        value={output}
        readOnly
        minRows={12}
        actions={
          <>
            <label className="mr-1 flex items-center gap-1 text-xs text-fg2">
              <input
                type="checkbox"
                checked={newline}
                onChange={(e) => setNewline(e.target.checked)}
              />
              {t('tools.items.text-to-nato.onePerLine')}
            </label>
            <CopyButton size="sm" variant="ghost" value={output} />
            <SendToMenu source={definition} value={output} />
          </>
        }
      />
    </SplitGrid>
  );
}
