// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/percentage-calculator/component.tsx. See THIRD_PARTY.md.
import { useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { useI18n } from '@/lib/i18n/I18nContext';
import { percentChange, percentOf, whatPercent } from './logic';

function safe(fn: () => number): string {
  try {
    return String(fn());
  } catch {
    return '—';
  }
}

export default function PercentageCalculatorTool(_: ToolComponentProps) {
  void _;
  const { t } = useI18n();
  const [a1, setA1] = useState('20');
  const [a2, setA2] = useState('150');
  const [b1, setB1] = useState('30');
  const [b2, setB2] = useState('150');
  const [c1, setC1] = useState('100');
  const [c2, setC2] = useState('125');

  const cls =
    'h-9 w-24 rounded-md border border-line bg-surface px-2 font-mono text-sm text-fg focus:border-accent focus:outline-none';

  return (
    <div className="max-w-2xl space-y-3">
      <Card>
        <span className="text-fg2">{t('tools.items.percentage-calculator.whatIs')}</span>
        <input value={a1} onChange={(e) => setA1(e.target.value)} className={cls} />
        <span className="text-fg2">{t('tools.items.percentage-calculator.percentOf')}</span>
        <input value={a2} onChange={(e) => setA2(e.target.value)} className={cls} />
        <Result value={safe(() => percentOf(Number(a1), Number(a2)))} />
      </Card>

      <Card>
        <input value={b1} onChange={(e) => setB1(e.target.value)} className={cls} />
        <span className="text-fg2">{t('tools.items.percentage-calculator.isWhatPercentOf')}</span>
        <input value={b2} onChange={(e) => setB2(e.target.value)} className={cls} />
        <Result value={`${safe(() => whatPercent(Number(b1), Number(b2)))}%`} />
      </Card>

      <Card>
        <span className="text-fg2">{t('tools.items.percentage-calculator.changeFrom')}</span>
        <input value={c1} onChange={(e) => setC1(e.target.value)} className={cls} />
        <span className="text-fg2">{t('tools.items.percentage-calculator.to')}</span>
        <input value={c2} onChange={(e) => setC2(e.target.value)} className={cls} />
        <Result value={`${safe(() => percentChange(Number(c1), Number(c2)))}%`} />
      </Card>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-4 py-3 text-sm">
      {children}
    </div>
  );
}

function Result({ value }: { value: string }) {
  return <span className="ml-auto font-mono text-lg font-semibold text-fg">= {value}</span>;
}
