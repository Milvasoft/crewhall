import { type TrackReferenceOrPlaceholder } from '@livekit/components-react';
import { Track } from 'livekit-client';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

/**
 * Pinning: one person (or one screen) fills the stage for me, until I unpin or they leave. Only
 * this viewer's choice; nobody else's stage changes. A context of its own, so that the stage and
 * its tiles do not re-render with the rest of the room state (reactions, panels, ...).
 */
interface PinState {
  pinned: string | null;
  setPinned: (key: string | null) => void;
  /** Pins the key, or unpins it if it already is. */
  toggle: (key: string) => void;
}

const PinCtx = createContext<PinState>({
  pinned: null,
  setPinned: () => undefined,
  toggle: () => undefined,
});

export const usePin = () => useContext(PinCtx);

export function PinProvider({ children }: { children: ReactNode }) {
  const [pinned, setPinned] = useState<string | null>(null);
  const toggle = useCallback((key: string) => setPinned((cur) => (cur === key ? null : key)), []);
  const value = useMemo(() => ({ pinned, setPinned, toggle }), [pinned, toggle]);
  return <PinCtx.Provider value={value}>{children}</PinCtx.Provider>;
}

export const pinKey = (identity: string, source: Track.Source = Track.Source.Camera) =>
  `${identity}:${source}`;

export const tileKey = (t: TrackReferenceOrPlaceholder) => pinKey(t.participant.identity, t.source);

/**
 * What fills the stage in the speaker layout: my pin if that tile still exists, then a shared
 * screen, then whoever spoke last. Everything else goes to the strip.
 */
export function pickMain(
  tracks: TrackReferenceOrPlaceholder[],
  pinned: string | null,
): { main: TrackReferenceOrPlaceholder | undefined; strip: TrackReferenceOrPlaceholder[] } {
  const spokeAt = (t: TrackReferenceOrPlaceholder) => t.participant.lastSpokeAt?.getTime() ?? 0;
  const main =
    tracks.find((t) => pinned !== null && tileKey(t) === pinned) ??
    tracks.find((t) => t.source === Track.Source.ScreenShare) ??
    [...tracks].sort((a, b) => spokeAt(b) - spokeAt(a))[0];
  return { main, strip: tracks.filter((t) => t !== main) };
}
