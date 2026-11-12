// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/iban-validator/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { useI18n } from '@/lib/i18n/I18nContext';
import { parseIban, type IbanResult } from './logic';

const WELL_FORMED = /^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/;

export default function IbanValidatorTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [input, setInput] = useState(initialInput ?? 'GB82 WEST 1234 5698 7654 32');

  const result = useMemo(() => (input.trim() ? parseIban(input) : null), [input]);

  // The logic returns English errors; show the localized one for the same case.
  const errorText = (r: IbanResult): string | undefined => {
    if (!r.error) return undefined;
    const iban = r.formatted.replace(/ /g, '');
    if (r.lengthExpected !== undefined && iban.length !== r.lengthExpected) {
      return t('tools.items.iban-validator.errors.length', {
        code: r.countryCode,
        length: r.lengthExpected,
        count: iban.length,
      });
    }
    return WELL_FORMED.test(iban)
      ? t('tools.items.iban-validator.errors.checksum')
      : t('tools.items.iban-validator.errors.malformed');
  };

  return (
    <div className="max-w-2xl space-y-4">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-fg2">IBAN</span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          spellCheck={false}
          className="h-11 w-full rounded-lg border border-line bg-surface px-3 font-mono text-sm uppercase text-fg focus:border-accent focus:outline-none"
        />
      </label>

      {result && (
        <>
          <div
            className={`rounded-lg border px-4 py-3 text-sm font-medium ${
              result.valid
                ? 'border-success/40 bg-success/10 text-success'
                : 'border-danger/40 bg-danger/10 text-danger'
            }`}
          >
            {result.valid ? `${t('tools.items.iban-validator.valid')} ✓` : errorText(result)}
          </div>

          <div className="overflow-hidden rounded-lg border border-line bg-surface">
            <Row label={t('tools.items.iban-validator.formatted')} value={result.formatted} />
            <Row label={t('tools.items.iban-validator.country')} value={result.countryCode} />
            <Row label={t('tools.items.iban-validator.checkDigits')} value={result.checkDigits} />
            <Row label="BBAN" value={result.bban} />
            {result.lengthExpected ? (
              <Row
                label={t('tools.items.iban-validator.expectedLength')}
                value={String(result.lengthExpected)}
              />
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="group flex items-center gap-3 border-b border-line/60 px-3 py-2 last:border-0">
      <span className="w-36 shrink-0 text-xs text-fg3">{label}</span>
      <span className="min-w-0 flex-1 break-all font-mono text-sm text-fg">{value}</span>
      <CopyButton
        size="sm"
        variant="ghost"
        value={value}
        className="opacity-0 transition-opacity group-hover:opacity-100"
      />
    </div>
  );
}
