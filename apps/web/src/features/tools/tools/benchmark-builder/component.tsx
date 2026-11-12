// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/benchmark-builder/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { Button } from '@/features/tools/components/ui/Button';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { useI18n } from '@/lib/i18n/I18nContext';
import { computeStats, toBulletList, toMarkdownTable } from './logic';

interface EditSuite {
  name: string;
  values: string[];
}

export default function BenchmarkBuilderTool(_: ToolComponentProps) {
  void _;
  const { t } = useI18n();
  const [suites, setSuites] = useState<EditSuite[]>(() => [
    { name: t('tools.items.benchmark-builder.suiteName', { n: 1 }), values: ['5', '10'] },
    { name: t('tools.items.benchmark-builder.suiteName', { n: 2 }), values: ['8', '12'] },
  ]);
  const [unit, setUnit] = useState('');

  const stats = useMemo(
    () =>
      computeStats(
        suites.map((s) => ({
          name: s.name,
          values: s.values.map(Number).filter((n) => Number.isFinite(n)),
        })),
      ),
    [suites],
  );

  const update = (i: number, patch: Partial<EditSuite>) =>
    setSuites((s) => s.map((suite, idx) => (idx === i ? { ...suite, ...patch } : suite)));

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {suites.map((suite, i) => (
          <div key={i} className="space-y-2 rounded-lg border border-line bg-surface p-3">
            <input
              value={suite.name}
              onChange={(e) => update(i, { name: e.target.value })}
              className="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm font-medium text-fg focus:border-accent focus:outline-none"
            />
            {suite.values.map((v, vi) => (
              <div key={vi} className="flex items-center gap-1.5">
                <input
                  value={v}
                  inputMode="decimal"
                  onChange={(e) =>
                    update(i, {
                      values: suite.values.map((x, xi) => (xi === vi ? e.target.value : x)),
                    })
                  }
                  className="h-8 w-full rounded-md border border-line bg-surface px-2 font-mono text-sm text-fg focus:border-accent focus:outline-none"
                />
                <button
                  onClick={() => update(i, { values: suite.values.filter((_, xi) => xi !== vi) })}
                  className="text-fg3 hover:text-danger"
                  aria-label={t('tools.items.benchmark-builder.removeMeasure')}
                >
                  ×
                </button>
              </div>
            ))}
            <div className="flex items-center justify-between">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => update(i, { values: [...suite.values, ''] })}
              >
                {t('tools.items.benchmark-builder.addMeasure')}
              </Button>
              {suites.length > 1 && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setSuites((s) => s.filter((_, idx) => idx !== i))}
                >
                  {t('tools.items.benchmark-builder.deleteSuite')}
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          onClick={() =>
            setSuites((s) => [
              ...s,
              {
                name: t('tools.items.benchmark-builder.suiteName', { n: s.length + 1 }),
                values: [''],
              },
            ])
          }
        >
          {t('tools.items.benchmark-builder.addSuite')}
        </Button>
        <label className="flex items-center gap-2 text-sm text-fg2">
          {t('tools.items.benchmark-builder.unit')}
          <input
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            placeholder="ms"
            className="h-8 w-24 rounded-md border border-line bg-surface px-2 text-sm text-fg focus:border-accent focus:outline-none"
          />
        </label>
      </div>

      {stats.length > 0 && (
        <>
          <div className="overflow-hidden rounded-lg border border-line">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-bg2 text-left text-xs uppercase tracking-wide text-fg2">
                  <th className="px-3 py-2">#</th>
                  <th className="px-3 py-2">{t('tools.items.benchmark-builder.colSuite')}</th>
                  <th className="px-3 py-2">{t('tools.items.benchmark-builder.colSamples')}</th>
                  <th className="px-3 py-2">
                    {t('tools.items.benchmark-builder.colMean')}
                    {unit ? ` (${unit})` : ''}
                  </th>
                  <th className="px-3 py-2">{t('tools.items.benchmark-builder.colVariance')}</th>
                </tr>
              </thead>
              <tbody>
                {stats.map((s) => (
                  <tr key={s.name} className="border-t border-line/60">
                    <td className="px-3 py-2 text-fg2">{s.rank}</td>
                    <td className="px-3 py-2 text-fg">{s.name}</td>
                    <td className="px-3 py-2 font-mono text-fg2">{s.samples}</td>
                    <td className="px-3 py-2 font-mono text-fg">
                      {s.mean}
                      {s.rank !== 1 && (
                        <span className="text-fg3">
                          {' '}
                          (+{s.deltaFromBest} ; ×{s.factor})
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono text-fg2">{s.variance}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap gap-2">
            <CopyButton
              variant="secondary"
              label={t('tools.items.benchmark-builder.copyMarkdown')}
              value={toMarkdownTable(stats, unit)}
            />
            <CopyButton
              variant="secondary"
              label={t('tools.items.benchmark-builder.copyBullets')}
              value={toBulletList(stats, unit)}
            />
          </div>
        </>
      )}
    </div>
  );
}
