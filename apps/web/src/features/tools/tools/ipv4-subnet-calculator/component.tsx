// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/ipv4-subnet-calculator/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { useI18n } from '@/lib/i18n/I18nContext';
import { calculateSubnet } from './logic';

export default function Ipv4SubnetCalculatorTool({ initialInput }: ToolComponentProps) {
  const { t, locale } = useI18n();
  const [input, setInput] = useState(initialInput ?? '192.168.1.10/24');

  const { info, error } = useMemo(() => {
    if (!input.trim()) return { info: null, error: null as string | null };
    try {
      return { info: calculateSubnet(input), error: null };
    } catch (e) {
      return {
        info: null,
        error: e instanceof Error ? e.message : t('tools.items.ipv4-subnet-calculator.invalid'),
      };
    }
  }, [input, t]);

  const ipClassLabel = (cls: string): string => {
    if (cls.startsWith('D')) return t('tools.items.ipv4-subnet-calculator.classD');
    if (cls.startsWith('E')) return t('tools.items.ipv4-subnet-calculator.classE');
    return cls;
  };

  const rows: [string, string][] = info
    ? [
        [t('tools.items.ipv4-subnet-calculator.rows.network'), info.network],
        [t('tools.items.ipv4-subnet-calculator.rows.cidr'), info.cidr],
        [t('tools.items.ipv4-subnet-calculator.rows.netmask'), info.netmask],
        [t('tools.items.ipv4-subnet-calculator.rows.wildcard'), info.wildcard],
        [t('tools.items.ipv4-subnet-calculator.rows.broadcast'), info.broadcast],
        [t('tools.items.ipv4-subnet-calculator.rows.firstHost'), info.firstHost],
        [t('tools.items.ipv4-subnet-calculator.rows.lastHost'), info.lastHost],
        [
          t('tools.items.ipv4-subnet-calculator.rows.totalHosts'),
          info.totalHosts.toLocaleString(locale),
        ],
        [
          t('tools.items.ipv4-subnet-calculator.rows.usableHosts'),
          info.usableHosts.toLocaleString(locale),
        ],
        [t('tools.items.ipv4-subnet-calculator.rows.ipClass'), ipClassLabel(info.ipClass)],
        [
          t('tools.items.ipv4-subnet-calculator.rows.private'),
          info.isPrivate
            ? t('tools.items.ipv4-subnet-calculator.yes')
            : t('tools.items.ipv4-subnet-calculator.no'),
        ],
      ]
    : [];

  return (
    <div className="max-w-2xl space-y-4">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-fg2">
          {t('tools.items.ipv4-subnet-calculator.inputLabel')}
        </span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          spellCheck={false}
          placeholder="192.168.1.10/24"
          className="h-10 w-full rounded-lg border border-line bg-surface px-3 font-mono text-sm text-fg focus:border-accent focus:outline-none"
        />
      </label>

      {error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : info ? (
        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          {rows.map(([label, value]) => (
            <div
              key={label}
              className="group flex items-center gap-3 border-b border-line/60 px-3 py-2 last:border-0"
            >
              <span className="w-44 shrink-0 text-xs text-fg3">{label}</span>
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
      ) : null}
    </div>
  );
}
