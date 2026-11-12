import { Button, Dialog, DialogContent, DialogHeader, Icon, toast } from '@crewhall/ui';
import { useRoomContext } from '@livekit/components-react';
import { Track } from 'livekit-client';
import { useEffect, useRef, useState } from 'react';
import { formatNumber } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { mediaHistory } from '@/lib/meet/mediaWatch';
import {
  collectStats,
  diagnose,
  isDetour,
  pathFrom,
  type MediaPath,
  type StatsMemory,
  type TrackStats,
} from '@/lib/meet/stats';

/** Sampling while the panel is open; getStats is cheap but not free. */
const EVERY_MS = 2000;

/** "Bağlantı ayrıntıları": per track codec, resolution, fps, bitrate, loss, RTT, jitter, limit. */
export function ConnectionDetails({ onOpenChange }: { onOpenChange: (o: boolean) => void }) {
  const { t, locale } = useI18n();
  const room = useRoomContext();
  const memory = useRef<StatsMemory>(new Map());
  const [stats, setStats] = useState<TrackStats[] | null>(null);

  useEffect(() => {
    let alive = true;
    const sample = () =>
      void collectStats(room, memory.current).then((s) => {
        if (alive) setStats(s);
      });
    sample();
    const id = window.setInterval(sample, EVERY_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [room]);

  const verdict = stats ? diagnose(stats) : 'unknown';
  const path = stats ? pathFrom(stats) : null;
  const dash = '—';
  const kbps = (b: number | null) =>
    b === null ? dash : t('meet.stats.kbps', { n: formatNumber(Math.round(b / 1000), locale) });
  const pathText = (p: MediaPath) => {
    const kind =
      p.local === 'host' || p.local === 'srflx' || p.local === 'prflx' || p.local === 'relay'
        ? t(`meet.stats.paths.${p.local}`)
        : t('meet.stats.paths.unknown');
    const relay =
      p.local === 'relay' && p.relayProtocol ? ` (${p.relayProtocol.toUpperCase()})` : '';
    return [
      `${(p.protocol ?? '?').toUpperCase()} · ${kind}${relay}`,
      p.rttMs === null ? null : t('meet.stats.pathRtt', { n: p.rttMs }),
      p.outBitrate === null ? null : t('meet.stats.pathOut', { n: kbps(p.outBitrate) }),
    ]
      .filter(Boolean)
      .join(' · ');
  };
  const buffer = (s: TrackStats) => {
    const v = s.direction === 'receive' ? s.jitterBufferMs : s.sendDelayMs;
    return v === null ? dash : t('meet.stats.ms', { n: v });
  };
  const source = (s: TrackStats) =>
    t(
      s.source === Track.Source.ScreenShare || s.source === Track.Source.ScreenShareAudio
        ? 'meet.stats.screen'
        : s.kind === 'video'
          ? 'meet.stats.camera'
          : 'meet.stats.microphone',
    );

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent width={760}>
        <DialogHeader title={t('meet.stats.title')} description={t('meet.stats.hint')} />
        <p role="status" className="flex items-center gap-2 text-sm font-semibold">
          <Icon
            name={verdict === 'ok' ? 'checkC' : verdict === 'unknown' ? 'info' : 'alert'}
            size={16}
            className={
              verdict === 'ok' ? 'text-success' : verdict === 'unknown' ? '' : 'text-warning'
            }
          />
          {t(`meet.stats.verdict.${verdict}`)}
        </p>
        {path ? (
          <p className="text-xs text-fg2">
            {t('meet.stats.path', { path: pathText(path) })}
            {isDetour(path) ? (
              <span className="ml-1 text-warning">· {t('meet.stats.paths.detour')}</span>
            ) : null}
          </p>
        ) : null}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs whitespace-nowrap">
            <thead className="text-fg3">
              <tr className="[&>th]:px-2 [&>th]:py-1.5 [&>th]:font-semibold">
                <th>{t('meet.stats.track')}</th>
                <th>{t('meet.stats.codec')}</th>
                <th>{t('meet.stats.resolution')}</th>
                <th>{t('meet.stats.fps')}</th>
                <th>{t('meet.stats.bitrate')}</th>
                <th>{t('meet.stats.loss')}</th>
                <th>{t('meet.stats.rtt')}</th>
                <th>{t('meet.stats.jitter')}</th>
                <th title={t('meet.stats.bufferHint')}>{t('meet.stats.buffer')}</th>
                <th>{t('meet.stats.limit')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line font-mono">
              {(stats ?? []).map((s) => (
                <tr key={s.key} className="[&>td]:px-2 [&>td]:py-1.5">
                  <td className="font-sans">
                    <span className="font-semibold">
                      {s.direction === 'send' ? t('meet.stats.sending') : s.participant}
                    </span>{' '}
                    · {source(s)}
                  </td>
                  <td>{s.codec ?? dash}</td>
                  <td>{s.width && s.height ? `${s.width}×${s.height}` : dash}</td>
                  <td>{s.fps ?? dash}</td>
                  <td>{kbps(s.bitrate)}</td>
                  <td>{s.lossPercent === null ? dash : `${s.lossPercent}%`}</td>
                  <td>{s.rttMs === null ? dash : t('meet.stats.ms', { n: s.rttMs })}</td>
                  <td>{s.jitterMs === null ? dash : t('meet.stats.ms', { n: s.jitterMs })}</td>
                  <td>{buffer(s)}</td>
                  <td className={s.limit && s.limit !== 'none' ? 'text-warning' : ''}>
                    {s.limit ? t(`meet.stats.limits.${s.limit}`) : dash}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {stats && !stats.length ? (
            <p className="py-3 text-sm text-fg3">{t('meet.stats.empty')}</p>
          ) : null}
        </div>
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="out"
            disabled={!stats?.length}
            onClick={() =>
              void navigator.clipboard
                .writeText(
                  JSON.stringify(
                    {
                      at: new Date().toISOString(),
                      verdict,
                      path,
                      stats,
                      // The last ten minutes of audio samples (lib/meet/mediaWatch).
                      history: mediaHistory(room),
                    },
                    null,
                    2,
                  ),
                )
                .then(() => toast(t('meet.stats.copied')))
            }
          >
            <Icon name="copy" size={14} />
            {t('meet.stats.copy')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
