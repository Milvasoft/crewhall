// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/mac-address-generator/component.tsx. See THIRD_PARTY.md.
import { useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import type { MacSeparator } from '@/features/tools/lib/net/mac';
import { Button } from '@/features/tools/components/ui/Button';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { useI18n } from '@/lib/i18n/I18nContext';
import { randomMac } from './logic';

type SeparatorKey = 'colon' | 'hyphen' | 'dot' | 'none';

const SEPARATORS: { value: MacSeparator; key: SeparatorKey }[] = [
  { value: ':', key: 'colon' },
  { value: '-', key: 'hyphen' },
  { value: '.', key: 'dot' },
  { value: '', key: 'none' },
];

interface Options {
  separator: MacSeparator;
  uppercase: boolean;
  prefix: string;
  count: number;
}

const generate = ({ separator, uppercase, prefix, count }: Options): string[] =>
  Array.from({ length: count }, () => randomMac({ separator, uppercase, prefix }));

const INITIAL: Options = { separator: ':', uppercase: false, prefix: '', count: 5 };

export default function MacAddressGeneratorTool(_: ToolComponentProps) {
  void _;
  const { t } = useI18n();
  const [opts, setOpts] = useState<Options>(INITIAL);
  const [macs, setMacs] = useState<string[]>(() => generate(INITIAL));
  const { separator, uppercase, prefix, count } = opts;

  // Every option change draws a fresh list, as the button does.
  const update = (patch: Partial<Options>) => {
    const next = { ...opts, ...patch };
    setOpts(next);
    setMacs(generate(next));
  };

  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg2">
            {t('tools.items.mac-address-generator.separator')}
          </span>
          <select
            value={separator}
            onChange={(e) => update({ separator: e.target.value as MacSeparator })}
            className="h-9 w-28 rounded-md border border-line bg-surface px-2 text-sm text-fg focus:border-accent focus:outline-none"
          >
            {SEPARATORS.map((s) => (
              <option key={s.key} value={s.value}>
                {t(`tools.items.mac-address-generator.separators.${s.key}`)}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg2">
            {t('tools.items.mac-address-generator.count')}
          </span>
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

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg2">
            {t('tools.items.mac-address-generator.prefix')}
          </span>
          <input
            value={prefix}
            onChange={(e) => update({ prefix: e.target.value })}
            spellCheck={false}
            placeholder="00:11:22"
            className="h-9 w-32 rounded-md border border-line bg-surface px-2 font-mono text-sm text-fg focus:border-accent focus:outline-none"
          />
        </label>

        <label className="flex h-9 items-center gap-1.5 text-xs text-fg2">
          <input
            type="checkbox"
            checked={uppercase}
            onChange={(e) => update({ uppercase: e.target.checked })}
          />
          {t('tools.items.mac-address-generator.uppercase')}
        </label>

        <Button variant="primary" onClick={() => setMacs(generate(opts))}>
          {t('tools.common.generate')}
        </Button>
      </div>

      {macs.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          {macs.map((mac, i) => (
            <div
              key={i}
              className="group flex items-center gap-3 border-b border-line/60 px-3 py-2 last:border-0"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-sm text-fg">{mac}</span>
              <CopyButton
                size="sm"
                variant="ghost"
                value={mac}
                className="opacity-0 transition-opacity group-hover:opacity-100"
              />
            </div>
          ))}
          <div className="flex items-center justify-end border-t border-line bg-bg2 px-3 py-1.5">
            <CopyButton
              size="sm"
              variant="ghost"
              label={t('tools.items.mac-address-generator.copyAll')}
              value={macs.join('\n')}
            />
          </div>
        </div>
      )}
    </div>
  );
}
