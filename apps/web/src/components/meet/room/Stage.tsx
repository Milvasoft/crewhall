import { Avatar, cn, Icon, IconButton, NARROW_QUERY, useMediaQuery } from '@crewhall/ui';
import {
  isTrackReference,
  useConnectionQualityIndicator,
  useIsMuted,
  useIsSpeaking,
  useParticipantAttributes,
  useParticipantInfo,
  useTracks,
  VideoTrack,
  type TrackReferenceOrPlaceholder,
} from '@livekit/components-react';
import { ConnectionQuality, RoomEvent, Track, type Participant } from 'livekit-client';
import { memo, useMemo, useRef, useState } from 'react';
import { MEET_LIMITS } from '@crewhall/shared';
import { useI18n } from '@/lib/i18n/I18nContext';
import { MicOff } from '@/components/meet/bits';
import { handOf, parseMeta, useRoomState } from './context';
import { pickMain, tileKey, usePin } from './pin';
import { ScreenControl } from './RemoteControl';
import { useHands } from './roomHooks';
import { useTileMotion } from './tileMotion';
import { VolumeBadge, VolumeButton } from './Volume';

export type Layout = 'grid' | 'speaker';

/** Grid columns for n tiles: 3×2 up to 6, 4×3 up to 12 (design 7.4); phones stack two. */
function columns(n: number, narrow = false) {
  if (n <= 1 || (narrow && n <= 2)) return 1;
  if (narrow) return 2;
  if (n <= 4) return 2;
  if (n <= 9) return 3;
  return 4;
}

/** Raised hands in order, for "1. sırada" (design 7.6, 7.8). */
export function useHandQueue(participants: Participant[]) {
  return participants
    .filter((p) => handOf(p))
    .sort((a, b) => handOf(a).localeCompare(handOf(b)))
    .map((p) => p.identity);
}

/** The events that change which tiles exist (not speaking or quality: tiles follow those). */
const TILE_EVENTS = [
  RoomEvent.ParticipantConnected,
  RoomEvent.ParticipantDisconnected,
  RoomEvent.TrackPublished,
  RoomEvent.TrackUnpublished,
  RoomEvent.TrackSubscribed,
  RoomEvent.TrackUnsubscribed,
  RoomEvent.LocalTrackPublished,
  RoomEvent.LocalTrackUnpublished,
  RoomEvent.TrackMuted,
  RoomEvent.TrackUnmuted,
  RoomEvent.TrackSubscriptionStatusChanged,
];
/** The speaker layout also follows who spoke last. */
const SPEAKER_EVENTS = [...TILE_EVENTS, RoomEvent.ActiveSpeakersChanged];
const TILE_SOURCES = [
  { source: Track.Source.Camera, withPlaceholder: true },
  { source: Track.Source.ScreenShare, withPlaceholder: false },
];

export const Stage = memo(function Stage({ layout }: { layout: Layout }) {
  const { t } = useI18n();
  const tracks = useTracks(TILE_SOURCES, {
    onlySubscribed: false,
    updateOnlyOn: layout === 'speaker' ? SPEAKER_EVENTS : TILE_EVENTS,
  });
  const screens = tracks.filter(
    (tr) => tr.source === Track.Source.ScreenShare && isTrackReference(tr),
  );
  const cameras = tracks.filter((tr) => tr.source === Track.Source.Camera);
  const hands = useHands();
  const [page, setPage] = useState(0);
  const narrow = useMediaQuery(NARROW_QUERY);
  const pageSize = MEET_LIMITS.gridPageSize;
  const grid = useRef<HTMLDivElement>(null);
  const ghosts = useRef<HTMLDivElement>(null);
  useTileMotion(grid, ghosts);
  const { pinned } = usePin();

  // Design 7.5: a screen share switches to the speaker layout, and so does a pin of mine.
  const pinnedHere = pinned !== null && [...screens, ...cameras].some((c) => tileKey(c) === pinned);
  const effective: Layout = screens.length || pinnedHere ? 'speaker' : layout;

  if (effective === 'speaker') {
    const { main, strip } = pickMain([...screens, ...cameras], pinned);
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2 sm:flex-row sm:gap-3">
        <div className="min-h-0 min-w-0 flex-1">
          {main ? (
            <Tile
              trackRef={main}
              handPos={hands.indexOf(main.participant.identity)}
              pinned={tileKey(main) === pinned}
              large
            />
          ) : null}
        </div>
        {strip.length ? (
          <div className="flex shrink-0 gap-2 overflow-x-auto sm:w-[220px] sm:flex-col sm:gap-3 sm:overflow-x-visible sm:overflow-y-auto">
            {strip.map((c) => (
              <div key={tileKey(c)} className="aspect-video w-[132px] shrink-0 sm:w-auto">
                <Tile trackRef={c} handPos={hands.indexOf(c.participant.identity)} />
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  const pages = Math.max(1, Math.ceil(cameras.length / pageSize));
  const current = Math.min(page, pages - 1);
  const visible = cameras.slice(current * pageSize, current * pageSize + pageSize);
  const cols = columns(visible.length, narrow);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={grid}
        className="grid min-h-0 flex-1 gap-2 sm:gap-3"
        style={{
          gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          gridAutoRows: `minmax(0, 1fr)`,
        }}
      >
        {visible.map((c) => (
          <Tile
            key={c.participant.identity}
            trackRef={c}
            handPos={hands.indexOf(c.participant.identity)}
          />
        ))}
      </div>
      <div ref={ghosts} aria-hidden="true" className="pointer-events-none absolute inset-0" />
      {pages > 1 ? (
        <div className="absolute top-1/2 right-1 left-1 flex -translate-y-1/2 justify-between">
          <IconButton
            aria-label={t('meet.room.prevPage')}
            disabled={current === 0}
            onClick={() => setPage(current - 1)}
            className="bg-black/50 text-white"
          >
            <Icon name="arrow" size={18} className="rotate-180" />
          </IconButton>
          <IconButton
            aria-label={t('meet.room.nextPage')}
            disabled={current >= pages - 1}
            onClick={() => setPage(current + 1)}
            className="bg-black/50 text-white"
          >
            <Icon name="arrow" size={18} />
          </IconButton>
        </div>
      ) : null}
    </div>
  );
});

const TILE_ACTION = 'size-8 rounded-lg bg-black/55 text-white hover:bg-black/70';
const TILE_ACTION_HOVER =
  'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(pointer:coarse)]:opacity-100';

/** Neutral tile backgrounds per person (design 07: video surfaces stay neutral). */
const TINTS = ['#2b2522', '#262a30', '#232a26', '#2b2530', '#2a2826', '#22282c'];
const tint = (id: string) => TINTS[[...id].reduce((s, c) => s + c.charCodeAt(0), 0) % TINTS.length];

/** Same participant, source and publication: the tile's own hooks follow everything else. */
const sameTile = (a: TileProps, b: TileProps) =>
  a.trackRef.participant === b.trackRef.participant &&
  a.trackRef.source === b.trackRef.source &&
  a.trackRef.publication === b.trackRef.publication &&
  a.handPos === b.handPos &&
  a.pinned === b.pinned &&
  a.large === b.large;

interface TileProps {
  trackRef: TrackReferenceOrPlaceholder;
  /** Place in the raised-hands queue, -1 when the hand is down. */
  handPos: number;
  /** Pinned by me: it fills the stage. */
  pinned?: boolean;
  large?: boolean;
}

export const Tile = memo(function Tile({ trackRef, handPos, pinned, large }: TileProps) {
  const { t } = useI18n();
  const { reactions } = useRoomState();
  const { toggle } = usePin();
  const tile = useRef<HTMLDivElement>(null);
  const p = trackRef.participant;
  const info = useParticipantInfo({ participant: p });
  const name = info.name || p.name || '';
  useParticipantAttributes({ participant: p });
  const speaking = useIsSpeaking(p);
  const micMuted = useIsMuted({ participant: p, source: Track.Source.Microphone });
  const camMuted = useIsMuted(trackRef);
  const { quality } = useConnectionQualityIndicator({ participant: p });
  const meta = parseMeta(p);
  const isScreen = trackRef.source === Track.Source.ScreenShare;
  const hasVideo = isTrackReference(trackRef) && !camMuted;
  const label = p.isLocal
    ? t('meet.room.you', { name: (name ?? '').split(' ')[0] ?? '' })
    : (name ?? p.identity);
  // Only a video that is on can be paused for a weak link (a camera turned off is not "paused").
  const poor = quality === ConnectionQuality.Poor && !p.isLocal && hasVideo;
  const floating = reactions[p.identity] ?? [];

  const bg = useMemo(() => tint(p.identity), [p.identity]);
  const handUp = handPos >= 0 && !isScreen;
  const pinLabel = t(pinned ? 'meet.room.unpin' : 'meet.room.pin', { name });
  return (
    <div
      ref={tile}
      // Not on a screen: double clicks there may be remote control of it.
      onDoubleClick={isScreen ? undefined : () => toggle(tileKey(trackRef))}
      data-tile={`${p.identity}:${trackRef.source}`}
      className={cn(
        'group relative size-full overflow-hidden rounded-2xl',
        speaking && !isScreen && !handUp && 'ring-2 ring-white/80',
      )}
      style={{ background: bg }}
    >
      {hasVideo ? (
        <VideoTrack
          trackRef={trackRef}
          className={cn(
            'size-full',
            isScreen ? 'object-contain' : 'object-cover',
            p.isLocal && !isScreen && '-scale-x-100',
            poor && 'blur-md',
          )}
        />
      ) : (
        <div className="flex size-full items-center justify-center">
          <Avatar
            name={name || p.identity}
            src={meta?.imageUrl}
            size={large ? 'xl' : 'lg'}
            className="bg-white/10 text-white"
          />
        </div>
      )}
      {isScreen && hasVideo ? <ScreenControl sharer={p} name={name} /> : null}
      {/* On hover, focus, and always on touch screens; a pin in use stays visible. */}
      <span className="absolute top-3 right-3 z-20 flex items-center gap-1">
        {pinned ? (
          <IconButton
            size="sm"
            tone="plain"
            aria-label={t('meet.room.fullscreenTile', { name })}
            className={cn(TILE_ACTION, TILE_ACTION_HOVER)}
            onClick={() =>
              document.fullscreenElement
                ? void document.exitFullscreen()
                : void tile.current?.requestFullscreen()
            }
          >
            <Icon name="frame" size={15} />
          </IconButton>
        ) : null}
        <IconButton
          size="sm"
          tone="plain"
          aria-label={pinLabel}
          aria-pressed={Boolean(pinned)}
          className={cn(TILE_ACTION, pinned ? 'bg-white text-black' : TILE_ACTION_HOVER)}
          onClick={() => toggle(tileKey(trackRef))}
        >
          <Icon name="pin" size={15} />
        </IconButton>
        {!p.isLocal && !isScreen ? (
          // How loud this person is for me.
          <VolumeButton
            identity={p.identity}
            name={name || p.identity}
            tone="dark"
            className={TILE_ACTION_HOVER}
          />
        ) : null}
      </span>
      {poor ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/30 text-center text-white">
          <span className="text-sm font-bold">{t('meet.room.videoPaused')}</span>
          <span className="text-xs text-white/70">
            {t('meet.room.weakFor', { name: (name ?? '').split(' ')[0] ?? '' })}
          </span>
        </div>
      ) : null}
      {handUp ? (
        <>
          {/* A raised hand: a thick accent frame, unlike the thin white ring of the speaker. */}
          <span className="pointer-events-none absolute inset-0 z-10 rounded-2xl border-4 border-accent" />
          <span className="absolute top-3 left-3 z-10 flex h-7 items-center gap-1.5 rounded-full bg-accent px-2.5 text-xs font-bold text-accent-fg">
            <span aria-hidden="true">✋</span>
            {t('meet.room.handPosition', { n: handPos + 1 })}
          </span>
        </>
      ) : null}
      <div className="pointer-events-none absolute right-4 bottom-12 flex flex-col items-end gap-1">
        {floating.map((r) => (
          <span key={r.key} className="animate-[meet-float_3s_ease-out_forwards] text-3xl">
            {r.emoji}
          </span>
        ))}
      </div>
      <span className="absolute bottom-3 left-3 flex h-7 max-w-[80%] items-center gap-1.5 rounded-md bg-black/55 px-2 text-xs font-semibold text-white">
        {micMuted ? (
          <span className="text-danger">
            <MicOff size={13} />
          </span>
        ) : speaking ? (
          <Icon name="activity" size={13} />
        ) : null}
        <span className="truncate">
          {isScreen ? t('meet.room.screenOf', { name: name ?? '' }) : label}
        </span>
        {meta?.guest ? (
          <span className="rounded bg-white/20 px-1 text-[10px]">{t('meet.guest')}</span>
        ) : null}
        {!p.isLocal ? (
          <VolumeBadge identity={p.identity} className="shrink-0 text-white/80" />
        ) : null}
      </span>
    </div>
  );
}, sameTile);
