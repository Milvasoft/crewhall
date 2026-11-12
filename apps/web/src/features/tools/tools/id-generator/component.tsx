// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/id-generator/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import { getDefinition } from '@/features/tools/lib/registry';
import { ToolEditor } from '@/features/tools/components/tool/ToolEditor';
import { Button } from '@/features/tools/components/ui/Button';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { SendToMenu } from '@/features/tools/components/tool/SendToMenu';
import { useI18n } from '@/lib/i18n/I18nContext';
import { generateMany, type IdKind } from './logic';

const KINDS: { id: IdKind; label: string }[] = [
  { id: 'uuid4', label: 'UUID v4' },
  { id: 'uuid7', label: 'UUID v7' },
  { id: 'ulid', label: 'ULID' },
  { id: 'guid', label: 'GUID' },
];

export default function IdGeneratorTool() {
  const { t } = useI18n();
  const [kind, setKind] = useState<IdKind>('uuid4');
  const [count, setCount] = useState(5);
  const [uppercase, setUppercase] = useState(false);
  const [hyphens, setHyphens] = useState(true);
  // Bumped by the Generate button to get a fresh batch with the same options.
  const [batch, setBatch] = useState(0);
  const definition = getDefinition('id-generator')!;

  const isUuid = kind === 'uuid4' || kind === 'uuid7' || kind === 'guid';

  const output = useMemo(() => {
    void batch;
    return generateMany(kind, {
      count,
      uppercase: kind === 'guid' ? true : uppercase,
      hyphens: isUuid ? hyphens : undefined,
    }).join('\n');
  }, [kind, count, uppercase, hyphens, isUuid, batch]);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr]">
      <div className="flex flex-col gap-4 self-start">
        <div className="grid grid-cols-2 gap-2">
          {KINDS.map((k) => (
            <button
              key={k.id}
              onClick={() => setKind(k.id)}
              className={`rounded-lg border p-2 text-left transition-colors ${
                kind === k.id ? 'border-accent bg-accent10' : 'border-line bg-surface hover:bg-bg2'
              }`}
            >
              <div className="text-sm font-medium text-fg">{k.label}</div>
              <div className="text-[11px] text-fg3">
                {t(`tools.items.id-generator.notes.${k.id}`)}
              </div>
            </button>
          ))}
        </div>

        <label className="flex items-center justify-between text-xs text-fg2">
          {t('tools.items.id-generator.count')}
          <input
            type="number"
            min={1}
            max={10000}
            value={count}
            onChange={(e) => setCount(Math.max(1, Number(e.target.value) || 1))}
            className="h-8 w-24 rounded-md border border-line bg-surface px-2 text-right text-sm text-fg outline-none focus:border-accent"
          />
        </label>

        {isUuid && kind !== 'guid' && (
          <label className="flex items-center gap-2 text-xs text-fg2">
            <input
              type="checkbox"
              checked={uppercase}
              onChange={(e) => setUppercase(e.target.checked)}
            />
            {t('tools.items.id-generator.uppercase')}
          </label>
        )}
        {isUuid && (
          <label className="flex items-center gap-2 text-xs text-fg2">
            <input
              type="checkbox"
              checked={hyphens}
              onChange={(e) => setHyphens(e.target.checked)}
            />
            {t('tools.items.id-generator.hyphens')}
          </label>
        )}

        <Button variant="primary" onClick={() => setBatch((b) => b + 1)}>
          {t('tools.common.generate')}
        </Button>
      </div>

      <ToolEditor
        label={t('tools.items.id-generator.total', {
          count: output ? output.split('\n').length : 0,
        })}
        value={output}
        readOnly
        lineNumbers
        minRows={16}
        actions={
          <>
            <CopyButton
              size="sm"
              variant="ghost"
              value={output}
              label={t('tools.items.id-generator.copyAll')}
            />
            <SendToMenu source={definition} value={output} />
          </>
        }
      />
    </div>
  );
}
