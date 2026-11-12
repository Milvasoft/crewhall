// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/random-port/component.tsx. See THIRD_PARTY.md.
import { useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { Button } from '@/features/tools/components/ui/Button';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { useI18n } from '@/lib/i18n/I18nContext';
import { randomPorts } from './logic';

interface Options {
  min: number;
  max: number;
  count: number;
}

const generate = ({ min, max, count }: Options): number[] =>
  randomPorts(count, { min: Math.min(min, max), max: Math.max(min, max) });

const INITIAL: Options = { min: 1024, max: 65535, count: 5 };

export default function RandomPortTool(_: ToolComponentProps) {
  void _;
  const { t } = useI18n();
  const [opts, setOpts] = useState<Options>(INITIAL);
  const [ports, setPorts] = useState<number[]>(() => generate(INITIAL));
  const { min, max, count } = opts;

  // Every option change draws a fresh set, as the button does.
  const update = (patch: Partial<Options>) => {
    const next = { ...opts, ...patch };
    setOpts(next);
    setPorts(generate(next));
  };

  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg2">{t('tools.items.random-port.min')}</span>
          <input
            type="number"
            min={0}
            max={65535}
            value={min}
            onChange={(e) => update({ min: Number(e.target.value) || 0 })}
            className="h-9 w-28 rounded-md border border-line bg-surface px-2 font-mono text-sm text-fg focus:border-accent focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg2">{t('tools.items.random-port.max')}</span>
          <input
            type="number"
            min={0}
            max={65535}
            value={max}
            onChange={(e) => update({ max: Number(e.target.value) || 0 })}
            className="h-9 w-28 rounded-md border border-line bg-surface px-2 font-mono text-sm text-fg focus:border-accent focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg2">{t('tools.items.random-port.count')}</span>
          <input
            type="number"
            min={1}
            max={50}
            value={count}
            onChange={(e) =>
              update({ count: Math.max(1, Math.min(50, Number(e.target.value) || 1)) })
            }
            className="h-9 w-20 rounded-md border border-line bg-surface px-2 font-mono text-sm text-fg focus:border-accent focus:outline-none"
          />
        </label>
        <Button variant="primary" onClick={() => setPorts(generate(opts))}>
          {t('tools.common.generate')}
        </Button>
      </div>

      {ports.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {ports.map((p) => (
            <span
              key={p}
              className="rounded-md border border-line bg-surface px-3 py-1.5 font-mono text-sm text-fg"
            >
              {p}
            </span>
          ))}
          <CopyButton
            size="sm"
            variant="ghost"
            label={t('tools.items.random-port.copyAll')}
            value={ports.join('\n')}
          />
        </div>
      )}
    </div>
  );
}
