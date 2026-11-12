// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/datetime-playground/component.tsx. See THIRD_PARTY.md.
import { DatePicker, TimePicker } from '@crewhall/ui';
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { useI18n } from '@/lib/i18n/I18nContext';
import {
  applyOffset,
  dayOfYear,
  daysInMonth,
  diff,
  isLeapYear,
  isoWeek,
  quarter,
  type Offset,
} from './logic';

const ZERO: Offset = { years: 0, months: 0, days: 0, hours: 0, minutes: 0, seconds: 0 };
const UNITS = ['years', 'months', 'days', 'hours', 'minutes', 'seconds'] as const;

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Crewhall: the shared date and time pickers (doc 02 · 9.4) instead of a native
 * `datetime-local` input; the value keeps its "yyyy-MM-ddTHH:mm" form.
 */
function DateTimeField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [day = '', time = '00:00'] = value.split('T');
  return (
    <div className="flex flex-col gap-1 text-xs text-fg2">
      <span>{label}</span>
      <div className="flex gap-2">
        <DatePicker
          aria-label={label}
          value={day || null}
          clearable={false}
          onChange={(d) => d && onChange(`${d}T${time}`)}
        />
        <TimePicker
          aria-label={label}
          value={time}
          minuteStep={1}
          onChange={(tm) => tm && onChange(`${day}T${tm}`)}
        />
      </div>
    </div>
  );
}

export default function DateTimePlaygroundTool(_props: ToolComponentProps) {
  const { t, locale } = useI18n();
  const [base, setBase] = useState(() => toLocalInput(new Date()));
  const [offset, setOffset] = useState<Offset>(ZERO);
  const [other, setOther] = useState(() => toLocalInput(new Date()));

  const baseDate = useMemo(() => new Date(base), [base]);
  const result = useMemo(
    () => (isNaN(baseDate.getTime()) ? null : applyOffset(baseDate, offset)),
    [baseDate, offset],
  );
  const otherDate = useMemo(() => new Date(other), [other]);
  const d = useMemo(
    () => (result && !isNaN(otherDate.getTime()) ? diff(result, otherDate) : null),
    [result, otherDate],
  );

  const setOff = (k: keyof Offset, v: number) => setOffset((o) => ({ ...o, [k]: v }));

  const k = 'tools.items.datetime-playground';
  const info: [string, string][] = result
    ? [
        ['ISO 8601', result.toISOString()],
        [t(`${k}.info.local`), result.toString()],
        [t(`${k}.info.unixSeconds`), String(Math.floor(result.getTime() / 1000))],
        [t(`${k}.info.dayOfWeek`), result.toLocaleDateString(locale, { weekday: 'long' })],
        [t(`${k}.info.dayOfYear`), String(dayOfYear(result))],
        [t(`${k}.info.isoWeek`), String(isoWeek(result))],
        [t(`${k}.info.quarter`), t(`${k}.info.quarterValue`, { n: quarter(result) })],
        [t(`${k}.info.daysInMonth`), String(daysInMonth(result.getFullYear(), result.getMonth()))],
        [
          t(`${k}.info.leapYear`),
          isLeapYear(result.getFullYear()) ? t(`${k}.info.yes`) : t(`${k}.info.no`),
        ],
      ]
    : [];

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
      <div className="flex flex-col gap-4 self-start">
        <DateTimeField label={t(`${k}.base`)} value={base} onChange={setBase} />

        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-fg3">
            {t(`${k}.addSubtract`)}
          </div>
          <div className="grid grid-cols-3 gap-2">
            {UNITS.map((u) => (
              <label key={u} className="text-[11px] text-fg2">
                {t(`${k}.units.${u}`)}
                <input
                  type="number"
                  value={offset[u]}
                  onChange={(e) => setOff(u, Number(e.target.value) || 0)}
                  className="mt-0.5 h-8 w-full rounded-md border border-line bg-surface px-2 text-sm outline-none"
                />
              </label>
            ))}
          </div>
        </div>

        <DateTimeField label={t(`${k}.compareWith`)} value={other} onChange={setOther} />
      </div>

      <div className="flex flex-col gap-4 self-start">
        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          <div className="border-b border-line bg-bg2 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-fg2">
            {t('tools.common.result')} {offset !== ZERO ? t(`${k}.withOffset`) : ''}
          </div>
          {info.length ? (
            info.map(([label, v]) => (
              <div
                key={label}
                className="flex items-center gap-3 border-b border-line/50 px-3 py-1.5 text-sm last:border-0"
              >
                <span className="w-32 shrink-0 text-xs text-fg3">{label}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-fg">{v}</span>
              </div>
            ))
          ) : (
            <div className="px-3 py-3 text-sm text-danger">{t(`${k}.invalidBase`)}</div>
          )}
        </div>

        {d && (
          <div className="overflow-hidden rounded-lg border border-line bg-surface">
            <div className="border-b border-line bg-bg2 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-fg2">
              {t(`${k}.difference`)}
            </div>
            {(['days', 'hours', 'minutes', 'seconds'] as const).map((u) => (
              <div
                key={u}
                className="flex items-center gap-3 border-b border-line/50 px-3 py-1.5 text-sm last:border-0"
              >
                <span className="w-32 shrink-0 text-xs text-fg3">{t(`${k}.units.${u}`)}</span>
                <span className="font-mono text-fg">
                  {d[u].toLocaleString(locale, { maximumFractionDigits: 2 })}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
