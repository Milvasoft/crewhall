// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/chronometer/component.tsx. See THIRD_PARTY.md.
import { useEffect, useRef, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { Button } from '@/features/tools/components/ui/Button';
import { useI18n } from '@/lib/i18n/I18nContext';
import { formatStopwatch } from './logic';

export default function ChronometerTool(_: ToolComponentProps) {
  void _;
  const { t } = useI18n();
  const [elapsed, setElapsed] = useState(0);
  const [running, setRunning] = useState(false);
  const [laps, setLaps] = useState<number[]>([]);
  const startRef = useRef(0);
  const baseRef = useRef(0);

  useEffect(() => {
    if (!running) return;
    let raf = 0;
    const tick = () => {
      setElapsed(baseRef.current + (performance.now() - startRef.current));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [running]);

  const startStop = () => {
    if (running) {
      baseRef.current = elapsed;
      setRunning(false);
    } else {
      startRef.current = performance.now();
      setRunning(true);
    }
  };

  const reset = () => {
    setRunning(false);
    setElapsed(0);
    baseRef.current = 0;
    setLaps([]);
  };

  return (
    <div className="max-w-md space-y-5">
      <div className="rounded-lg border border-line bg-surface py-8 text-center">
        <span className="font-mono text-5xl font-semibold tabular-nums text-fg">
          {formatStopwatch(elapsed)}
        </span>
      </div>

      <div className="flex justify-center gap-2">
        <Button variant="primary" onClick={startStop}>
          {running ? t('tools.items.chronometer.stop') : t('tools.items.chronometer.start')}
        </Button>
        <Button
          variant="secondary"
          onClick={() => setLaps((l) => [elapsed, ...l])}
          disabled={!running}
        >
          {t('tools.items.chronometer.lap')}
        </Button>
        <Button variant="secondary" onClick={reset}>
          {t('tools.common.reset')}
        </Button>
      </div>

      {laps.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          {laps.map((l, i) => (
            <div
              key={i}
              className="flex items-center justify-between border-b border-line/60 px-3 py-2 last:border-0 font-mono text-sm"
            >
              <span className="text-fg3">
                {t('tools.items.chronometer.lapN', { n: laps.length - i })}
              </span>
              <span className="text-fg">{formatStopwatch(l)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
