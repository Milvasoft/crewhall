// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/roman-numeral-converter/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { useI18n } from '@/lib/i18n/I18nContext';
import { intToRoman, romanToInt } from './logic';

export default function RomanNumeralConverterTool(_: ToolComponentProps) {
  void _;
  const { t } = useI18n();
  const [arabic, setArabic] = useState('1994');
  const [roman, setRoman] = useState('MCMXCIV');
  const [error, setError] = useState<string | null>(null);

  const onArabic = (v: string) => {
    setArabic(v);
    if (!v.trim()) {
      setRoman('');
      setError(null);
      return;
    }
    try {
      setRoman(intToRoman(Number(v)));
      setError(null);
    } catch (e) {
      setRoman('');
      setError(
        e instanceof Error ? e.message : t('tools.items.roman-numeral-converter.invalidNumber'),
      );
    }
  };

  const onRoman = (v: string) => {
    setRoman(v.toUpperCase());
    if (!v.trim()) {
      setArabic('');
      setError(null);
      return;
    }
    try {
      setArabic(String(romanToInt(v)));
      setError(null);
    } catch (e) {
      setArabic('');
      setError(
        e instanceof Error ? e.message : t('tools.items.roman-numeral-converter.invalidNumeral'),
      );
    }
  };

  const romanValue = useMemo(() => roman, [roman]);

  return (
    <div className="max-w-lg space-y-4">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-fg2">
          {t('tools.items.roman-numeral-converter.number', { min: 1, max: 3999 })}
        </span>
        <input
          value={arabic}
          onChange={(e) => onArabic(e.target.value)}
          inputMode="numeric"
          spellCheck={false}
          className="h-11 w-full rounded-lg border border-line bg-surface px-3 font-mono text-lg text-fg focus:border-accent focus:outline-none"
        />
      </label>

      <div className="text-center text-fg3">⇅</div>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-fg2">
          {t('tools.items.roman-numeral-converter.roman')}
        </span>
        <div className="flex gap-2">
          <input
            value={romanValue}
            onChange={(e) => onRoman(e.target.value)}
            spellCheck={false}
            className="h-11 w-full rounded-lg border border-line bg-surface px-3 font-mono text-lg tracking-widest text-fg focus:border-accent focus:outline-none"
          />
          <CopyButton variant="secondary" className="h-11" value={roman} />
        </div>
      </label>

      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
