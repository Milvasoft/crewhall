import { describe, expect, it } from 'vitest';
import {
  isBlocked,
  mediaNeeds,
  type HealthInput,
  type IceState,
} from '@/components/meet/room/mediaHealth';

const NOW = 100_000;

/** A room state: what is on, how ICE is, and for how long (seconds) it has not been up. */
function health(
  needs: { pub?: boolean; sub?: boolean },
  ice: IceState,
  badFor: number | null,
  reconnects = 0,
): HealthInput {
  const since = badFor === null ? null : NOW - badFor * 1000;
  return {
    needPublisher: needs.pub ?? false,
    needSubscriber: needs.sub ?? false,
    ice: { publisher: ice, subscriber: ice },
    badSince: { publisher: needs.pub ? since : null, subscriber: needs.sub ? since : null },
    reconnects,
    now: NOW,
  };
}

const pub = (on: boolean) => ({ track: {}, isMuted: !on });
const fakeRoom = (mine: boolean[], theirs: boolean[][]) =>
  ({
    localParticipant: { trackPublications: new Map(mine.map((on, i) => [`l${i}`, pub(on)])) },
    remoteParticipants: new Map(
      theirs.map((tracks, i) => [
        `r${i}`,
        { trackPublications: new Map(tracks.map((on, j) => [`r${i}${j}`, pub(on)])) },
      ]),
    ),
  }) as never;

describe('media health: no false alarms', () => {
  it('a camera or microphone turned off is not expected media', () => {
    // Camera off, mic off, both off; alone or with others whose tracks are off.
    expect(mediaNeeds(fakeRoom([false, true], []))).toEqual({
      needPublisher: true,
      needSubscriber: false,
    });
    expect(mediaNeeds(fakeRoom([false, false], [[false]]))).toEqual({
      needPublisher: false,
      needSubscriber: false,
    });
    expect(mediaNeeds(fakeRoom([], [[false, true]]))).toEqual({
      needPublisher: false,
      needSubscriber: true,
    });
  });

  it('never warns when nothing is sent or received (alone, or everything off)', () => {
    expect(isBlocked(health({}, 'new', 120))).toBe(false);
    expect(isBlocked(health({}, 'failed', 120))).toBe(false);
    expect(isBlocked(health({}, 'checking', 120, 5))).toBe(false);
  });

  it('a path that went down warns after 5 s, not before', () => {
    expect(isBlocked(health({ pub: true }, 'disconnected', 3))).toBe(false);
    expect(isBlocked(health({ pub: true }, 'disconnected', 6))).toBe(true);
    expect(isBlocked(health({ sub: true }, 'failed', 6))).toBe(true);
  });

  it('a path that never comes up warns after 15 s (firewall, H9)', () => {
    expect(isBlocked(health({ pub: true }, 'checking', 10))).toBe(false);
    expect(isBlocked(health({ pub: true }, 'checking', 16))).toBe(true);
  });

  it('a working path is fine whatever else is on or off', () => {
    expect(isBlocked(health({ pub: true, sub: true }, 'connected', null))).toBe(false);
    expect(isBlocked(health({ sub: true }, 'completed', null, 3))).toBe(false);
  });

  it('reconnecting in a loop warns only while media is expected', () => {
    expect(isBlocked(health({ pub: true }, 'checking', 1, 2))).toBe(true);
    expect(isBlocked(health({}, 'checking', 1, 2))).toBe(false);
  });
});
