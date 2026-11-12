// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/cron-viewer/component.tsx. See THIRD_PARTY.md.
import { useEffect, useMemo, useState } from 'react';
// Registers the Turkish cronstrue locale (English is built in).
import 'cronstrue/locales/tr';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { usePreference } from '@/features/tools/lib/preferences/hooks';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { useI18n } from '@/lib/i18n/I18nContext';
import { cronToHangfire, cronToQuartz, describeCron } from './logic';

const PRESETS = [
  { id: 'every5', expr: '*/5 * * * *' },
  { id: 'hourly', expr: '0 * * * *' },
  { id: 'daily9', expr: '0 9 * * *' },
  { id: 'weekdays830', expr: '30 8 * * 1-5' },
  { id: 'firstOfMonth', expr: '0 0 1 * *' },
] as const;

/** logic.ts notes are English (asserted by its tests); pick the matching key. */
function noteKey(note: string): 'alreadyQuartz' | 'bothDays' | 'hangfire' | null {
  if (/already/i.test(note)) return 'alreadyQuartz';
  if (/can't specify both/i.test(note)) return 'bothDays';
  if (/hangfire/i.test(note)) return 'hangfire';
  return null;
}

function fmt(d: Date, locale: string): string {
  return d.toLocaleString(locale, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export default function CronViewerTool({ initialInput }: ToolComponentProps) {
  const { t, locale } = useI18n();
  const [expr, setExpr] = useState(initialInput ?? '*/5 * * * *');
  const [dialect, setDialect] = usePreference('cronDialect');

  // Tick so "next executions" stay relative to the current time.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const result = useMemo(() => describeCron(expr, new Date(now), locale), [expr, now, locale]);

  const conversions = useMemo(() => {
    if (result.error || !result.description) return null;
    try {
      return { quartz: cronToQuartz(expr), hangfire: cronToHangfire(expr) };
    } catch {
      return null;
    }
  }, [expr, result]);

  const noteText = (note: string) => {
    const key = noteKey(note);
    return key ? t(`tools.items.cron-viewer.notes.${key}`) : note;
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <input
            value={expr}
            onChange={(e) => setExpr(e.target.value)}
            spellCheck={false}
            placeholder="*/5 * * * *"
            aria-label={t('tools.items.cron-viewer.expression')}
            className="h-11 flex-1 rounded-lg border border-line bg-surface px-3 font-mono text-base text-fg outline-none focus:border-accent"
          />
          <select
            value={dialect}
            onChange={(e) => setDialect(e.target.value as 'unix' | 'quartz')}
            className="h-11 rounded-lg border border-line bg-surface px-2 text-sm outline-none"
            aria-label={t('tools.items.cron-viewer.dialect')}
          >
            <option value="unix">Unix</option>
            <option value="quartz">Quartz</option>
          </select>
        </div>

        <div className="rounded-lg border border-line bg-surface p-4">
          {result.description ? (
            <p className="text-lg font-medium text-fg">{result.description}</p>
          ) : result.error ? (
            <p className="text-sm text-danger">{result.error}</p>
          ) : (
            <p className="text-sm text-fg3">{t('tools.items.cron-viewer.empty')}</p>
          )}
          <p className="mt-2 text-xs text-fg3">
            {result.fieldCount > 0
              ? `${t('tools.items.cron-viewer.fieldCount', { count: result.fieldCount })} · `
              : ''}
            {dialect === 'quartz'
              ? t('tools.items.cron-viewer.quartzHint')
              : t('tools.items.cron-viewer.unixHint')}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.expr}
              onClick={() => setExpr(p.expr)}
              className="rounded-md border border-line bg-surface px-2.5 py-1 text-xs text-fg2 transition-colors hover:bg-bg2 hover:text-fg"
            >
              {t(`tools.items.cron-viewer.presets.${p.id}`)}
            </button>
          ))}
        </div>

        {conversions && (
          <div className="overflow-hidden rounded-lg border border-line bg-surface">
            <div className="border-b border-line bg-bg2 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-fg2">
              {t('tools.common.convert')}
            </div>
            {(
              [
                ['Quartz', conversions.quartz],
                ['Hangfire', conversions.hangfire],
              ] as const
            ).map(([label, conv]) => (
              <div key={label} className="border-b border-line/60 px-3 py-2 last:border-0">
                <div className="flex items-center gap-3">
                  <span className="w-16 shrink-0 text-xs text-fg3">{label}</span>
                  <code className="min-w-0 flex-1 truncate font-mono text-sm text-fg">
                    {conv.value}
                  </code>
                  <CopyButton size="sm" variant="ghost" value={conv.value} />
                </div>
                {conv.note && (
                  <p className="mt-1 pl-[4.75rem] text-[11px] text-fg3">{noteText(conv.note)}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="self-start rounded-lg border border-line bg-surface">
        <div className="border-b border-line bg-bg2 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-fg2">
          {t('tools.items.cron-viewer.nextRuns')}
        </div>
        {result.nextRuns.length > 0 ? (
          <ol className="divide-y divide-line">
            {result.nextRuns.map((d, i) => (
              <li key={i} className="flex items-center gap-3 px-3 py-2 font-mono text-xs text-fg">
                <span className="text-fg3">{i + 1}</span>
                {fmt(d, locale)}
              </li>
            ))}
          </ol>
        ) : (
          <div className="px-3 py-3 text-xs text-fg3">
            {dialect === 'quartz'
              ? t('tools.items.cron-viewer.noRunsQuartz')
              : t('tools.items.cron-viewer.noRuns')}
          </div>
        )}
      </div>
    </div>
  );
}
