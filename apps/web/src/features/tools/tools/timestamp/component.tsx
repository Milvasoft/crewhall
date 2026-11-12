// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/timestamp/component.tsx. See THIRD_PARTY.md.
import { useEffect, useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { Button } from '@/features/tools/components/ui/Button';
import { useI18n } from '@/lib/i18n/I18nContext';
import { COMMON_TIMEZONES, formatInZone, parseInput, toInfo } from './logic';

export default function TimestampTool({ initialInput }: ToolComponentProps) {
  const { t, rich, locale } = useI18n();
  const [input, setInput] = useState(initialInput ?? '');
  const [now, setNow] = useState<number>(() => Date.now());

  // Tick so "current time" and relative values stay fresh.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const date = useMemo(() => parseInput(input), [input]);
  const info = useMemo(
    () => (date ? toInfo(date, new Date(now), locale) : null),
    [date, now, locale],
  );

  const localString = date
    ? date.toLocaleString(locale, {
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : '';

  const k = 'tools.items.timestamp';
  const rows: { label: string; value: string }[] = info
    ? [
        { label: t(`${k}.unixSeconds`), value: String(info.unixSeconds) },
        { label: t(`${k}.unixMillis`), value: String(info.unixMillis) },
        { label: 'ISO 8601', value: info.iso },
        { label: 'UTC', value: info.utc },
        { label: t(`${k}.local`), value: localString },
        { label: t(`${k}.relative`), value: info.relative },
      ]
    : [];

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-3 flex items-center gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          spellCheck={false}
          placeholder={t(`${k}.placeholder`)}
          aria-label={t(`${k}.inputLabel`)}
          className="h-11 flex-1 rounded-lg border border-line bg-surface px-3 font-mono text-base text-fg outline-none focus:border-accent"
        />
        <Button variant="secondary" onClick={() => setInput(String(Math.floor(Date.now() / 1000)))}>
          {t(`${k}.now`)}
        </Button>
      </div>

      {input && !info && <p className="text-sm text-danger">{t(`${k}.invalid`)}</p>}

      {info && (
        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          {rows.map((r) => (
            <div
              key={r.label}
              className="group flex items-center gap-3 border-b border-line/60 px-3 py-2 last:border-0"
            >
              <span className="w-40 shrink-0 text-xs text-fg3">{r.label}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-sm text-fg">{r.value}</span>
              <CopyButton
                size="sm"
                variant="ghost"
                value={r.value}
                className="opacity-0 transition-opacity group-hover:opacity-100"
              />
            </div>
          ))}
        </div>
      )}

      {info && date && (
        <div className="mt-4 overflow-hidden rounded-lg border border-line bg-surface">
          <div className="border-b border-line bg-bg2 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-fg2">
            {t(`${k}.timeZones`)}
          </div>
          {COMMON_TIMEZONES.map((tz) => {
            const value = formatInZone(date, tz, locale);
            return (
              <div
                key={tz}
                className="group flex items-center gap-3 border-b border-line/60 px-3 py-1.5 text-sm last:border-0"
              >
                <span className="w-44 shrink-0 text-xs text-fg3">{tz}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-fg">{value}</span>
                <CopyButton
                  size="sm"
                  variant="ghost"
                  value={value}
                  className="opacity-0 transition-opacity group-hover:opacity-100"
                />
              </div>
            );
          })}
        </div>
      )}

      {!input && <p className="text-sm text-fg3">{rich(`${k}.help`)}</p>}
    </div>
  );
}
