// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/eta-calculator/component.tsx. See THIRD_PARTY.md.
import { useEffect, useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { toolKey } from '@/features/tools/i18n';
import { useI18n } from '@/lib/i18n/I18nContext';
import { TIME_UNITS, computeEta } from './logic';

const DURATION_UNITS = [
  [86400, 'days'],
  [3600, 'hours'],
  [60, 'minutes'],
  [1, 'seconds'],
] as const;

export default function EtaCalculatorTool(_: ToolComponentProps) {
  void _;
  const { t, locale } = useI18n();
  const [total, setTotal] = useState('500');
  const [amount, setAmount] = useState('5');
  const [span, setSpan] = useState('3');
  const [unit, setUnit] = useState('minute');
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Keep "now" in state (updated each second) so the render stays pure.
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Same rounding as the copied formatDuration: the two largest non-zero units.
  const formatDuration = useMemo(
    () => (totalSeconds: number) => {
      let rem = Math.round(totalSeconds);
      const parts: string[] = [];
      for (const [size, name] of DURATION_UNITS) {
        const n = Math.floor(rem / size);
        if (n > 0) {
          parts.push(t(`tools.items.eta-calculator.duration.${name}`, { count: n }));
          rem -= n * size;
        }
      }
      return (
        parts.slice(0, 2).join(' ') ||
        t('tools.items.eta-calculator.duration.seconds', { count: 0 })
      );
    },
    [t],
  );

  const result = useMemo(() => {
    const unitSeconds = TIME_UNITS.find((u) => u.id === unit)?.seconds ?? 60;
    try {
      const { durationSeconds } = computeEta(
        Number(total),
        Number(amount),
        Number(span),
        unitSeconds,
        0,
      );
      return {
        duration: formatDuration(durationSeconds),
        end: new Date(nowMs + durationSeconds * 1000),
        error: null as string | null,
      };
    } catch {
      // computeEta only throws for a rate that is not above zero.
      return { duration: '', end: null, error: t('tools.items.eta-calculator.rateError') };
    }
  }, [total, amount, span, unit, nowMs, formatDuration, t]);

  const cls =
    'h-10 rounded-lg border border-line bg-surface px-3 font-mono text-sm text-fg focus:border-accent focus:outline-none';

  return (
    <div className="max-w-2xl space-y-4">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-fg2">
          {t('tools.items.eta-calculator.total')}
        </span>
        <input
          type="number"
          value={total}
          onChange={(e) => setTotal(e.target.value)}
          className={`${cls} w-40`}
        />
      </label>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg2">
            {t('tools.items.eta-calculator.processed')}
          </span>
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className={`${cls} w-28`}
          />
        </label>
        <span className="pb-2.5 text-sm text-fg2">{t('tools.items.eta-calculator.inEvery')}</span>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg2">
            {t('tools.items.eta-calculator.span')}
          </span>
          <input
            type="number"
            value={span}
            onChange={(e) => setSpan(e.target.value)}
            className={`${cls} w-24`}
          />
        </label>
        <select value={unit} onChange={(e) => setUnit(e.target.value)} className={`${cls} w-32`}>
          {TIME_UNITS.map((u) => (
            <option key={u.id} value={u.id}>
              {t(toolKey('eta-calculator', `units.${u.id}`))}
            </option>
          ))}
        </select>
      </div>

      {result.error ? (
        <p className="text-sm text-danger">{result.error}</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-line bg-surface p-4">
            <div className="text-xs uppercase tracking-wide text-fg3">
              {t('tools.items.eta-calculator.totalDuration')}
            </div>
            <div className="mt-1 text-2xl font-semibold text-fg">{result.duration}</div>
          </div>
          <div className="rounded-lg border border-line bg-surface p-4">
            <div className="text-xs uppercase tracking-wide text-fg3">
              {t('tools.items.eta-calculator.willFinish')}
            </div>
            <div className="mt-1 text-2xl font-semibold text-fg">
              {result.end?.toLocaleString(locale)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
