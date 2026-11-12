// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/docker-run-to-compose/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import { SplitGrid } from '@/features/tools/components/tool/SplitGrid';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { ToolEditor } from '@/features/tools/components/tool/ToolEditor';
import { Button } from '@/features/tools/components/ui/Button';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { SendToMenu } from '@/features/tools/components/tool/SendToMenu';
import { useI18n } from '@/lib/i18n/I18nContext';
import { dockerRunToCompose } from './logic';

const EXAMPLE =
  'docker run -d --name web -p 8080:80 -e NODE_ENV=production -v ./data:/app/data --restart unless-stopped nginx:alpine';

export default function DockerRunToComposeTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [input, setInput] = useState(initialInput ?? EXAMPLE);
  const definition = getDefinition('docker-run-to-compose')!;

  const { output, error } = useMemo(() => {
    if (!input.trim()) return { output: '', error: null as string | null };
    try {
      return { output: dockerRunToCompose(input), error: null };
    } catch {
      // The only failure the converter reports is a command without an image.
      return { output: '', error: t('tools.items.docker-run-to-compose.noImage') };
    }
  }, [input, t]);

  return (
    <SplitGrid leftLabel="docker run" rightLabel="compose">
      <ToolEditor
        label={t('tools.items.docker-run-to-compose.inputLabel')}
        value={input}
        onChange={setInput}
        minRows={16}
        actions={
          <Button size="sm" variant="ghost" onClick={() => setInput(EXAMPLE)}>
            {t('tools.common.sample')}
          </Button>
        }
        footer={error ? <span className="text-danger">{error}</span> : undefined}
      />
      <ToolEditor
        label="docker-compose.yml"
        value={error ? '' : output}
        readOnly
        language="yaml"
        lineNumbers
        minRows={16}
        actions={
          <>
            <CopyButton size="sm" variant="ghost" value={output} />
            <SendToMenu source={definition} value={output} />
          </>
        }
      />
    </SplitGrid>
  );
}
