import {
  cn,
  Icon,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Switch,
} from '@crewhall/ui';
import { useRoomContext } from '@livekit/components-react';
import { RoomEvent, type RemoteParticipant } from 'livekit-client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import {
  applyVolume,
  clampVolume,
  isNormal,
  NORMAL_VOLUME,
  readVolumes,
  VOLUME,
  writeVolumes,
  type VolumeMap,
  type VolumeSetting,
} from '@/lib/meet/volume';
import { useMe } from '@/lib/session';
import { useRoomState } from './context';

interface VolumeState {
  get: (identity: string) => VolumeSetting;
  set: (identity: string, change: Partial<VolumeSetting>) => void;
}

const VolumeCtx = createContext<VolumeState | null>(null);

/** Per-person volume for me only (lib/meet/volume.ts), kept for this meeting. */
export function VolumeProvider({ children }: { children: ReactNode }) {
  const room = useRoomContext();
  const state = useRoomState();
  const meId = useMe()?.user.id ?? 'guest';
  const meetingId = state.meeting?.id ?? room.name;
  const [volumes, setVolumes] = useState<VolumeMap>(() => readVolumes(meId, meetingId));

  // Everyone in the room, and whoever (or whatever track) arrives later, gets their setting.
  useEffect(() => {
    const apply = (p: RemoteParticipant) => {
      const v = volumes[p.identity];
      if (v) applyVolume(p, v);
    };
    room.remoteParticipants.forEach(apply);
    const onTrack = (_t: unknown, _p: unknown, p: RemoteParticipant) => apply(p);
    room.on(RoomEvent.ParticipantConnected, apply);
    room.on(RoomEvent.TrackSubscribed, onTrack);
    return () => {
      room.off(RoomEvent.ParticipantConnected, apply);
      room.off(RoomEvent.TrackSubscribed, onTrack);
    };
  }, [room, volumes]);

  const set = useCallback(
    (identity: string, change: Partial<VolumeSetting>) => {
      setVolumes((cur) => {
        const prev = cur[identity] ?? NORMAL_VOLUME;
        const next: VolumeSetting = {
          level: clampVolume(change.level ?? prev.level),
          muted: change.muted ?? prev.muted,
        };
        const all = { ...cur, [identity]: next };
        writeVolumes(meId, meetingId, all);
        const p = room.remoteParticipants.get(identity);
        if (p) applyVolume(p, next);
        return all;
      });
    },
    [meId, meetingId, room],
  );

  const value = useMemo<VolumeState>(
    () => ({ get: (identity) => volumes[identity] ?? NORMAL_VOLUME, set }),
    [volumes, set],
  );
  return <VolumeCtx.Provider value={value}>{children}</VolumeCtx.Provider>;
}

export function useVolume(identity: string) {
  const ctx = useContext(VolumeCtx);
  if (!ctx) throw new Error('useVolume outside VolumeProvider');
  return { setting: ctx.get(identity), set: (c: Partial<VolumeSetting>) => ctx.set(identity, c) };
}

export function SpeakerOff({ size = 14 }: { size?: number }) {
  return (
    <span className="relative inline-flex" aria-hidden="true">
      <Icon name="speaker" size={size} />
      <span className="absolute top-1/2 left-1/2 h-[1.5px] w-[120%] -translate-x-1/2 -translate-y-1/2 rotate-45 rounded bg-current" />
    </span>
  );
}

/** Slider (0-200 %, 5 % steps, arrows move 5 %) and "Sesi kapat (yalnız benim için)". */
export function VolumeControl({ identity, name }: { identity: string; name: string }) {
  const { t } = useI18n();
  const { setting, set } = useVolume(identity);
  const id = `volume-${identity}`;
  return (
    <div className="flex w-64 max-w-full flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-sm font-semibold">
          {t('meet.volume.title')}
        </label>
        <span className="font-mono text-xs text-fg2">
          {t('meet.volume.percent', { n: setting.level })}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Icon name="speaker" size={16} className="shrink-0 text-fg3" />
        <input
          id={id}
          type="range"
          min={VOLUME.min}
          max={VOLUME.max}
          step={VOLUME.step}
          value={setting.level}
          disabled={setting.muted}
          aria-label={t('meet.volume.of', { name })}
          aria-valuetext={t('meet.volume.valueText', { name, n: setting.level })}
          onChange={(e) => set({ level: Number(e.target.value) })}
          className="h-1.5 min-w-0 flex-1 cursor-pointer accent-accent disabled:cursor-default disabled:opacity-40"
        />
      </div>
      <div className="flex items-center justify-between gap-2 text-xs text-fg3">
        <span>{t('meet.volume.percent', { n: VOLUME.min })}</span>
        <button
          type="button"
          className="font-semibold text-fg2 hover:text-fg disabled:opacity-40"
          disabled={setting.level === VOLUME.normal}
          onClick={() => set({ level: VOLUME.normal })}
        >
          {t('meet.volume.reset')}
        </button>
        <span>{t('meet.volume.percent', { n: VOLUME.max })}</span>
      </div>
      <label className="flex items-center gap-3">
        <span className="flex-1 text-sm">{t('meet.volume.muteForMe')}</span>
        <Switch checked={setting.muted} onCheckedChange={(v) => set({ muted: v })} />
      </label>
    </div>
  );
}

/** On the tile and in the people list when the level is not 100 % or muted for me. */
export function VolumeBadge({ identity, className }: { identity: string; className?: string }) {
  const { t } = useI18n();
  const { setting } = useVolume(identity);
  if (isNormal(setting)) return null;
  return setting.muted ? (
    <span
      className={cn('flex items-center gap-1 text-[11px] font-semibold', className)}
      title={t('meet.volume.mutedForMe')}
    >
      <SpeakerOff size={13} />
      {t('meet.volume.mutedForMe')}
    </span>
  ) : (
    <span
      className={cn('flex items-center gap-1 font-mono text-[11px]', className)}
      title={t('meet.volume.title')}
    >
      <Icon name="speaker" size={13} />
      {t('meet.volume.percent', { n: setting.level })}
    </span>
  );
}

/** The speaker button that opens the control (tile corner, people list). */
export function VolumeButton({
  identity,
  name,
  className,
  tone = 'plain',
}: {
  identity: string;
  name: string;
  className?: string;
  tone?: 'plain' | 'dark';
}) {
  const { t } = useI18n();
  const { setting } = useVolume(identity);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <IconButton
          size="xs"
          tone="plain"
          aria-label={t('meet.volume.open', { name })}
          className={cn(tone === 'dark' && 'bg-black/55 text-white hover:bg-black/70', className)}
        >
          {setting.muted ? <SpeakerOff size={14} /> : <Icon name="speaker" size={14} />}
        </IconButton>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-auto p-4">
        <VolumeControl identity={identity} name={name} />
      </PopoverContent>
    </Popover>
  );
}
