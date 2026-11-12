import { type TrackReferenceOrPlaceholder } from '@livekit/components-react';
import { act, renderHook } from '@testing-library/react';
import { Track } from 'livekit-client';
import { describe, expect, it } from 'vitest';
import { pickMain, pinKey, PinProvider, tileKey, usePin } from '@/components/meet/room/pin';

const tile = (identity: string, source = Track.Source.Camera, spoke = 0) =>
  ({
    participant: { identity, lastSpokeAt: spoke ? new Date(spoke) : undefined },
    source,
  }) as unknown as TrackReferenceOrPlaceholder;

describe('pinning someone', () => {
  const elif = tile('elif', Track.Source.Camera, 100);
  const mert = tile('mert', Track.Source.Camera, 300);
  const screen = tile('can', Track.Source.ScreenShare);

  it('fills the stage with who I pinned, over a shared screen and the last speaker', () => {
    expect(pickMain([screen, elif, mert], pinKey('elif'))).toEqual({
      main: elif,
      strip: [screen, mert],
    });
  });

  it("pins a shared screen apart from the same person's camera", () => {
    const can = tile('can');
    const key = tileKey(screen);
    expect(pickMain([screen, can, elif], key).main).toBe(screen);
    expect(pickMain([screen, can, elif], pinKey('can')).main).toBe(can);
  });

  it('goes back to the screen, then the last speaker, when nothing is pinned or they left', () => {
    expect(pickMain([screen, elif, mert], null).main).toBe(screen);
    expect(pickMain([elif, mert], null).main).toBe(mert);
    expect(pickMain([elif, mert], pinKey('gone')).main).toBe(mert);
    expect(pickMain([], null).main).toBeUndefined();
  });

  it('toggles: pinning the same one again unpins, another one replaces it', () => {
    const { result } = renderHook(() => usePin(), { wrapper: PinProvider });
    act(() => result.current.toggle('a'));
    expect(result.current.pinned).toBe('a');
    act(() => result.current.toggle('b'));
    expect(result.current.pinned).toBe('b');
    act(() => result.current.toggle('b'));
    expect(result.current.pinned).toBeNull();
  });
});
