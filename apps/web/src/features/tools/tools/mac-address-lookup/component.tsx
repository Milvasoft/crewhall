// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/mac-address-lookup/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { useI18n } from '@/lib/i18n/I18nContext';
import { lookupMac } from './logic';
import { OUI_COUNT } from './oui-data';

export default function MacAddressLookupTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [input, setInput] = useState(initialInput ?? '20:37:06:12:34:56');

  const { result, error } = useMemo(() => {
    if (!input.trim()) return { result: null, error: null as string | null };
    try {
      return { result: lookupMac(input), error: null };
    } catch (e) {
      return {
        result: null,
        error: e instanceof Error ? e.message : t('tools.items.mac-address-lookup.invalid'),
      };
    }
  }, [input, t]);

  return (
    <div className="max-w-2xl space-y-4">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-fg2">
          {t('tools.items.mac-address-lookup.inputLabel')}
        </span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          spellCheck={false}
          placeholder="20:37:06:12:34:56"
          className="h-10 w-full rounded-lg border border-line bg-surface px-3 font-mono text-sm text-fg focus:border-accent focus:outline-none"
        />
      </label>

      {error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : result ? (
        <div className="space-y-3">
          <div className="rounded-lg border border-line bg-surface p-4">
            <div className="mb-1 text-xs uppercase tracking-wide text-fg3">
              {t('tools.items.mac-address-lookup.vendor')}
            </div>
            {result.vendor ? (
              <div className="flex items-center gap-2">
                <span className="text-lg font-semibold text-fg">{result.vendor}</span>
                <CopyButton size="sm" variant="ghost" value={result.vendor} />
              </div>
            ) : (
              <p className="text-sm text-fg2">
                {t('tools.items.mac-address-lookup.notFound', { count: OUI_COUNT })}
              </p>
            )}
          </div>

          <div className="overflow-hidden rounded-lg border border-line bg-surface">
            <Row label="OUI" value={result.ouiFormatted} />
            <Row
              label={t('tools.items.mac-address-lookup.administration')}
              value={
                result.locallyAdministered
                  ? t('tools.items.mac-address-lookup.local')
                  : t('tools.items.mac-address-lookup.universal')
              }
            />
            <Row
              label={t('tools.items.mac-address-lookup.cast')}
              value={
                result.multicast
                  ? t('tools.items.mac-address-lookup.multicast')
                  : t('tools.items.mac-address-lookup.unicast')
              }
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 border-b border-line/60 px-3 py-2 last:border-0">
      <span className="w-32 shrink-0 text-xs text-fg3">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-sm text-fg">{value}</span>
    </div>
  );
}
