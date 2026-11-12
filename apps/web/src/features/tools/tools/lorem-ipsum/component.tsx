// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/lorem-ipsum/component.tsx. See THIRD_PARTY.md.
import { useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { ToolEditor } from '@/features/tools/components/tool/ToolEditor';
import { Button } from '@/features/tools/components/ui/Button';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { SendToMenu } from '@/features/tools/components/tool/SendToMenu';
import { useI18n } from '@/lib/i18n/I18nContext';
import { generateLorem, type LoremUnit } from './logic';

interface Settings {
  count: number;
  unit: LoremUnit;
  startWithLorem: boolean;
}

const INITIAL: Settings = { count: 3, unit: 'paragraphs', startWithLorem: true };

export default function LoremIpsumTool(_props: ToolComponentProps) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<Settings>(INITIAL);
  const [output, setOutput] = useState(() =>
    generateLorem(INITIAL.count, INITIAL.unit, INITIAL.startWithLorem),
  );
  const definition = getDefinition('lorem-ipsum')!;
  const { count, unit, startWithLorem } = settings;

  // Every settings change regenerates, like the Generate button.
  const update = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    setOutput(generateLorem(next.count, next.unit, next.startWithLorem));
  };

  const regenerate = () => setOutput(generateLorem(count, unit, startWithLorem));

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr]">
      <div className="flex flex-col gap-4 self-start">
        <label className="flex items-center justify-between text-xs text-fg2">
          {t('tools.items.lorem-ipsum.count')}
          <input
            type="number"
            min={1}
            max={100}
            value={count}
            onChange={(e) => update({ count: Math.max(1, Number(e.target.value) || 1) })}
            className="h-8 w-24 rounded-md border border-line bg-surface px-2 text-right text-sm outline-none"
          />
        </label>
        <div className="inline-flex overflow-hidden rounded-md border border-line">
          {(['words', 'sentences', 'paragraphs'] as LoremUnit[]).map((u) => (
            <button
              key={u}
              onClick={() => update({ unit: u })}
              className={`h-8 flex-1 px-2 text-xs font-medium capitalize transition-colors ${
                unit === u ? 'bg-accent text-accent-fg' : 'bg-surface text-fg2 hover:bg-bg2'
              }`}
            >
              {t(`tools.items.lorem-ipsum.units.${u}`)}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-xs text-fg2">
          <input
            type="checkbox"
            checked={startWithLorem}
            onChange={(e) => update({ startWithLorem: e.target.checked })}
          />
          {t('tools.items.lorem-ipsum.startWithLorem')}
        </label>
        <Button variant="primary" onClick={regenerate}>
          {t('tools.common.generate')}
        </Button>
      </div>

      <ToolEditor
        label={t('tools.common.output')}
        value={output}
        readOnly
        minRows={16}
        actions={
          <>
            <CopyButton size="sm" variant="ghost" value={output} />
            <SendToMenu source={definition} value={output} />
          </>
        }
      />
    </div>
  );
}
