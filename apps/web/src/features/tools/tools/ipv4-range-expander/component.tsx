// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/ipv4-range-expander/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { useI18n } from '@/lib/i18n/I18nContext';
import { expandRange } from './logic';

export default function Ipv4RangeExpanderTool(_: ToolComponentProps) {
  void _;
  const { t, locale } = useI18n();
  const [start, setStart] = useState('192.168.1.5');
  const [end, setEnd] = useState('192.168.1.20');

  const { result, error } = useMemo(() => {
    if (!start.trim() || !end.trim()) {
      return { result: null, error: null as string | null };
    }
    try {
      return { result: expandRange(start, end), error: null };
    } catch (e) {
      return {
        result: null,
        error: e instanceof Error ? e.message : t('tools.items.ipv4-range-expander.invalid'),
      };
    }
  }, [start, end, t]);

  const rows: [string, string][] = result
    ? [
        [t('tools.items.ipv4-range-expander.rows.cidr'), result.cidr],
        [t('tools.items.ipv4-range-expander.rows.prefix'), `/${result.prefix}`],
        [t('tools.items.ipv4-range-expander.rows.netmask'), result.netmask],
        [t('tools.items.ipv4-range-expander.rows.blockStart'), result.newStart],
        [t('tools.items.ipv4-range-expander.rows.blockEnd'), result.newEnd],
        [
          t('tools.items.ipv4-range-expander.rows.addresses'),
          result.addresses.toLocaleString(locale),
        ],
      ]
    : [];

  return (
    <div className="max-w-2xl space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg2">
            {t('tools.items.ipv4-range-expander.startLabel')}
          </span>
          <input
            value={start}
            onChange={(e) => setStart(e.target.value)}
            spellCheck={false}
            className="h-10 w-full rounded-lg border border-line bg-surface px-3 font-mono text-sm text-fg focus:border-accent focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg2">
            {t('tools.items.ipv4-range-expander.endLabel')}
          </span>
          <input
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            spellCheck={false}
            className="h-10 w-full rounded-lg border border-line bg-surface px-3 font-mono text-sm text-fg focus:border-accent focus:outline-none"
          />
        </label>
      </div>

      {error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : result ? (
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
      ) : null}
    </div>
  );
}
