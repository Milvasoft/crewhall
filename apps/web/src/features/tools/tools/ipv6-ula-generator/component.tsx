// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/ipv6-ula-generator/component.tsx. See THIRD_PARTY.md.
import { useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { Button } from '@/features/tools/components/ui/Button';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { useI18n } from '@/lib/i18n/I18nContext';
import { randomUla, type UlaResult } from './logic';

export default function Ipv6UlaGeneratorTool(_: ToolComponentProps) {
  void _;
  const { t } = useI18n();
  const [subnet, setSubnet] = useState(0);
  // Generated once on mount; the button and subnet changes draw a new one.
  const [result, setResult] = useState<UlaResult>(() => randomUla(0));

  const regenerate = (s: number) => setResult(randomUla(s));

  const rows: [string, string][] = [
    [t('tools.items.ipv6-ula-generator.rows.prefix48'), result.prefix48],
    [t('tools.items.ipv6-ula-generator.rows.prefix64'), result.prefix64],
    [t('tools.items.ipv6-ula-generator.rows.firstAddress'), result.firstAddress],
    [t('tools.items.ipv6-ula-generator.rows.globalId'), result.globalId],
    [t('tools.items.ipv6-ula-generator.rows.subnetId'), result.subnetId],
  ];

  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg2">
            {t('tools.items.ipv6-ula-generator.subnetLabel')}
          </span>
          <input
            type="number"
            min={0}
            max={65535}
            value={subnet}
            onChange={(e) => {
              const s = Math.max(0, Math.min(65535, Number(e.target.value) || 0));
              setSubnet(s);
              regenerate(s);
            }}
            className="h-10 w-36 rounded-lg border border-line bg-surface px-3 font-mono text-sm text-fg focus:border-accent focus:outline-none"
          />
        </label>
        <Button variant="primary" onClick={() => regenerate(subnet)}>
          {t('tools.items.ipv6-ula-generator.generateNew')}
        </Button>
      </div>

      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="group flex items-center gap-3 border-b border-line/60 px-3 py-2 last:border-0"
          >
            <span className="w-32 shrink-0 text-xs text-fg3">{label}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-sm text-fg">{value}</span>
            <CopyButton
              size="sm"
              variant="ghost"
              value={value}
              className="opacity-0 transition-opacity group-hover:opacity-100"
            />
          </div>
        ))}
      </div>

      <p className="text-xs text-fg3">{t('tools.items.ipv6-ula-generator.help')}</p>
    </div>
  );
}
