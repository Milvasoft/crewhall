// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/temperature-converter/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { useI18n } from '@/lib/i18n/I18nContext';
import { TEMP_UNITS, convertAllTemps, type TempUnit } from './logic';

export default function TemperatureConverterTool(_: ToolComponentProps) {
  void _;
  const { t } = useI18n();
  const [value, setValue] = useState('100');
  const [from, setFrom] = useState<TempUnit>('c');

  const num = Number(value);
  const valid = value.trim() !== '' && Number.isFinite(num);
  const rows = useMemo(() => (valid ? convertAllTemps(num, from) : []), [num, from, valid]);

  return (
    <div className="max-w-xl space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg2">
            {t('tools.items.temperature-converter.value')}
          </span>
          <input
            type="number"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="h-10 w-40 rounded-lg border border-line bg-surface px-3 font-mono text-sm text-fg focus:border-accent focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg2">
            {t('tools.items.temperature-converter.from')}
          </span>
          <select
            value={from}
            onChange={(e) => setFrom(e.target.value as TempUnit)}
            className="h-10 w-44 rounded-lg border border-line bg-surface px-2 text-sm text-fg focus:border-accent focus:outline-none"
          >
            {TEMP_UNITS.map((u) => (
              <option key={u.id} value={u.id}>
                {t(`tools.items.temperature-converter.units.${u.id}`)} ({u.symbol})
              </option>
            ))}
          </select>
        </label>
      </div>

      {!valid ? (
        <p className="text-sm text-danger">{t('tools.items.temperature-converter.invalid')}</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          {rows.map((r) => (
            <div
              key={r.unit}
              className={`group flex items-center gap-3 border-b border-line/60 px-3 py-2.5 last:border-0 ${
                r.unit === from ? 'bg-accent/10' : ''
              }`}
            >
              <span className="w-28 shrink-0 text-xs text-fg3">
                {t(`tools.items.temperature-converter.units.${r.unit}`)}
              </span>
              <span className="min-w-0 flex-1 font-mono text-sm text-fg">
                {r.value} {r.symbol}
              </span>
              <CopyButton
                size="sm"
                variant="ghost"
                value={String(r.value)}
                className="opacity-0 transition-opacity group-hover:opacity-100"
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
