// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/ipv4-address-converter/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { useI18n } from '@/lib/i18n/I18nContext';
import { convertAddress } from './logic';

export default function Ipv4AddressConverterTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [input, setInput] = useState(initialInput ?? '192.168.1.1');

  const { forms, error } = useMemo(() => {
    if (!input.trim()) return { forms: null, error: null as string | null };
    try {
      return { forms: convertAddress(input), error: null };
    } catch (e) {
      return {
        forms: null,
        error: e instanceof Error ? e.message : t('tools.items.ipv4-address-converter.invalid'),
      };
    }
  }, [input, t]);

  const rows: [string, string][] = forms
    ? [
        [t('tools.items.ipv4-address-converter.rows.dotted'), forms.dotted],
        [t('tools.items.ipv4-address-converter.rows.decimal'), forms.decimal],
        [t('tools.items.ipv4-address-converter.rows.hex'), forms.hex],
        [t('tools.items.ipv4-address-converter.rows.octal'), forms.octal],
        [t('tools.items.ipv4-address-converter.rows.binary'), forms.binary],
        [t('tools.items.ipv4-address-converter.rows.ipv6'), forms.ipv6],
        [t('tools.items.ipv4-address-converter.rows.ipv6Hex'), forms.ipv6Hex],
      ]
    : [];

  return (
    <div className="max-w-2xl space-y-4">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-fg2">
          {t('tools.items.ipv4-address-converter.inputLabel')}
        </span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          spellCheck={false}
          placeholder={t('tools.items.ipv4-address-converter.placeholder')}
          className="h-10 w-full rounded-lg border border-line bg-surface px-3 font-mono text-sm text-fg focus:border-accent focus:outline-none"
        />
      </label>

      {error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : forms ? (
        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          {rows.map(([label, value]) => (
            <div
              key={label}
              className="group flex items-center gap-3 border-b border-line/60 px-3 py-2 last:border-0"
            >
              <span className="w-40 shrink-0 text-xs text-fg3">{label}</span>
              <span className="min-w-0 flex-1 break-all font-mono text-sm text-fg">{value}</span>
              <CopyButton
                size="sm"
                variant="ghost"
                value={value}
                className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
              />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
