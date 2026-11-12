import { type SprintBurndown } from '@crewhall/shared';
import { cn } from '@crewhall/ui';
import { useState } from 'react';
import { formatDate } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';

const W = 320;
const H = 120;
const PAD = { l: 28, r: 8, t: 8, b: 18 };

/**
 * Sprint burndown (kararlar 2026-10-29): remaining work per day against the ideal line from
 * the starting scope to zero. A crosshair snaps to the day under the pointer (or the focused
 * day with the arrow keys) and reads out both values; the numbers are in the table too.
 */
export function Burndown({ data, className }: { data: SprintBurndown; className?: string }) {
  const { t, locale } = useI18n();
  const [at, setAt] = useState<number | null>(null);
  const n = data.days.length;
  const max = Math.max(1, ...data.days.map((d) => Math.max(d.scope, d.ideal, d.remaining ?? 0)));
  const x = (i: number) => PAD.l + (n <= 1 ? 0 : (i / (n - 1)) * (W - PAD.l - PAD.r));
  const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
  const path = (vals: (number | null)[]) =>
    vals
      .map((v, i) => (v === null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`))
      .filter((p): p is string => p !== null)
      .map((p, i) => `${i ? 'L' : 'M'}${p}`)
      .join('');
  const unit = (v: number) => t(`boards.sprints.units.${data.unit}`, { count: v });
  const day = at !== null ? data.days[at] : undefined;
  const short = (d: string) => formatDate(d, locale, { day: 'numeric', month: 'short' });

  const pick = (clientX: number, rect: DOMRect) => {
    const px = ((clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - PAD.l) / (W - PAD.l - PAD.r)) * (n - 1));
    setAt(Math.max(0, Math.min(n - 1, i)));
  };

  return (
    <figure className={cn('flex flex-col gap-1.5', className)}>
      <figcaption className="flex items-center gap-3 text-[11.5px] font-semibold text-fg3">
        <span>{t('boards.sprints.burndown')}</span>
        <span className="flex items-center gap-1">
          <span className="h-0.5 w-3 rounded-full bg-accent" aria-hidden />
          {t('boards.sprints.remaining')}
        </span>
        <span className="flex items-center gap-1">
          <span className="h-0 w-3 border-t border-dashed border-fg3" aria-hidden />
          {t('boards.sprints.ideal')}
        </span>
      </figcaption>
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full touch-none overflow-visible outline-none focus-visible:ring-2 focus-visible:ring-accent"
          role="img"
          tabIndex={0}
          aria-label={t('boards.sprints.burndownLabel', {
            done: unit(data.done),
            total: unit(data.total),
          })}
          onPointerMove={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())}
          onPointerLeave={() => setAt(null)}
          onBlur={() => setAt(null)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') setAt((i) => Math.min(n - 1, (i ?? -1) + 1));
            else if (e.key === 'ArrowLeft') setAt((i) => Math.max(0, (i ?? n) - 1));
            else return;
            e.preventDefault();
          }}
        >
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line
                x1={PAD.l}
                x2={W - PAD.r}
                y1={y(max * f)}
                y2={y(max * f)}
                className="stroke-line"
                strokeWidth={1}
              />
              <text
                x={PAD.l - 6}
                y={y(max * f) + 3}
                textAnchor="end"
                className="fill-fg3 text-[9px] tn"
              >
                {Math.round(max * f)}
              </text>
            </g>
          ))}
          {n ? (
            <>
              <text x={x(0)} y={H - 4} className="fill-fg3 text-[9px]">
                {short(data.days[0]!.date)}
              </text>
              <text x={x(n - 1)} y={H - 4} textAnchor="end" className="fill-fg3 text-[9px]">
                {short(data.days[n - 1]!.date)}
              </text>
            </>
          ) : null}
          <path
            d={path(data.days.map((d) => d.ideal))}
            fill="none"
            className="stroke-fg3"
            strokeWidth={1.5}
            strokeDasharray="4 3"
          />
          <path
            d={path(data.days.map((d) => d.remaining))}
            fill="none"
            className="stroke-accent"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {day && at !== null ? (
            <>
              <line
                x1={x(at)}
                x2={x(at)}
                y1={PAD.t}
                y2={H - PAD.b}
                className="stroke-fg3"
                strokeWidth={1}
              />
              {day.remaining !== null ? (
                <circle
                  cx={x(at)}
                  cy={y(day.remaining)}
                  r={4}
                  className="fill-accent stroke-bg"
                  strokeWidth={2}
                />
              ) : null}
            </>
          ) : null}
        </svg>
        {day && at !== null ? (
          <div
            role="status"
            className="pointer-events-none absolute top-0 rounded-md bg-fg px-2 py-1 text-[11.5px] text-bg shadow-overlay"
            style={{
              left: `${(x(at) / W) * 100}%`,
              transform: `translateX(${at > n / 2 ? '-105%' : '5%'})`,
            }}
          >
            <div className="font-semibold">{short(day.date)}</div>
            <div className="flex items-center gap-1.5">
              <span className="h-0.5 w-2.5 rounded-full bg-accent" aria-hidden />
              <span className="font-bold tn">
                {day.remaining === null ? '—' : unit(day.remaining)}
              </span>
              <span className="opacity-70">{t('boards.sprints.remaining')}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 border-t border-dashed border-bg" aria-hidden />
              <span className="font-bold tn">{unit(day.ideal)}</span>
              <span className="opacity-70">{t('boards.sprints.ideal')}</span>
            </div>
          </div>
        ) : null}
      </div>
      {/* A table keeps its rows' height even when visually hidden; the wrapper does not. */}
      <div className="sr-only">
        <table>
          <caption>{t('boards.sprints.burndown')}</caption>
          <thead>
            <tr>
              <th>{t('boards.sprints.day')}</th>
              <th>{t('boards.sprints.remaining')}</th>
              <th>{t('boards.sprints.ideal')}</th>
            </tr>
          </thead>
          <tbody>
            {data.days.map((d) => (
              <tr key={d.date}>
                <td>{short(d.date)}</td>
                <td>{d.remaining ?? '—'}</td>
                <td>{d.ideal}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
