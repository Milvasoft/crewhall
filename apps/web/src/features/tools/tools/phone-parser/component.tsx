// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/phone-parser/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { useI18n } from '@/lib/i18n/I18nContext';
import { parsePhone } from './logic';

const COUNTRIES = ['', 'US', 'GB', 'TR', 'DE', 'FR', 'NL', 'IN', 'BR', 'JP', 'AU'];

/** The logic's English field labels mapped to message keys (E.164 and URI stay as is). */
type FieldKey =
  'international' | 'national' | 'country' | 'callingCode' | 'nationalNumber' | 'type';
const FIELD_KEYS: Record<string, FieldKey | undefined> = {
  International: 'international',
  National: 'national',
  Country: 'country',
  'Calling code': 'callingCode',
  'National number': 'nationalNumber',
  Type: 'type',
};

export default function PhoneParserTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [input, setInput] = useState(initialInput ?? '+1 415 555 2671');
  const [country, setCountry] = useState('');
  const fieldLabel = (label: string) => {
    const key = FIELD_KEYS[label];
    return key ? t(`tools.items.phone-parser.fields.${key}`) : label;
  };

  const result = useMemo(
    () => (input.trim() ? parsePhone(input, country || undefined) : null),
    [input, country],
  );

  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs font-medium text-fg2">
            {t('tools.items.phone-parser.number')}
          </span>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            spellCheck={false}
            className="h-11 w-full rounded-lg border border-line bg-surface px-3 font-mono text-sm text-fg focus:border-accent focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg2">
            {t('tools.items.phone-parser.defaultCountry')}
          </span>
          <select
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            className="h-11 w-36 rounded-lg border border-line bg-surface px-2 text-sm text-fg focus:border-accent focus:outline-none"
          >
            {COUNTRIES.map((c) => (
              <option key={c} value={c}>
                {c || t('tools.items.phone-parser.auto')}
              </option>
            ))}
          </select>
        </label>
      </div>

      {result && (
        <>
          <div
            className={`rounded-lg border px-4 py-3 text-sm font-medium ${
              result.valid
                ? 'border-success/40 bg-success/10 text-success'
                : 'border-danger/40 bg-danger/10 text-danger'
            }`}
          >
            {result.valid
              ? `${t('tools.items.phone-parser.valid')} ✓`
              : result.possible
                ? t('tools.items.phone-parser.possible')
                : t('tools.items.phone-parser.unparsable')}
          </div>

          {result.fields.length > 0 && (
            <div className="overflow-hidden rounded-lg border border-line bg-surface">
              {result.fields.map((f) => (
                <div
                  key={f.label}
                  className="group flex items-center gap-3 border-b border-line/60 px-3 py-2 last:border-0"
                >
                  <span className="w-36 shrink-0 text-xs text-fg3">{fieldLabel(f.label)}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-sm text-fg">
                    {f.value === 'Unknown' ? t('tools.items.phone-parser.unknown') : f.value}
                  </span>
                  <CopyButton
                    size="sm"
                    variant="ghost"
                    value={f.value}
                    className="opacity-0 transition-opacity group-hover:opacity-100"
                  />
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
